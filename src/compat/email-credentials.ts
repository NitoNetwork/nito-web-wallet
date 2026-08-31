import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const EMAIL_CREDENTIAL_DERIVATION_VERSION = 'email-v1';
export const EMAIL_CREDENTIAL_PBKDF2_ITERATIONS = 200_000;
export const EMAIL_CREDENTIAL_WORD_COUNT = 24;
export const EMAIL_CREDENTIAL_SALT_PREFIX = 'nito-mnemonic:';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeEmailPassword(password: string): string {
  return password.trim();
}

export async function deriveEmailCredentialMnemonic(
  rawEmail: string,
  rawPassword: string,
): Promise<string> {
  const email = normalizeEmail(rawEmail);
  const password = normalizeEmailPassword(rawPassword);

  if (!EMAIL_PATTERN.test(email)) {
    throw new Error('Invalid wallet email format.');
  }
  if (password.length < 8) {
    throw new Error('Wallet password must contain at least 8 characters.');
  }

  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const salt = encoder.encode(`${EMAIL_CREDENTIAL_SALT_PREFIX}${email}`);
  let entropy: Uint8Array | undefined;

  try {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-512',
        salt,
        iterations: EMAIL_CREDENTIAL_PBKDF2_ITERATIONS,
      },
      keyMaterial,
      256,
    );
    entropy = new Uint8Array(bits);
    return entropyToMnemonic(entropy, wordlist);
  } finally {
    passwordBytes.fill(0);
    salt.fill(0);
    entropy?.fill(0);
  }
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  try {
    for (let index = 0; index < maxLength; index += 1) {
      difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }
    return difference === 0;
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

export async function verifyEmailCredentialMnemonic(
  email: string,
  password: string,
  expectedMnemonic: string,
): Promise<boolean> {
  try {
    const candidate = await deriveEmailCredentialMnemonic(email, password);
    return constantTimeTextEqual(candidate, expectedMnemonic);
  } catch {
    return false;
  }
}
