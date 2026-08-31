export const WALLET_SOURCE_KINDS = [
  'bip39-hd',
  'single-private-key',
  'email-credentials',
] as const;

export type WalletSourceKind = (typeof WALLET_SOURCE_KINDS)[number];

export type WalletSourcePolicy = Readonly<{
  kind: WalletSourceKind;
  hd: boolean;
}>;

export const WALLET_SOURCE_POLICIES: readonly WalletSourcePolicy[] = [
  {
    kind: 'bip39-hd',
    hd: true,
  },
  {
    kind: 'single-private-key',
    hd: false,
  },
  {
    kind: 'email-credentials',
    hd: true,
  },
] as const;

export function offersRecoveryPhraseInSettings(
  source: WalletSourceKind,
): boolean {
  return source === 'email-credentials';
}

export type HdBranch = 'external' | 'internal';

export const HD_BRANCH_NUMBERS: Readonly<Record<HdBranch, 0 | 1>> = {
  external: 0,
  internal: 1,
};

export type TransparentScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr';

export type HdAccountTemplate = Readonly<{
  key: 'legacy' | 'p2sh' | 'bech32' | 'taproot';
  label: string;
  accountPath: string;
  scriptType: TransparentScriptType;
  preferred: boolean;
  recoveryOnly: boolean;
}>;

export type HdAccountKey = HdAccountTemplate['key'];

/** Preferred account-zero family shown when an HD wallet opens Receive. */
export const DEFAULT_HD_RECEIVE_ACCOUNT_KEY: HdAccountKey = 'taproot';

export type HdAddressSequence = Readonly<{
  account: 0 | 1;
  accountKey: HdAccountKey;
  branch: HdBranch;
}>;

export type HdScanRequirement = HdAddressSequence &
  Readonly<{
    highestIssuedIndex: number;
  }>;

export const HD_ACCOUNT_TEMPLATES: readonly HdAccountTemplate[] = [
  {
    key: 'legacy',
    label: 'Legacy',
    accountPath: "m/44'/0'/0'",
    scriptType: 'p2pkh',
    preferred: false,
    recoveryOnly: false,
  },
  {
    key: 'p2sh',
    label: 'P2SH',
    accountPath: "m/49'/0'/0'",
    scriptType: 'p2sh-p2wpkh',
    preferred: false,
    recoveryOnly: false,
  },
  {
    key: 'bech32',
    label: 'Bech32',
    accountPath: "m/84'/0'/0'",
    scriptType: 'p2wpkh',
    preferred: false,
    recoveryOnly: false,
  },
  {
    key: 'taproot',
    label: 'Taproot',
    accountPath: "m/86'/0'/0'",
    scriptType: 'p2tr',
    preferred: true,
    recoveryOnly: false,
  },
] as const;

export const LEGACY_ACCOUNT_ONE_TEMPLATES: readonly HdAccountTemplate[] =
  HD_ACCOUNT_TEMPLATES.map((template) => ({
    ...template,
    accountPath: template.accountPath.replace(/\/0'$/, "/1'"),
    preferred: false,
    recoveryOnly: true,
  }));

export const DEFAULT_HD_GAP_LIMIT = 20;
export const LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX = 9_999;

export function deriveHdPath(
  account: HdAccountTemplate,
  branch: HdBranch,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('A derivation index must be a non-negative safe integer.');
  }

  return `${account.accountPath}/${HD_BRANCH_NUMBERS[branch]}/${index}`;
}
