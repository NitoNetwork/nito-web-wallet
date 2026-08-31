import { describe, expect, it } from 'vitest';

import {
  createPasswordSecretVault,
  createRandomSecretVault,
  decryptPasswordSecretVault,
  decryptSecretVault,
  destroySecretVault,
} from './secretVault';

const SECRET = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

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
