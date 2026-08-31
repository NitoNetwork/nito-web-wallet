import type { TransparentScriptType, WalletSourceKind } from '../domain/wallet-policy';

export type DerivedAddress = {
  path: string;
  scriptType: TransparentScriptType;
  address: string;
  publicKeyHex: string;
  scriptHex: string;
  redeemScriptHex?: string;
  tapInternalKeyHex?: string;
};

export type SingleKeyAddress = Omit<DerivedAddress, 'path'> & {
  /** Compression used to build and sign this exact script family. */
  publicKeyCompressed: boolean;
};

export type PrivateKeyInfo = {
  format: 'wif' | 'hex';
  compressed: boolean;
  addresses: SingleKeyAddress[];
};

export type HdSigner = {
  txid: string;
  vout: number;
  path: string;
  scriptType: TransparentScriptType;
};

export type SingleKeySigner = Omit<HdSigner, 'path'> & {
  publicKeyCompressed: boolean;
};

export type WalletSessionSummary = {
  sessionId: string;
  source: WalletSourceKind;
  hd: boolean;
  wordCount?: 12 | 24;
  compressed?: boolean;
  primaryAddresses: Array<DerivedAddress | SingleKeyAddress>;
};

export type CryptoWorkerCapabilities = {
  abiVersion: 1;
  transparentOnly: true;
  sources: readonly ['bip39-hd', 'single-private-key', 'email-credentials'];
  scriptTypes: readonly ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'];
  maxDerivationIndex: 9_999;
};

export type CryptoWorkerCommand =
  | { type: 'health' }
  | { type: 'createMnemonic'; wordCount: 12 | 24; diceEntropyBase64?: string }
  | { type: 'importMnemonic'; mnemonic: string }
  | { type: 'importPrivateKey'; privateKey: string }
  | { type: 'importEmailCredentials'; email: string; password: string }
  | {
      type: 'verifyMnemonicBackup';
      sessionId: string;
      answers: Array<{ wordIndex: number; word: string }>;
    }
  | {
      type: 'deriveAddresses';
      sessionId: string;
      requests: Array<{ path: string; scriptType: TransparentScriptType }>;
    }
  | {
      type: 'signPsbt';
      sessionId: string;
      psbtBase64: string;
      signers: HdSigner[] | SingleKeySigner[];
    }
  | { type: 'revealMnemonic'; sessionId: string; password?: string };

export type CryptoWorkerResultByCommand = {
  health: CryptoWorkerCapabilities;
  createMnemonic: WalletSessionSummary & { mnemonic: string };
  importMnemonic: WalletSessionSummary;
  importPrivateKey: WalletSessionSummary;
  importEmailCredentials: WalletSessionSummary;
  verifyMnemonicBackup: { valid: boolean };
  deriveAddresses: DerivedAddress[];
  signPsbt: { psbtBase64: string };
  revealMnemonic: { mnemonic: string; wordCount: 12 | 24 };
};

export type CryptoWorkerRequest = {
  id: string;
  command: CryptoWorkerCommand;
};

export type CryptoWorkerResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export function isCryptoWorkerResponse(value: unknown): value is CryptoWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CryptoWorkerResponse>;
  if (typeof candidate.id !== 'string' || typeof candidate.ok !== 'boolean') return false;
  if (candidate.ok) return 'result' in candidate;
  return (
    'error' in candidate &&
    typeof candidate.error === 'object' &&
    candidate.error !== null &&
    typeof candidate.error.code === 'string' &&
    typeof candidate.error.message === 'string'
  );
}
