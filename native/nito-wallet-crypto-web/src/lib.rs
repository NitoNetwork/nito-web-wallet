#[cfg(all(
    not(target_arch = "wasm32"),
    any(
        getrandom_backend,
        getrandom_backend = "custom",
        getrandom_backend = "efi_rng",
        getrandom_backend = "extern_impl",
        getrandom_backend = "linux_getrandom",
        getrandom_backend = "linux_raw",
        getrandom_backend = "rdrand",
        getrandom_backend = "rndr",
        getrandom_backend = "unsupported",
        getrandom_backend = "windows_legacy",
    )
))]
compile_error!(
    "getrandom_backend must not be overridden: the wallet requires the OS CSPRNG backend."
);

use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char},
    ptr,
    str::FromStr,
};

#[cfg(not(target_arch = "wasm32"))]
use std::panic::{AssertUnwindSafe, catch_unwind};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use bip39::{Language, Mnemonic};
use bitcoin::{
    Amount, NetworkKind, PrivateKey, PublicKey, ScriptBuf, TxOut, base58,
    bech32::{Hrp, segwit},
    bip32::{DerivationPath, Xpriv},
    hashes::{Hash, hash160},
    key::TapTweak,
    psbt::Psbt,
    secp256k1::{Keypair, Message, Secp256k1, SecretKey},
    sighash::{EcdsaSighashType, Prevouts, SighashCache, TapSighashType},
};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const NITO_HRP: &str = "nito";
const NITO_P2PKH_PREFIX: u8 = 0x00;
const NITO_P2SH_PREFIX: u8 = 0x05;
const MAX_PBKDF2_ROUNDS: u32 = 2_000_000;
const MIN_RANDOM_BYTES: usize = 16;
const MAX_RANDOM_BYTES: usize = 1024;
const DICE_ENTROPY_BYTES: usize = 32;
const MNEMONIC_12_ENTROPY_BYTES: usize = 16;
const MNEMONIC_24_ENTROPY_BYTES: usize = 32;
const MAX_DERIVATION_INDEX: u32 = 9_999;
const MAX_PSBT_BYTES: usize = 4 * 1024 * 1024;
#[cfg(target_arch = "wasm32")]
const MAX_WASM_BUFFER_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
enum CryptoError {
    #[error("Invalid request: {0}")]
    InvalidRequest(String),
    #[error("Invalid mnemonic")]
    InvalidMnemonic,
    #[error("Invalid private key: {0}")]
    InvalidPrivateKey(String),
    #[error("Script type is not available for this private key")]
    UnsupportedScriptType,
    #[error("Invalid derivation path: {0}")]
    InvalidPath(String),
    #[error("Invalid PSBT: {0}")]
    InvalidPsbt(String),
    #[error("Missing previous output for input {0}")]
    MissingPrevout(usize),
    #[error("Missing signer metadata for input {0}")]
    MissingSigner(usize),
    #[error("Cryptographic operation failed: {0}")]
    Crypto(String),
    #[error("System entropy is unavailable")]
    Entropy,
}

impl CryptoError {
    fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "INVALID_REQUEST",
            Self::InvalidMnemonic => "INVALID_MNEMONIC",
            Self::InvalidPrivateKey(_) => "INVALID_PRIVATE_KEY",
            Self::UnsupportedScriptType => "UNSUPPORTED_SCRIPT_TYPE",
            Self::InvalidPath(_) => "INVALID_DERIVATION_PATH",
            Self::InvalidPsbt(_) => "INVALID_PSBT",
            Self::MissingPrevout(_) => "MISSING_PREVOUT",
            Self::MissingSigner(_) => "MISSING_SIGNER",
            Self::Crypto(_) => "CRYPTO_ERROR",
            Self::Entropy => "ENTROPY_UNAVAILABLE",
        }
    }
}

#[derive(Deserialize)]
struct RandomBytesRequest {
    length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RandomBytesResponse {
    bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateMnemonicRequest {
    additional_entropy_base64: Option<String>,
    word_count: Option<u8>,
}

#[derive(Serialize)]
struct GenerateMnemonicResponse {
    mnemonic: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum PrivateKeyFormat {
    Wif,
    Hex,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InspectPrivateKeyRequest {
    private_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SingleKeyAddressResponse {
    script_type: ScriptType,
    address: String,
    public_key_hex: String,
    public_key_compressed: bool,
    script_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    redeem_script_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_internal_key_hex: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateKeyInfoResponse {
    format: PrivateKeyFormat,
    compressed: bool,
    addresses: Vec<SingleKeyAddressResponse>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ScriptType {
    P2pkh,
    P2shP2wpkh,
    P2wpkh,
    P2tr,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pbkdf2Request {
    password: String,
    salt_base64: String,
    rounds: u32,
    output_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pbkdf2Response {
    key_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeriveAddressesRequest {
    mnemonic: String,
    requests: Vec<DeriveAddressRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeriveAddressRequest {
    path: String,
    script_type: ScriptType,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DerivedAddressResponse {
    path: String,
    script_type: ScriptType,
    address: String,
    public_key_hex: String,
    script_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    redeem_script_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_internal_key_hex: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignPsbtRequest {
    mnemonic: String,
    psbt_base64: String,
    signers: Vec<SignerRequest>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignerRequest {
    txid: String,
    vout: u32,
    path: String,
    script_type: ScriptType,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignPsbtResponse {
    psbt_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignPsbtWithPrivateKeyRequest {
    private_key: String,
    psbt_base64: String,
    signers: Vec<SingleKeySignerRequest>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SingleKeySignerRequest {
    txid: String,
    vout: u32,
    script_type: ScriptType,
    public_key_compressed: bool,
}

#[derive(Clone)]
struct CommonSignerRequest {
    txid: String,
    vout: u32,
    path: Option<String>,
    script_type: ScriptType,
    public_key_compressed: bool,
}

struct ParsedPrivateKey {
    secret_key: SecretKey,
    compressed: bool,
    format: PrivateKeyFormat,
}

struct AddressMaterial {
    address: String,
    public_key: PublicKey,
    script: ScriptBuf,
    redeem_script_hex: Option<String>,
    tap_internal_key_hex: Option<String>,
}

fn parse_json<T: for<'de> Deserialize<'de>>(request: &str) -> Result<T, CryptoError> {
    serde_json::from_str(request).map_err(|error| CryptoError::InvalidRequest(error.to_string()))
}

fn fill_random_with<E>(
    buffer: &mut [u8],
    fill: impl FnOnce(&mut [u8]) -> Result<(), E>,
) -> Result<(), CryptoError> {
    if fill(buffer).is_err() || buffer.iter().all(|byte| *byte == 0) {
        buffer.zeroize();
        return Err(CryptoError::Entropy);
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn fill_os_random(buffer: &mut [u8]) -> Result<(), CryptoError> {
    fill_random_with(buffer, getrandom::fill)
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "nito_crypto")]
unsafe extern "C" {
    #[link_name = "fill_random"]
    fn host_fill_random(pointer: *mut u8, length: usize) -> i32;
}

#[cfg(target_arch = "wasm32")]
fn fill_os_random(buffer: &mut [u8]) -> Result<(), CryptoError> {
    fill_random_with(buffer, |bytes| {
        let status = unsafe { host_fill_random(bytes.as_mut_ptr(), bytes.len()) };
        if status == 0 { Ok(()) } else { Err(()) }
    })
}

fn random_bytes(request: &str) -> Result<Value, CryptoError> {
    let request: RandomBytesRequest = parse_json(request)?;
    if !(MIN_RANDOM_BYTES..=MAX_RANDOM_BYTES).contains(&request.length) {
        return Err(CryptoError::InvalidRequest(format!(
            "random byte length must be between {MIN_RANDOM_BYTES} and {MAX_RANDOM_BYTES}"
        )));
    }

    let mut bytes = Zeroizing::new(vec![0_u8; request.length]);
    fill_os_random(bytes.as_mut_slice())?;
    serde_json::to_value(RandomBytesResponse {
        bytes_base64: BASE64.encode(bytes.as_slice()),
    })
    .map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn mix_seed_entropy_with<E>(
    additional_entropy: &[u8],
    entropy_length: usize,
    fill: impl FnOnce(&mut [u8]) -> Result<(), E>,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if additional_entropy.len() != DICE_ENTROPY_BYTES {
        return Err(CryptoError::InvalidRequest(format!(
            "additional entropy must contain exactly {DICE_ENTROPY_BYTES} bytes"
        )));
    }
    if ![MNEMONIC_12_ENTROPY_BYTES, MNEMONIC_24_ENTROPY_BYTES].contains(&entropy_length) {
        return Err(CryptoError::InvalidRequest(
            "mnemonic entropy length is unsupported".into(),
        ));
    }
    let mut system_entropy = Zeroizing::new(vec![0_u8; entropy_length]);
    fill_random_with(system_entropy.as_mut_slice(), fill)?;
    let mut mixed_entropy = Zeroizing::new(vec![0_u8; entropy_length]);
    for index in 0..entropy_length {
        mixed_entropy[index] = system_entropy[index] ^ additional_entropy[index];
    }
    system_entropy.zeroize();
    Ok(mixed_entropy)
}

fn generate_mnemonic(request: &str) -> Result<Value, CryptoError> {
    let request: GenerateMnemonicRequest = parse_json(request)?;
    let entropy_length = match request.word_count.unwrap_or(24) {
        12 => MNEMONIC_12_ENTROPY_BYTES,
        24 => MNEMONIC_24_ENTROPY_BYTES,
        _ => {
            return Err(CryptoError::InvalidRequest(
                "word count must be 12 or 24".into(),
            ));
        }
    };
    let additional_entropy = match request.additional_entropy_base64 {
        Some(mut encoded) => {
            let decoded = BASE64.decode(encoded.as_bytes());
            encoded.zeroize();
            let decoded = Zeroizing::new(decoded.map_err(|_| {
                CryptoError::InvalidRequest("additional entropy is not valid base64".into())
            })?);
            if decoded.len() != DICE_ENTROPY_BYTES {
                return Err(CryptoError::InvalidRequest(format!(
                    "additional entropy must contain exactly {DICE_ENTROPY_BYTES} bytes"
                )));
            }
            decoded
        }
        None => Zeroizing::new(vec![0_u8; DICE_ENTROPY_BYTES]),
    };

    // Additional entropy is fully validated before fresh system entropy is drawn.
    // The caller provides a domain-separated SHA-256 digest of physical rolls.
    let mixed_entropy = mix_seed_entropy_with(
        additional_entropy.as_slice(),
        entropy_length,
        fill_os_random,
    )?;

    let mnemonic = Mnemonic::from_entropy_in(Language::English, mixed_entropy.as_ref())
        .map_err(|error| CryptoError::Crypto(error.to_string()))?;
    serde_json::to_value(GenerateMnemonicResponse {
        mnemonic: mnemonic.to_string(),
    })
    .map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn master_xpriv(mnemonic: &str) -> Result<Xpriv, CryptoError> {
    let parsed = Mnemonic::parse_in_normalized(Language::English, mnemonic)
        .map_err(|_| CryptoError::InvalidMnemonic)?;
    let mut seed = parsed.to_seed_normalized("");
    let root = Xpriv::new_master(bitcoin::NetworkKind::Main, &seed)
        .map_err(|error| CryptoError::Crypto(error.to_string()));
    seed.zeroize();
    root
}

fn derive_secret(root: &Xpriv, path: &str) -> Result<SecretKey, CryptoError> {
    let derivation_path =
        DerivationPath::from_str(path).map_err(|_| CryptoError::InvalidPath(path.to_owned()))?;
    root.derive_priv(&Secp256k1::new(), &derivation_path)
        .map(|child| child.private_key)
        .map_err(|_| CryptoError::InvalidPath(path.to_owned()))
}

fn base58_address(prefix: u8, payload: &[u8]) -> String {
    let mut value = Vec::with_capacity(payload.len() + 1);
    value.push(prefix);
    value.extend_from_slice(payload);
    base58::encode_check(&value)
}

fn validate_transparent_path(path: &str, script_type: ScriptType) -> Result<(), CryptoError> {
    let components = path.split('/').collect::<Vec<_>>();
    if components.len() != 6 || components[0] != "m" {
        return Err(CryptoError::InvalidPath(path.to_owned()));
    }

    let expected_purpose = match script_type {
        ScriptType::P2pkh => "44'",
        ScriptType::P2shP2wpkh => "49'",
        ScriptType::P2wpkh => "84'",
        ScriptType::P2tr => "86'",
    };
    let account = components[3]
        .strip_suffix('\'')
        .and_then(|value| value.parse::<u32>().ok());
    let branch = components[4].parse::<u32>().ok();
    let index = components[5].parse::<u32>().ok();

    if components[1] != expected_purpose
        || components[2] != "0'"
        || !matches!(account, Some(0 | 1))
        || !matches!(branch, Some(0 | 1))
        || !matches!(index, Some(value) if value <= MAX_DERIVATION_INDEX)
    {
        return Err(CryptoError::InvalidPath(path.to_owned()));
    }

    Ok(())
}

fn address_material(
    secret_key: &SecretKey,
    compressed: bool,
    script_type: ScriptType,
) -> Result<AddressMaterial, CryptoError> {
    if !compressed && script_type != ScriptType::P2pkh {
        return Err(CryptoError::UnsupportedScriptType);
    }

    let secp = Secp256k1::new();
    let secp_public_key = bitcoin::secp256k1::PublicKey::from_secret_key(&secp, secret_key);
    let public_key = if compressed {
        PublicKey::new(secp_public_key)
    } else {
        PublicKey::new_uncompressed(secp_public_key)
    };
    let public_key_hash = public_key.pubkey_hash();

    let (address, script, redeem_script_hex, tap_internal_key_hex) = match script_type {
        ScriptType::P2pkh => {
            let script = ScriptBuf::new_p2pkh(&public_key_hash);
            (
                base58_address(NITO_P2PKH_PREFIX, public_key_hash.as_byte_array()),
                script,
                None,
                None,
            )
        }
        ScriptType::P2shP2wpkh => {
            let witness_key_hash = public_key
                .wpubkey_hash()
                .map_err(|error| CryptoError::Crypto(error.to_string()))?;
            let redeem_script = ScriptBuf::new_p2wpkh(&witness_key_hash);
            let script_hash = hash160::Hash::hash(redeem_script.as_bytes());
            let script = ScriptBuf::new_p2sh(&bitcoin::ScriptHash::from_byte_array(
                script_hash.to_byte_array(),
            ));
            (
                base58_address(NITO_P2SH_PREFIX, script_hash.as_byte_array()),
                script,
                Some(hex::encode(redeem_script.as_bytes())),
                None,
            )
        }
        ScriptType::P2wpkh => {
            let witness_key_hash = public_key
                .wpubkey_hash()
                .map_err(|error| CryptoError::Crypto(error.to_string()))?;
            let script = ScriptBuf::new_p2wpkh(&witness_key_hash);
            let hrp =
                Hrp::parse(NITO_HRP).map_err(|error| CryptoError::Crypto(error.to_string()))?;
            let address = segwit::encode(hrp, segwit::VERSION_0, witness_key_hash.as_byte_array())
                .map_err(|error| CryptoError::Crypto(error.to_string()))?;
            (address, script, None, None)
        }
        ScriptType::P2tr => {
            let keypair = Keypair::from_secret_key(&secp, secret_key);
            let (internal_key, _) = keypair.x_only_public_key();
            let (output_key, _) = internal_key.tap_tweak(&secp, None);
            let output_key = output_key.to_x_only_public_key();
            let script = ScriptBuf::new_p2tr(&secp, internal_key, None);
            let hrp =
                Hrp::parse(NITO_HRP).map_err(|error| CryptoError::Crypto(error.to_string()))?;
            let address = segwit::encode(hrp, segwit::VERSION_1, &output_key.serialize())
                .map_err(|error| CryptoError::Crypto(error.to_string()))?;
            (
                address,
                script,
                None,
                Some(hex::encode(internal_key.serialize())),
            )
        }
    };

    Ok(AddressMaterial {
        address,
        public_key,
        script,
        redeem_script_hex,
        tap_internal_key_hex,
    })
}

fn derive_address(
    root: &Xpriv,
    request: DeriveAddressRequest,
) -> Result<DerivedAddressResponse, CryptoError> {
    validate_transparent_path(&request.path, request.script_type)?;
    let secret_key = derive_secret(root, &request.path)?;
    let material = address_material(&secret_key, true, request.script_type)?;

    Ok(DerivedAddressResponse {
        path: request.path,
        script_type: request.script_type,
        address: material.address,
        public_key_hex: hex::encode(material.public_key.to_bytes()),
        script_hex: hex::encode(material.script.as_bytes()),
        redeem_script_hex: material.redeem_script_hex,
        tap_internal_key_hex: material.tap_internal_key_hex,
    })
}

fn parse_private_key(input: &str) -> Result<ParsedPrivateKey, CryptoError> {
    if input.is_empty() || input.trim() != input {
        return Err(CryptoError::InvalidPrivateKey(
            "surrounding whitespace is not accepted".into(),
        ));
    }

    if input.len() == 64 {
        let mut decoded = Zeroizing::new(
            hex::decode(input)
                .map_err(|_| CryptoError::InvalidPrivateKey("invalid hexadecimal key".into()))?,
        );
        let secret_key = SecretKey::from_slice(decoded.as_slice())
            .map_err(|_| CryptoError::InvalidPrivateKey("invalid secret scalar".into()))?;
        decoded.zeroize();
        return Ok(ParsedPrivateKey {
            secret_key,
            compressed: true,
            format: PrivateKeyFormat::Hex,
        });
    }

    let private_key = PrivateKey::from_wif(input)
        .map_err(|error| CryptoError::InvalidPrivateKey(error.to_string()))?;
    if private_key.network != NetworkKind::Main {
        return Err(CryptoError::InvalidPrivateKey(
            "WIF does not use the Nito mainnet prefix".into(),
        ));
    }

    Ok(ParsedPrivateKey {
        secret_key: private_key.inner,
        compressed: private_key.compressed,
        format: PrivateKeyFormat::Wif,
    })
}

fn inspect_private_key(request: &str) -> Result<Value, CryptoError> {
    let mut request: InspectPrivateKeyRequest = parse_json(request)?;
    let parsed = parse_private_key(&request.private_key)?;
    request.private_key.zeroize();

    // A scalar can own all three historical transparent families.  An
    // uncompressed WIF keeps its historical P2PKH address, while SegWit
    // families necessarily use the compressed public key for the same scalar.
    let script_types = [
        (ScriptType::P2pkh, parsed.compressed),
        (ScriptType::P2shP2wpkh, true),
        (ScriptType::P2wpkh, true),
    ];
    let addresses = script_types
        .iter()
        .copied()
        .map(|(script_type, public_key_compressed)| {
            let material =
                address_material(&parsed.secret_key, public_key_compressed, script_type)?;
            Ok(SingleKeyAddressResponse {
                script_type,
                address: material.address,
                public_key_hex: hex::encode(material.public_key.to_bytes()),
                public_key_compressed,
                script_hex: hex::encode(material.script.as_bytes()),
                redeem_script_hex: material.redeem_script_hex,
                tap_internal_key_hex: material.tap_internal_key_hex,
            })
        })
        .collect::<Result<Vec<_>, CryptoError>>()?;

    serde_json::to_value(PrivateKeyInfoResponse {
        format: parsed.format,
        compressed: parsed.compressed,
        addresses,
    })
    .map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn pbkdf2(request: &str) -> Result<Value, CryptoError> {
    let mut request: Pbkdf2Request = parse_json(request)?;
    if request.rounds == 0 || request.rounds > MAX_PBKDF2_ROUNDS {
        return Err(CryptoError::InvalidRequest(
            "PBKDF2 rounds out of range".into(),
        ));
    }
    if request.output_length == 0 || request.output_length > 64 {
        return Err(CryptoError::InvalidRequest(
            "PBKDF2 output length out of range".into(),
        ));
    }
    let salt = BASE64
        .decode(&request.salt_base64)
        .map_err(|error| CryptoError::InvalidRequest(error.to_string()))?;
    let mut output = vec![0_u8; request.output_length];
    pbkdf2_hmac::<Sha256>(
        request.password.as_bytes(),
        &salt,
        request.rounds,
        &mut output,
    );
    request.password.zeroize();
    let response = Pbkdf2Response {
        key_base64: BASE64.encode(&output),
    };
    output.zeroize();
    serde_json::to_value(response).map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn derive_addresses(request: &str) -> Result<Value, CryptoError> {
    let mut request: DeriveAddressesRequest = parse_json(request)?;
    if request.requests.is_empty() || request.requests.len() > 256 {
        return Err(CryptoError::InvalidRequest(
            "Address batch size out of range".into(),
        ));
    }
    let root = master_xpriv(&request.mnemonic)?;
    request.mnemonic.zeroize();
    let addresses = request
        .requests
        .into_iter()
        .map(|item| derive_address(&root, item))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_value(addresses).map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn previous_output(psbt: &Psbt, index: usize) -> Result<TxOut, CryptoError> {
    let input = psbt
        .inputs
        .get(index)
        .ok_or(CryptoError::MissingPrevout(index))?;
    if let Some(output) = &input.witness_utxo {
        return Ok(output.clone());
    }
    let outpoint = psbt
        .unsigned_tx
        .input
        .get(index)
        .ok_or(CryptoError::MissingPrevout(index))?
        .previous_output;
    input
        .non_witness_utxo
        .as_ref()
        .and_then(|transaction| transaction.output.get(outpoint.vout as usize))
        .cloned()
        .ok_or(CryptoError::MissingPrevout(index))
}

enum PendingSignature {
    Ecdsa(usize, PublicKey, bitcoin::ecdsa::Signature),
    Taproot(usize, bitcoin::taproot::Signature),
}

fn sign_psbt_common(
    psbt_base64: &str,
    signer_requests: Vec<CommonSignerRequest>,
    mut resolve_secret: impl FnMut(&CommonSignerRequest) -> Result<(SecretKey, bool), CryptoError>,
) -> Result<String, CryptoError> {
    let raw_psbt = BASE64
        .decode(psbt_base64)
        .map_err(|error| CryptoError::InvalidPsbt(error.to_string()))?;
    if raw_psbt.len() > MAX_PSBT_BYTES {
        return Err(CryptoError::InvalidPsbt("PSBT exceeds size policy".into()));
    }
    let mut psbt = Psbt::deserialize(&raw_psbt)
        .map_err(|error| CryptoError::InvalidPsbt(error.to_string()))?;
    if signer_requests.len() != psbt.inputs.len() {
        return Err(CryptoError::InvalidPsbt(
            "signer count does not match input count".into(),
        ));
    }
    let signers: HashMap<(String, u32), CommonSignerRequest> = signer_requests
        .into_iter()
        .map(|signer| ((signer.txid.to_lowercase(), signer.vout), signer))
        .collect();
    if signers.len() != psbt.inputs.len() {
        return Err(CryptoError::InvalidPsbt("duplicate signer metadata".into()));
    }
    let prevouts = (0..psbt.inputs.len())
        .map(|index| previous_output(&psbt, index))
        .collect::<Result<Vec<_>, _>>()?;
    let secp = Secp256k1::new();
    let signatures = {
        let mut cache = SighashCache::new(&psbt.unsigned_tx);
        let mut signatures = Vec::with_capacity(psbt.inputs.len());

        for (index, transaction_input) in psbt.unsigned_tx.input.iter().enumerate() {
            let outpoint = transaction_input.previous_output;
            let signer = signers
                .get(&(outpoint.txid.to_string().to_lowercase(), outpoint.vout))
                .ok_or(CryptoError::MissingSigner(index))?;
            let (secret_key, compressed) = resolve_secret(signer)?;
            let material = address_material(&secret_key, compressed, signer.script_type)?;
            if prevouts[index].script_pubkey != material.script {
                return Err(CryptoError::InvalidPsbt(format!(
                    "signer script does not match previous output {index}"
                )));
            }
            let public_key = material.public_key;

            match signer.script_type {
                ScriptType::P2tr => {
                    let keypair = Keypair::from_secret_key(&secp, &secret_key);
                    let (internal_key, _) = keypair.x_only_public_key();
                    if let Some(psbt_internal_key) = psbt.inputs[index].tap_internal_key
                        && psbt_internal_key != internal_key
                    {
                        return Err(CryptoError::InvalidPsbt(format!(
                            "taproot internal key mismatch for input {index}"
                        )));
                    }
                    let sighash = cache
                        .taproot_key_spend_signature_hash(
                            index,
                            &Prevouts::All(&prevouts),
                            TapSighashType::Default,
                        )
                        .map_err(|error| CryptoError::Crypto(error.to_string()))?;
                    let message = Message::from_digest(sighash.to_byte_array());
                    let keypair = keypair.tap_tweak(&secp, None).to_keypair();
                    let signature = secp.sign_schnorr_no_aux_rand(&message, &keypair);
                    signatures.push(PendingSignature::Taproot(
                        index,
                        bitcoin::taproot::Signature {
                            signature,
                            sighash_type: TapSighashType::Default,
                        },
                    ));
                }
                ScriptType::P2pkh => {
                    let sighash = cache
                        .legacy_signature_hash(
                            index,
                            &prevouts[index].script_pubkey,
                            EcdsaSighashType::All.to_u32(),
                        )
                        .map_err(|error| CryptoError::Crypto(error.to_string()))?;
                    let message = Message::from_digest(sighash.to_byte_array());
                    let signature = secp.sign_ecdsa(&message, &secret_key);
                    signatures.push(PendingSignature::Ecdsa(
                        index,
                        public_key,
                        bitcoin::ecdsa::Signature {
                            signature,
                            sighash_type: EcdsaSighashType::All,
                        },
                    ));
                }
                ScriptType::P2shP2wpkh | ScriptType::P2wpkh => {
                    let witness_program = match signer.script_type {
                        ScriptType::P2shP2wpkh => {
                            let redeem_script =
                                psbt.inputs[index].redeem_script.as_ref().ok_or_else(|| {
                                    CryptoError::InvalidPsbt("Missing P2SH redeem script".into())
                                })?;
                            if Some(hex::encode(redeem_script.as_bytes()))
                                != material.redeem_script_hex
                            {
                                return Err(CryptoError::InvalidPsbt(format!(
                                    "P2SH redeem script mismatch for input {index}"
                                )));
                            }
                            redeem_script
                        }
                        ScriptType::P2wpkh => &prevouts[index].script_pubkey,
                        _ => unreachable!(),
                    };
                    let sighash = cache
                        .p2wpkh_signature_hash(
                            index,
                            witness_program,
                            Amount::from_sat(prevouts[index].value.to_sat()),
                            EcdsaSighashType::All,
                        )
                        .map_err(|error| CryptoError::Crypto(error.to_string()))?;
                    let message = Message::from_digest(sighash.to_byte_array());
                    let signature = secp.sign_ecdsa(&message, &secret_key);
                    signatures.push(PendingSignature::Ecdsa(
                        index,
                        public_key,
                        bitcoin::ecdsa::Signature {
                            signature,
                            sighash_type: EcdsaSighashType::All,
                        },
                    ));
                }
            }
        }

        signatures
    };

    for signature in signatures {
        match signature {
            PendingSignature::Ecdsa(index, public_key, signature) => {
                psbt.inputs[index]
                    .partial_sigs
                    .insert(public_key, signature);
            }
            PendingSignature::Taproot(index, signature) => {
                psbt.inputs[index].tap_key_sig = Some(signature);
            }
        }
    }

    Ok(BASE64.encode(psbt.serialize()))
}

fn sign_psbt(request: &str) -> Result<Value, CryptoError> {
    let mut request: SignPsbtRequest = parse_json(request)?;
    let root = master_xpriv(&request.mnemonic)?;
    request.mnemonic.zeroize();
    let signers = request
        .signers
        .into_iter()
        .map(|signer| CommonSignerRequest {
            txid: signer.txid,
            vout: signer.vout,
            path: Some(signer.path),
            script_type: signer.script_type,
            public_key_compressed: true,
        })
        .collect();
    let psbt_base64 = sign_psbt_common(&request.psbt_base64, signers, |signer| {
        let path = signer
            .path
            .as_deref()
            .ok_or_else(|| CryptoError::InvalidRequest("missing derivation path".into()))?;
        validate_transparent_path(path, signer.script_type)?;
        Ok((derive_secret(&root, path)?, true))
    })?;
    let response = SignPsbtResponse { psbt_base64 };
    serde_json::to_value(response).map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn sign_psbt_with_private_key(request: &str) -> Result<Value, CryptoError> {
    let mut request: SignPsbtWithPrivateKeyRequest = parse_json(request)?;
    let private_key = parse_private_key(&request.private_key)?;
    request.private_key.zeroize();
    let signers = request
        .signers
        .into_iter()
        .map(|signer| CommonSignerRequest {
            txid: signer.txid,
            vout: signer.vout,
            path: None,
            script_type: signer.script_type,
            public_key_compressed: signer.public_key_compressed,
        })
        .collect();
    let psbt_base64 = sign_psbt_common(&request.psbt_base64, signers, |signer| {
        Ok((private_key.secret_key, signer.public_key_compressed))
    })?;
    serde_json::to_value(SignPsbtResponse { psbt_base64 })
        .map_err(|error| CryptoError::Crypto(error.to_string()))
}

fn dispatch(operation: &str, request: &str) -> Result<Value, CryptoError> {
    match operation {
        "randomBytes" => random_bytes(request),
        "generateMnemonic" => generate_mnemonic(request),
        "pbkdf2" => pbkdf2(request),
        "deriveAddresses" => derive_addresses(request),
        "inspectPrivateKey" => inspect_private_key(request),
        "signPsbt" => sign_psbt(request),
        "signPsbtWithPrivateKey" => sign_psbt_with_private_key(request),
        _ => Err(CryptoError::InvalidRequest(format!(
            "Unknown operation: {operation}"
        ))),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn invoke_envelope(operation: &str, request: &str) -> String {
    match catch_unwind(AssertUnwindSafe(|| dispatch(operation, request))) {
        Ok(Ok(result)) => json!({ "ok": true, "result": result }).to_string(),
        Ok(Err(error)) => json!({
            "ok": false,
            "error": { "code": error.code(), "message": error.to_string() }
        })
        .to_string(),
        Err(_) => json!({
            "ok": false,
            "error": { "code": "RUST_PANIC", "message": "Native cryptographic operation aborted" }
        })
        .to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
fn invoke_envelope(operation: &str, request: &str) -> String {
    match dispatch(operation, request) {
        Ok(result) => json!({ "ok": true, "result": result }).to_string(),
        Err(error) => json!({
            "ok": false,
            "error": { "code": error.code(), "message": error.to_string() }
        })
        .to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn nito_wallet_crypto_alloc(length: usize) -> *mut u8 {
    if length == 0 || length > MAX_WASM_BUFFER_BYTES {
        return ptr::null_mut();
    }
    let bytes = vec![0_u8; length].into_boxed_slice();
    Box::into_raw(bytes) as *mut u8
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
/// Releases a byte buffer returned by [`nito_wallet_crypto_alloc`].
///
/// # Safety
///
/// `pointer` and `length` must identify one live allocation returned by
/// [`nito_wallet_crypto_alloc`].
pub unsafe extern "C" fn nito_wallet_crypto_free_bytes(pointer: *mut u8, length: usize) {
    if pointer.is_null() || length == 0 || length > MAX_WASM_BUFFER_BYTES {
        return;
    }
    let slice = ptr::slice_from_raw_parts_mut(pointer, length);
    unsafe { drop(Box::from_raw(slice)) };
}

#[unsafe(no_mangle)]
/// Invokes the native cryptographic dispatcher.
///
/// # Safety
///
/// `operation` and `request_json` must be valid, non-null, NUL-terminated C strings for the
/// duration of this call. The returned pointer must be released exactly once with
/// [`nito_wallet_crypto_free`].
pub unsafe extern "C" fn nito_wallet_crypto_invoke(
    operation: *const c_char,
    request_json: *const c_char,
) -> *mut c_char {
    if operation.is_null() || request_json.is_null() {
        return ptr::null_mut();
    }
    let operation = unsafe { CStr::from_ptr(operation) }.to_string_lossy();
    let request_json = unsafe { CStr::from_ptr(request_json) }.to_string_lossy();
    CString::new(invoke_envelope(&operation, &request_json))
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

#[unsafe(no_mangle)]
/// Releases a string returned by [`nito_wallet_crypto_invoke`].
///
/// # Safety
///
/// `value` must either be null or a pointer returned by [`nito_wallet_crypto_invoke`] that has
/// not already been released.
pub unsafe extern "C" fn nito_wallet_crypto_free(value: *mut c_char) {
    if !value.is_null() {
        unsafe { drop(CString::from_raw(value)) };
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_network_nito_wallet_nativecore_NitoWalletCryptoModule_nativeInvoke<
    'local,
>(
    mut env: jni::JNIEnv<'local>,
    _object: jni::objects::JObject<'local>,
    operation: jni::objects::JString<'local>,
    request_json: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    let operation: String = match env.get_string(&operation) {
        Ok(value) => value.into(),
        Err(_) => return ptr::null_mut(),
    };
    let request_json: String = match env.get_string(&request_json) {
        Ok(value) => value.into(),
        Err(_) => return ptr::null_mut(),
    };
    env.new_string(invoke_envelope(&operation, &request_json))
        .map(|value| value.into_raw())
        .unwrap_or(ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bitcoin::{
        OutPoint, Sequence, Transaction, TxIn, Txid, Witness, absolute, transaction::Version,
    };

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    fn scalar_one_secret_key() -> SecretKey {
        let mut bytes = [0_u8; 32];
        bytes[31] = 1;
        SecretKey::from_slice(&bytes).unwrap()
    }

    #[test]
    fn pbkdf2_sha256_matches_known_vector() {
        let response = pbkdf2(
            &json!({
                "password": "password",
                "saltBase64": BASE64.encode("salt"),
                "rounds": 1,
                "outputLength": 32
            })
            .to_string(),
        )
        .unwrap();
        let key = response.get("keyBase64").and_then(Value::as_str).unwrap();
        assert_eq!(
            hex::encode(BASE64.decode(key).unwrap()),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
    }

    #[test]
    fn random_bytes_respects_requested_length_and_changes_between_calls() {
        let request = json!({ "length": 32 }).to_string();
        let first = random_bytes(&request).unwrap();
        let second = random_bytes(&request).unwrap();
        let first = BASE64
            .decode(first.get("bytesBase64").and_then(Value::as_str).unwrap())
            .unwrap();
        let second = BASE64
            .decode(second.get("bytesBase64").and_then(Value::as_str).unwrap())
            .unwrap();

        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 32);
        assert_ne!(first, second);
    }

    #[test]
    fn random_bytes_rejects_out_of_policy_lengths() {
        for length in [0, MIN_RANDOM_BYTES - 1, MAX_RANDOM_BYTES + 1] {
            let error = random_bytes(&json!({ "length": length }).to_string()).unwrap_err();
            assert!(matches!(error, CryptoError::InvalidRequest(_)));
        }
    }

    #[test]
    fn entropy_source_failure_is_explicit_without_fallback() {
        let mut bytes = [0x5a; DICE_ENTROPY_BYTES];
        let result = fill_random_with(&mut bytes, |buffer| {
            buffer[..4].copy_from_slice(&[1, 2, 3, 4]);
            Err::<(), ()>(())
        });

        assert!(matches!(result, Err(CryptoError::Entropy)));
        assert_eq!(bytes, [0_u8; DICE_ENTROPY_BYTES]);
        assert_eq!(CryptoError::Entropy.code(), "ENTROPY_UNAVAILABLE");

        let mut unchanged_zero_buffer = [0_u8; DICE_ENTROPY_BYTES];
        let result = fill_random_with(&mut unchanged_zero_buffer, |_| Ok::<(), ()>(()));
        assert!(matches!(result, Err(CryptoError::Entropy)));
    }

    fn generated_mnemonic(response: &Value) -> &str {
        response.get("mnemonic").and_then(Value::as_str).unwrap()
    }

    fn assert_valid_24_word_mnemonic(mnemonic: &str) {
        assert_eq!(mnemonic.split_whitespace().count(), 24);
        assert!(Mnemonic::parse_in_normalized(Language::English, mnemonic).is_ok());
    }

    #[test]
    fn generates_valid_12_word_mnemonic_when_requested() {
        let response = generate_mnemonic(&json!({ "wordCount": 12 }).to_string()).unwrap();
        let mnemonic = generated_mnemonic(&response);
        assert_eq!(mnemonic.split_whitespace().count(), 12);
        assert!(Mnemonic::parse_in_normalized(Language::English, mnemonic).is_ok());
    }

    #[test]
    fn rejects_unsupported_word_counts() {
        for word_count in [0, 15, 18, 21, 23, 25] {
            let error =
                generate_mnemonic(&json!({ "wordCount": word_count }).to_string()).unwrap_err();
            assert!(matches!(error, CryptoError::InvalidRequest(_)));
        }
    }

    #[test]
    fn generated_mnemonic_accepts_absent_zero_and_arbitrary_additional_entropy() {
        let zero_entropy = BASE64.encode([0_u8; DICE_ENTROPY_BYTES]);
        let arbitrary_entropy_bytes: [u8; DICE_ENTROPY_BYTES] =
            std::array::from_fn(|index| index as u8);
        let arbitrary_entropy = BASE64.encode(arbitrary_entropy_bytes);
        let requests = [
            json!({}),
            json!({ "additionalEntropyBase64": zero_entropy }),
            json!({ "additionalEntropyBase64": arbitrary_entropy }),
        ];

        for request in requests {
            let first = generate_mnemonic(&request.to_string()).unwrap();
            let second = generate_mnemonic(&request.to_string()).unwrap();
            assert_valid_24_word_mnemonic(generated_mnemonic(&first));
            assert_valid_24_word_mnemonic(generated_mnemonic(&second));
            assert_ne!(generated_mnemonic(&first), generated_mnemonic(&second));
        }
    }

    #[test]
    fn additional_entropy_produces_valid_fresh_mnemonics_at_both_supported_lengths() {
        let additional_entropy = BASE64.encode([0xa5_u8; DICE_ENTROPY_BYTES]);

        for word_count in [12, 24] {
            let request = json!({
                "wordCount": word_count,
                "additionalEntropyBase64": additional_entropy.clone()
            })
            .to_string();
            let first = generate_mnemonic(&request).unwrap();
            let second = generate_mnemonic(&request).unwrap();
            let first_mnemonic = generated_mnemonic(&first);
            let second_mnemonic = generated_mnemonic(&second);

            assert_eq!(first_mnemonic.split_whitespace().count(), word_count);
            assert_eq!(second_mnemonic.split_whitespace().count(), word_count);
            assert!(Mnemonic::parse_in_normalized(Language::English, first_mnemonic).is_ok());
            assert!(Mnemonic::parse_in_normalized(Language::English, second_mnemonic).is_ok());
            assert_ne!(first_mnemonic, second_mnemonic);
        }
    }

    #[test]
    fn different_additional_entropy_produces_different_mnemonics_without_returning_entropy() {
        let first = generate_mnemonic(
            &json!({ "additionalEntropyBase64": BASE64.encode([0x11; DICE_ENTROPY_BYTES]) })
                .to_string(),
        )
        .unwrap();
        let second = generate_mnemonic(
            &json!({ "additionalEntropyBase64": BASE64.encode([0x22; DICE_ENTROPY_BYTES]) })
                .to_string(),
        )
        .unwrap();

        assert_ne!(generated_mnemonic(&first), generated_mnemonic(&second));
        assert_eq!(first.as_object().unwrap().len(), 1);
        assert_eq!(second.as_object().unwrap().len(), 1);
    }

    #[test]
    fn generated_mnemonic_rejects_malformed_additional_entropy() {
        for request in [
            json!({ "additionalEntropyBase64": "not base64" }),
            json!({ "additionalEntropyBase64": BASE64.encode([0_u8; DICE_ENTROPY_BYTES - 1]) }),
            json!({ "additionalEntropyBase64": BASE64.encode([0_u8; DICE_ENTROPY_BYTES + 1]) }),
        ] {
            let error = generate_mnemonic(&request.to_string()).unwrap_err();
            assert!(matches!(error, CryptoError::InvalidRequest(_)));
        }
    }

    #[test]
    fn seed_entropy_is_the_exact_xor_of_system_and_additional_entropy() {
        let system_entropy: [u8; DICE_ENTROPY_BYTES] =
            std::array::from_fn(|index| (index as u8).wrapping_add(1));
        let additional_entropy: [u8; DICE_ENTROPY_BYTES] =
            std::array::from_fn(|index| 0xf0_u8.wrapping_sub(index as u8));
        let expected: [u8; DICE_ENTROPY_BYTES] =
            std::array::from_fn(|index| system_entropy[index] ^ additional_entropy[index]);

        let mixed =
            mix_seed_entropy_with(&additional_entropy, MNEMONIC_24_ENTROPY_BYTES, |buffer| {
                buffer.copy_from_slice(&system_entropy);
                Ok::<(), ()>(())
            })
            .unwrap();

        assert_eq!(&*mixed, &expected);

        let invalid = mix_seed_entropy_with(
            &[0_u8; DICE_ENTROPY_BYTES - 1],
            MNEMONIC_24_ENTROPY_BYTES,
            |_| -> Result<(), ()> {
                panic!("invalid additional entropy must be rejected before drawing randomness")
            },
        );
        assert!(matches!(invalid, Err(CryptoError::InvalidRequest(_))));
    }

    #[test]
    fn derives_web_wallet_primary_address() {
        let response = derive_addresses(
            &json!({
                "mnemonic": MNEMONIC,
                "requests": [{ "path": "m/84'/0'/0'/0/0", "scriptType": "p2wpkh" }]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            response.as_array().unwrap()[0]
                .get("address")
                .and_then(Value::as_str),
            Some("nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02")
        );
        assert_eq!(
            response.as_array().unwrap()[0]
                .get("scriptType")
                .and_then(Value::as_str),
            Some("p2wpkh")
        );
    }

    #[test]
    fn derives_all_supported_addresses_from_compressed_wif_and_hex() {
        const HEX_KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
        const WIF_KEY: &str = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
        let expected = [
            ("p2pkh", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
            ("p2sh-p2wpkh", "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN"),
            ("p2wpkh", "nito1qw508d6qejxtdg4y5r3zarvary0c5xw7kfauqqr"),
        ];

        for (key, format) in [(HEX_KEY, "hex"), (WIF_KEY, "wif")] {
            let response = inspect_private_key(&json!({ "privateKey": key }).to_string()).unwrap();
            assert_eq!(response.get("format").and_then(Value::as_str), Some(format));
            assert_eq!(
                response.get("compressed").and_then(Value::as_bool),
                Some(true)
            );
            let addresses = response.get("addresses").and_then(Value::as_array).unwrap();
            assert_eq!(addresses.len(), expected.len());
            for (script_type, address) in expected {
                let item = addresses
                    .iter()
                    .find(|item| {
                        item.get("scriptType").and_then(Value::as_str) == Some(script_type)
                    })
                    .unwrap();
                assert_eq!(item.get("address").and_then(Value::as_str), Some(address));
                assert_eq!(
                    item.get("publicKeyCompressed").and_then(Value::as_bool),
                    Some(true)
                );
            }
        }
    }

    #[test]
    fn uncompressed_wif_covers_legacy_and_compressed_segwit_families() {
        let uncompressed_wif =
            PrivateKey::new_uncompressed(scalar_one_secret_key(), NetworkKind::Main).to_wif();
        let response = inspect_private_key(
            &json!({
                "privateKey": uncompressed_wif
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            response.get("compressed").and_then(Value::as_bool),
            Some(false)
        );
        let addresses = response.get("addresses").and_then(Value::as_array).unwrap();
        assert_eq!(addresses.len(), 3);
        assert_eq!(
            addresses[0].get("address").and_then(Value::as_str),
            Some("1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm")
        );
        assert_eq!(
            addresses[0].get("scriptType").and_then(Value::as_str),
            Some("p2pkh")
        );
        assert_eq!(
            addresses[0]
                .get("publicKeyCompressed")
                .and_then(Value::as_bool),
            Some(false)
        );
        for (script_type, address) in [
            ("p2sh-p2wpkh", "3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN"),
            ("p2wpkh", "nito1qw508d6qejxtdg4y5r3zarvary0c5xw7kfauqqr"),
        ] {
            let item = addresses
                .iter()
                .find(|item| item.get("scriptType").and_then(Value::as_str) == Some(script_type))
                .unwrap();
            assert_eq!(item.get("address").and_then(Value::as_str), Some(address));
            assert_eq!(
                item.get("publicKeyCompressed").and_then(Value::as_bool),
                Some(true)
            );
        }
    }

    #[test]
    fn private_key_parser_rejects_invalid_or_wrong_network_inputs() {
        let testnet_wif = PrivateKey::new(
            SecretKey::from_slice(&[1_u8; 32]).unwrap(),
            NetworkKind::Test,
        )
        .to_wif();
        for invalid in [
            "0000000000000000000000000000000000000000000000000000000000000000".to_owned(),
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz".to_owned(),
            " 0000000000000000000000000000000000000000000000000000000000000001".to_owned(),
            "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWm".to_owned(),
            testnet_wif,
        ] {
            assert!(matches!(
                inspect_private_key(&json!({ "privateKey": invalid }).to_string()),
                Err(CryptoError::InvalidPrivateKey(_))
            ));
        }
    }

    #[test]
    fn derivation_policy_covers_legacy_depth_but_rejects_other_paths() {
        let allowed = derive_addresses(
            &json!({
                "mnemonic": MNEMONIC,
                "requests": [{ "path": "m/84'/0'/1'/0/9999", "scriptType": "p2wpkh" }]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            allowed.as_array().unwrap()[0]
                .get("address")
                .and_then(Value::as_str),
            Some("nito1qj0vycncf27q0478janvcexrltgp3lnauj07mws")
        );

        for (path, script_type) in [
            ("m/84'/0'/1'/0/10000", "p2wpkh"),
            ("m/84'/0'/2'/0/0", "p2wpkh"),
            ("m/84'/0'/0'/2/0", "p2wpkh"),
            ("m/44'/0'/0'/0/0", "p2wpkh"),
        ] {
            let result = derive_addresses(
                &json!({
                    "mnemonic": MNEMONIC,
                    "requests": [{ "path": path, "scriptType": script_type }]
                })
                .to_string(),
            );
            assert!(matches!(result, Err(CryptoError::InvalidPath(_))));
        }
    }

    #[test]
    fn signs_a_p2wpkh_psbt_without_exporting_a_private_key() {
        let root = master_xpriv(MNEMONIC).unwrap();
        let secret_key = derive_secret(&root, "m/84'/0'/0'/0/0").unwrap();
        let secp = Secp256k1::new();
        let public_key = PublicKey::new(bitcoin::secp256k1::PublicKey::from_secret_key(
            &secp,
            &secret_key,
        ));
        let script = ScriptBuf::new_p2wpkh(&public_key.wpubkey_hash().unwrap());
        let outpoint = OutPoint::new(Txid::from_byte_array([0x11; 32]), 0);
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: script.clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: script,
        });
        let response = sign_psbt(
            &json!({
                "mnemonic": MNEMONIC,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 0,
                    "path": "m/84'/0'/0'/0/0",
                    "scriptType": "p2wpkh"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let signed = Psbt::deserialize(
            &BASE64
                .decode(response.get("psbtBase64").and_then(Value::as_str).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    }

    #[test]
    fn signs_a_single_key_p2wpkh_psbt_without_exporting_the_key() {
        const WIF_KEY: &str = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
        let parsed = parse_private_key(WIF_KEY).unwrap();
        let material = address_material(&parsed.secret_key, true, ScriptType::P2wpkh).unwrap();
        let outpoint = OutPoint::new(Txid::from_byte_array([0x44; 32]), 0);
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: material.script.clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: material.script,
        });
        let response = sign_psbt_with_private_key(
            &json!({
                "privateKey": WIF_KEY,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 0,
                    "scriptType": "p2wpkh",
                    "publicKeyCompressed": true
                }]
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(response.as_object().unwrap().len(), 1);
        let signed = Psbt::deserialize(
            &BASE64
                .decode(response.get("psbtBase64").and_then(Value::as_str).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    }

    #[test]
    fn signing_rejects_a_prevout_that_does_not_match_the_declared_key() {
        let signing_wif = PrivateKey::new(scalar_one_secret_key(), NetworkKind::Main).to_wif();
        let outpoint = OutPoint::new(Txid::from_byte_array([0x45; 32]), 0);
        let wrong_script = ScriptBuf::new_p2wpkh(
            &PublicKey::new(bitcoin::secp256k1::PublicKey::from_secret_key(
                &Secp256k1::new(),
                &SecretKey::from_slice(&[2_u8; 32]).unwrap(),
            ))
            .wpubkey_hash()
            .unwrap(),
        );
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: wrong_script.clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: wrong_script,
        });
        let result = sign_psbt_with_private_key(
            &json!({
                "privateKey": signing_wif,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 0,
                    "scriptType": "p2wpkh",
                    "publicKeyCompressed": true
                }]
            })
            .to_string(),
        );
        assert!(matches!(result, Err(CryptoError::InvalidPsbt(_))));
    }

    #[test]
    fn signs_a_bip86_taproot_psbt() {
        let root = master_xpriv(MNEMONIC).unwrap();
        let secret_key = derive_secret(&root, "m/86'/0'/0'/0/0").unwrap();
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret_key);
        let (internal_key, _) = keypair.x_only_public_key();
        let script = ScriptBuf::new_p2tr(&secp, internal_key, None);
        let outpoint = OutPoint::new(Txid::from_byte_array([0x22; 32]), 1);
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: script.clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: script,
        });
        psbt.inputs[0].tap_internal_key = Some(internal_key);
        let response = sign_psbt(
            &json!({
                "mnemonic": MNEMONIC,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 1,
                    "path": "m/86'/0'/0'/0/0",
                    "scriptType": "p2tr"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let signed = Psbt::deserialize(
            &BASE64
                .decode(response.get("psbtBase64").and_then(Value::as_str).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert!(signed.inputs[0].tap_key_sig.is_some());
    }

    #[test]
    fn signs_a_legacy_p2pkh_psbt() {
        let root = master_xpriv(MNEMONIC).unwrap();
        let secret_key = derive_secret(&root, "m/44'/0'/0'/0/0").unwrap();
        let secp = Secp256k1::new();
        let public_key = PublicKey::new(bitcoin::secp256k1::PublicKey::from_secret_key(
            &secp,
            &secret_key,
        ));
        let script = ScriptBuf::new_p2pkh(&public_key.pubkey_hash());
        let previous = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![],
            output: vec![TxOut {
                value: Amount::from_sat(100_000),
                script_pubkey: script.clone(),
            }],
        };
        let outpoint = OutPoint::new(previous.compute_txid(), 0);
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: script,
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].non_witness_utxo = Some(previous);
        let response = sign_psbt(
            &json!({
                "mnemonic": MNEMONIC,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 0,
                    "path": "m/44'/0'/0'/0/0",
                    "scriptType": "p2pkh"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let signed = Psbt::deserialize(
            &BASE64
                .decode(response.get("psbtBase64").and_then(Value::as_str).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    }

    #[test]
    fn signs_a_p2sh_psbt() {
        let root = master_xpriv(MNEMONIC).unwrap();
        let secret_key = derive_secret(&root, "m/49'/0'/0'/0/0").unwrap();
        let secp = Secp256k1::new();
        let public_key = PublicKey::new(bitcoin::secp256k1::PublicKey::from_secret_key(
            &secp,
            &secret_key,
        ));
        let redeem_script = ScriptBuf::new_p2wpkh(&public_key.wpubkey_hash().unwrap());
        let script = ScriptBuf::new_p2sh(&redeem_script.script_hash());
        let outpoint = OutPoint::new(Txid::from_byte_array([0x33; 32]), 0);
        let unsigned = Transaction {
            version: Version::TWO,
            lock_time: absolute::LockTime::ZERO,
            input: vec![TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            }],
            output: vec![TxOut {
                value: Amount::from_sat(90_000),
                script_pubkey: script.clone(),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(unsigned).unwrap();
        psbt.inputs[0].witness_utxo = Some(TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: script,
        });
        psbt.inputs[0].redeem_script = Some(redeem_script);
        let response = sign_psbt(
            &json!({
                "mnemonic": MNEMONIC,
                "psbtBase64": BASE64.encode(psbt.serialize()),
                "signers": [{
                    "txid": outpoint.txid.to_string(),
                    "vout": 0,
                    "path": "m/49'/0'/0'/0/0",
                    "scriptType": "p2sh-p2wpkh"
                }]
            })
            .to_string(),
        )
        .unwrap();
        let signed = Psbt::deserialize(
            &BASE64
                .decode(response.get("psbtBase64").and_then(Value::as_str).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(signed.inputs[0].partial_sigs.len(), 1);
    }
}
