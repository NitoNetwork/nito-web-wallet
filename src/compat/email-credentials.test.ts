import { describe, expect, it } from 'vitest';

import {
  EMAIL_CREDENTIAL_DERIVATION_VERSION,
  EMAIL_CREDENTIAL_PBKDF2_ITERATIONS,
  EMAIL_CREDENTIAL_SALT_PREFIX,
  deriveEmailCredentialMnemonic,
  verifyEmailCredentialMnemonic,
} from './email-credentials';

const EXPECTED_COMPATIBILITY_MNEMONIC =
  'dice scare infant wreck behave rude rapid author motor knife venue two shoe absurd penalty bus one famous cricket abuse extend panel panic exclude';

describe('deterministic email/password derivation', () => {
  it('freezes the exact PBKDF2 parameters', () => {
    expect(EMAIL_CREDENTIAL_DERIVATION_VERSION).toBe('email-v1');
    expect(EMAIL_CREDENTIAL_PBKDF2_ITERATIONS).toBe(200_000);
    expect(EMAIL_CREDENTIAL_SALT_PREFIX).toBe('nito-mnemonic:');
  });

  it('matches the audited deterministic derivation vector', async () => {
    await expect(
      deriveEmailCredentialMnemonic(
        '  Test.User+Legacy@Example.COM  ',
        '  Legacy-Test-Password-2026!  ',
      ),
    ).resolves.toBe(EXPECTED_COMPATIBILITY_MNEMONIC);
  });

  it('rejects malformed credentials before derivation', async () => {
    await expect(deriveEmailCredentialMnemonic('not-an-email', 'long-enough')).rejects.toThrow();
    await expect(deriveEmailCredentialMnemonic('user@example.com', 'short')).rejects.toThrow();
  });

  it('reauthenticates a reveal only with the original email password', async () => {
    await expect(
      verifyEmailCredentialMnemonic(
        'Test.User+Legacy@Example.COM',
        'Legacy-Test-Password-2026!',
        EXPECTED_COMPATIBILITY_MNEMONIC,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyEmailCredentialMnemonic(
        'Test.User+Legacy@Example.COM',
        'Another-Password-2026!',
        EXPECTED_COMPATIBILITY_MNEMONIC,
      ),
    ).resolves.toBe(false);
  });
});
