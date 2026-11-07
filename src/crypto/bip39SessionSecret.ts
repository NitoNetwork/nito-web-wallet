import { normalizeBip39Passphrase } from './bip39Passphrase';

const BIP39_SESSION_SECRET_VERSION = 1;

export type Bip39SessionSecret = {
  version: 1;
  mnemonic: string;
  bip39Passphrase: string;
};

export function encodeBip39SessionSecret(
  mnemonic: string,
  bip39Passphrase: string,
): string {
  return JSON.stringify({
    version: BIP39_SESSION_SECRET_VERSION,
    mnemonic,
    bip39Passphrase: normalizeBip39Passphrase(bip39Passphrase),
  } satisfies Bip39SessionSecret);
}

export function decodeBip39SessionSecret(payload: string): Bip39SessionSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error('INVALID_BIP39_SESSION_SECRET');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Partial<Bip39SessionSecret>).version !==
      BIP39_SESSION_SECRET_VERSION ||
    typeof (parsed as Partial<Bip39SessionSecret>).mnemonic !== 'string' ||
    typeof (parsed as Partial<Bip39SessionSecret>).bip39Passphrase !== 'string'
  ) {
    throw new Error('INVALID_BIP39_SESSION_SECRET');
  }
  const secret = parsed as Bip39SessionSecret;
  secret.bip39Passphrase = normalizeBip39Passphrase(secret.bip39Passphrase);
  return secret;
}

export function wipeBip39SessionSecret(secret: Bip39SessionSecret): void {
  secret.mnemonic = '';
  secret.bip39Passphrase = '';
}
