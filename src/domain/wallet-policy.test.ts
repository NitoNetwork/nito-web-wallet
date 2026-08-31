import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HD_RECEIVE_ACCOUNT_KEY,
  DEFAULT_HD_GAP_LIMIT,
  HD_ACCOUNT_TEMPLATES,
  LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX,
  LEGACY_ACCOUNT_ONE_TEMPLATES,
  WALLET_SOURCE_KINDS,
  WALLET_SOURCE_POLICIES,
  deriveHdPath,
  offersRecoveryPhraseInSettings,
} from './wallet-policy';

describe('wallet policy', () => {
  it('exposes exactly the three authorized sources', () => {
    expect(WALLET_SOURCE_KINDS).toEqual([
      'bip39-hd',
      'single-private-key',
      'email-credentials',
    ]);
    expect(
      WALLET_SOURCE_POLICIES.filter((source) => source.hd).map(
        (source) => source.kind,
      ),
    ).toEqual(['bip39-hd', 'email-credentials']);
  });

  it('keeps the four mobile account-zero templates and both branches', () => {
    expect(
      HD_ACCOUNT_TEMPLATES.map((template) => template.accountPath),
    ).toEqual(["m/44'/0'/0'", "m/49'/0'/0'", "m/84'/0'/0'", "m/86'/0'/0'"]);
    expect(deriveHdPath(HD_ACCOUNT_TEMPLATES[2]!, 'external', 7)).toBe(
      "m/84'/0'/0'/0/7",
    );
    expect(deriveHdPath(HD_ACCOUNT_TEMPLATES[2]!, 'internal', 7)).toBe(
      "m/84'/0'/0'/1/7",
    );
    expect(
      HD_ACCOUNT_TEMPLATES.filter(({ preferred }) => preferred).map(({ key }) => key),
    ).toEqual(['taproot']);
    expect(DEFAULT_HD_RECEIVE_ACCOUNT_KEY).toBe('taproot');
  });

  it('retains account one as recovery-only without a reduced scan cap', () => {
    expect(
      LEGACY_ACCOUNT_ONE_TEMPLATES.map((template) => template.accountPath),
    ).toEqual(["m/44'/0'/1'", "m/49'/0'/1'", "m/84'/0'/1'", "m/86'/0'/1'"]);
    expect(
      LEGACY_ACCOUNT_ONE_TEMPLATES.every((template) => template.recoveryOnly),
    ).toBe(true);
    expect(LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX).toBe(9_999);
    expect(DEFAULT_HD_GAP_LIMIT).toBe(20);
  });

  it('rejects invalid derivation indexes', () => {
    expect(() =>
      deriveHdPath(HD_ACCOUNT_TEMPLATES[0]!, 'external', -1),
    ).toThrow();
    expect(() =>
      deriveHdPath(HD_ACCOUNT_TEMPLATES[0]!, 'external', 1.5),
    ).toThrow();
  });

  it('offers seed recovery in settings only for deterministic email wallets', () => {
    expect(offersRecoveryPhraseInSettings('email-credentials')).toBe(true);
    expect(offersRecoveryPhraseInSettings('bip39-hd')).toBe(false);
    expect(offersRecoveryPhraseInSettings('single-private-key')).toBe(false);
  });
});
