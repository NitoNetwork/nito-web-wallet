const AES_ALGORITHM = 'AES-GCM';
const AES_KEY_LENGTH = 256;
const AES_IV_LENGTH = 12;
const PASSWORD_KDF_ITERATIONS = 200_000;
const PASSWORD_KDF_PREFIX = 'nito-wallet-web:secret-vault:v1:';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type SecretVault = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  key: CryptoKey;
  context: string;
};

const asBufferSource = (bytes: Uint8Array): BufferSource => bytes as BufferSource;

const createIv = (): Uint8Array => {
  const iv = new Uint8Array(AES_IV_LENGTH);
  crypto.getRandomValues(iv);
  return iv;
};

const derivePasswordKey = async (
  password: string,
  saltContext: string,
): Promise<CryptoKey> => {
  const passwordBytes = encoder.encode(password);
  const saltBytes = encoder.encode(`${PASSWORD_KDF_PREFIX}${saltContext}`);
  try {
    const material = await crypto.subtle.importKey(
      'raw',
      asBufferSource(passwordBytes),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-512',
        salt: asBufferSource(saltBytes),
        iterations: PASSWORD_KDF_ITERATIONS,
      },
      material,
      { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passwordBytes.fill(0);
    saltBytes.fill(0);
  }
};

const encryptSecret = async (
  secret: string,
  key: CryptoKey,
  context: string,
): Promise<SecretVault> => {
  const plaintext = encoder.encode(secret);
  const additionalData = encoder.encode(context);
  const iv = createIv();
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: AES_ALGORITHM,
        iv: asBufferSource(iv),
        additionalData: asBufferSource(additionalData),
      },
      key,
      asBufferSource(plaintext),
    );
    return {
      ciphertext: new Uint8Array(ciphertext),
      iv,
      key,
      context,
    };
  } catch (caught) {
    iv.fill(0);
    throw caught;
  } finally {
    plaintext.fill(0);
    additionalData.fill(0);
  }
};

export const createRandomSecretVault = async (
  secret: string,
  context: string,
): Promise<SecretVault> => {
  const key = await crypto.subtle.generateKey(
    { name: AES_ALGORITHM, length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
  return encryptSecret(secret, key, context);
};

export const createPasswordSecretVault = async (
  secret: string,
  password: string,
  saltContext: string,
  context: string,
): Promise<SecretVault> => {
  const key = await derivePasswordKey(password, saltContext);
  return encryptSecret(secret, key, context);
};

export const decryptSecretVault = async (
  vault: SecretVault,
  key: CryptoKey = vault.key,
): Promise<string> => {
  const additionalData = encoder.encode(vault.context);
  let plaintext: Uint8Array | undefined;
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: AES_ALGORITHM,
        iv: asBufferSource(vault.iv),
        additionalData: asBufferSource(additionalData),
      },
      key,
      asBufferSource(vault.ciphertext),
    );
    plaintext = new Uint8Array(decrypted);
    return decoder.decode(plaintext);
  } finally {
    additionalData.fill(0);
    plaintext?.fill(0);
  }
};

export const decryptPasswordSecretVault = async (
  vault: SecretVault,
  password: string,
  saltContext: string,
): Promise<string> => {
  const key = await derivePasswordKey(password, saltContext);
  return decryptSecretVault(vault, key);
};

export const destroySecretVault = (vault: SecretVault): void => {
  vault.ciphertext.fill(0);
  vault.iv.fill(0);
  vault.context = '';
};
