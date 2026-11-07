import { describe, expect, it } from 'vitest';

import {
  decodeBip39SessionSecret,
  encodeBip39SessionSecret,
} from './bip39SessionSecret';
import {
  bip39PassphrasesMatch,
  normalizeBip39Passphrase,
} from './bip39Passphrase';
import {
  createPasswordSecretVault,
  createRandomSecretVault,
  decryptPasswordSecretVault,
  decryptSecretVault,
  destroySecretVault,
} from './secretVault';

const SECRET =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('in-memory secret vault', () => {
  it('keeps a BIP39 secret encrypted under a non-extractable session key', async () => {
    const vault = await createRandomSecretVault(SECRET, 'bip39-test');

    expect(vault.key.extractable).toBe(false);
    expect(new TextDecoder().decode(vault.ciphertext)).not.toContain('abandon');
    await expect(decryptSecretVault(vault)).resolves.toBe(SECRET);

    destroySecretVault(vault);
    expect(vault.ciphertext.every((byte) => byte === 0)).toBe(true);
    expect(vault.iv.every((byte) => byte === 0)).toBe(true);
  });

  it('encrypts the versioned mnemonic and passphrase payload without exposing either secret', async () => {
    const payload = encodeBip39SessionSecret(SECRET, '  Trézor  ');
    const vault = await createRandomSecretVault(
      payload,
      'nito-wallet-web:bip39-session:v2',
    );
    const ciphertext = new TextDecoder().decode(vault.ciphertext);
    expect(ciphertext).not.toContain('abandon');
    expect(ciphertext).not.toContain('Trézor');

    const decrypted = await decryptSecretVault(vault);
    expect(decodeBip39SessionSecret(decrypted)).toEqual({
      version: 1,
      mnemonic: SECRET,
      bip39Passphrase: '  Tre\u0301zor  ',
    });
    destroySecretVault(vault);
  });

  it('normalizes only with NFKD and validates the internal payload version', () => {
    expect(normalizeBip39Passphrase(' É ')).toBe(' E\u0301 ');
    expect(normalizeBip39Passphrase(' É ')).not.toBe(
      normalizeBip39Passphrase('é'),
    );
    expect(bip39PassphrasesMatch('é', 'e\u0301')).toBe(true);
    expect(bip39PassphrasesMatch('Passphrase', 'passphrase')).toBe(false);
    expect(() =>
      decodeBip39SessionSecret(
        JSON.stringify({
          version: 2,
          mnemonic: SECRET,
          bip39Passphrase: '',
        }),
      ),
    ).toThrow('INVALID_BIP39_SESSION_SECRET');
  });

  it('encrypts an email wallet seed with a password-derived non-extractable key', async () => {
    const vault = await createPasswordSecretVault(
      SECRET,
      'correct horse battery staple',
      'alice@example.test',
      'compatibility-test',
    );

    expect(vault.key.extractable).toBe(false);
    await expect(
      decryptPasswordSecretVault(vault, 'wrong password', 'alice@example.test'),
    ).rejects.toBeDefined();
    await expect(
      decryptPasswordSecretVault(
        vault,
        'correct horse battery staple',
        'alice@example.test',
      ),
    ).resolves.toBe(SECRET);
  });
});
