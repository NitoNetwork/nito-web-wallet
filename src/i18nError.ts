import type { Translator } from './i18n';
import type { TranslationKey } from './i18nMessages';
import type { TransparentSendErrorCode } from './wallet/transparentSend';

type ErrorContext = 'local' | 'wallet' | 'network' | 'copy';

const SEND_ERROR_KEYS = {
  'invalid-amount-format': 'errors.send.invalidAmount',
  'amount-not-positive': 'errors.send.positiveAmount',
  'amount-below-dust': 'errors.send.dustAmount',
  'invalid-fee-rate': 'errors.send.invalidFee',
  'signing-material-unavailable': 'errors.send.signingMaterial',
  'legacy-signing-data-unavailable': 'errors.send.legacyData',
  'no-spendable-utxo': 'errors.send.noUtxo',
  'change-address-unavailable': 'errors.send.noChangeAddress',
  'change-address-not-owned': 'errors.send.changeNotOwned',
  'recipient-required': 'errors.send.recipientRequired',
  'too-many-recipients': 'errors.send.tooManyRecipients',
  'recipient-address-required': 'errors.send.emptyRecipient',
  'recipient-address-invalid': 'errors.send.invalidRecipient',
  'recipient-output-dust': 'errors.send.recipientDust',
  'max-recipient-unavailable': 'errors.send.maxRecipient',
  'insufficient-funds': 'errors.send.insufficientFunds',
  'selected-input-unresolved': 'errors.send.unresolvedInput',
  'signed-transaction-mismatch': 'errors.send.transactionMismatch',
  'signature-invalid': 'errors.send.signatureInvalid',
  'transaction-too-large': 'errors.send.transactionTooLarge',
  'rbf-unavailable': 'errors.send.rbfUnavailable',
  'rbf-original-mismatch': 'errors.send.rbfOriginalMismatch',
  'rbf-transaction-confirmed': 'errors.send.rbfTransactionConfirmed',
  'rbf-insufficient-funds': 'errors.send.rbfInsufficientFunds',
  'rbf-replacement-fee': 'errors.send.rbfReplacementFee',
  'consolidation-not-enough-utxos': 'errors.send.consolidationCount',
  'consolidation-unavailable': 'errors.send.consolidationUnavailable',
  'consolidation-too-large': 'errors.send.consolidationTooLarge',
} as const satisfies Record<TransparentSendErrorCode, TranslationKey>;

const CRYPTO_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  SESSION_LOCKED: 'errors.sessionExpired',
  INVALID_MNEMONIC: 'errors.invalidMnemonic',
  INVALID_PRIVATE_KEY: 'errors.invalidPrivateKey',
  EMAIL_REQUIRED: 'errors.invalidEmail',
  EMAIL_REAUTHENTICATION_FAILED: 'errors.reauthenticationFailed',
  ENTROPY_UNAVAILABLE: 'errors.entropyUnavailable',
  CRYPTO_WORKER_TERMINATED: 'errors.workerUnavailable',
  CRYPTO_WORKER_TIMEOUT: 'errors.workerTimeout',
  INVALID_WASM_MODULE: 'errors.workerUnavailable',
  INVALID_WASM_RESPONSE: 'errors.workerUnavailable',
  WASM_ALLOCATION_FAILED: 'errors.workerUnavailable',
  INVALID_REQUEST: 'errors.cryptoOperation',
  INVALID_OPERATION: 'errors.cryptoOperation',
  REQUEST_TOO_LARGE: 'errors.cryptoOperation',
  UNSUPPORTED_SCRIPT_TYPE: 'errors.cryptoOperation',
  INVALID_DERIVATION_PATH: 'errors.cryptoOperation',
  INVALID_PSBT: 'errors.cryptoOperation',
  MISSING_PREVOUT: 'errors.cryptoOperation',
  MISSING_SIGNER: 'errors.cryptoOperation',
  CRYPTO_ERROR: 'errors.cryptoOperation',
  CRYPTO_WORKER_ERROR: 'errors.cryptoOperation',
  FRESH_SYNC_REQUIRED: 'errors.freshSyncRequired',
  SNAPSHOT_CHANGED: 'errors.snapshotChangedPreview',
  BROADCAST_NO_TXID: 'errors.broadcastNoTxid',
  NETWORK_SYNC_FAILED: 'errors.networkOperation',
  SCAN_INCOMPLETE: 'errors.scanIncomplete',
  SCAN_ABORTED: 'errors.scanAborted',
  ELECTRUM_SESSION_UNHEALTHY: 'errors.electrumDisconnected',
  ELECTRUM_DISCONNECTED: 'errors.electrumDisconnected',
  CHAIN_REORG: 'errors.chainReorg',
};

const ERROR_NAME_KEYS: Readonly<Record<string, TranslationKey>> = {
  TransparentScanAbortedError: 'errors.scanAborted',
  TransparentScanIncompleteError: 'errors.scanIncomplete',
  TransparentScanRangeExhaustedError: 'errors.scanGapExhausted',
  ElectrumSessionUnhealthyError: 'errors.electrumDisconnected',
  ElectrumDisconnectedError: 'errors.electrumDisconnected',
};

const CONTEXT_KEYS: Record<ErrorContext, TranslationKey> = {
  local: 'errors.localOperation',
  wallet: 'errors.walletOperation',
  network: 'errors.networkOperation',
  copy: 'errors.copyOperation',
};

const errorCode = (caught: unknown): string | undefined => {
  if (!caught || typeof caught !== 'object' || !('code' in caught))
    return undefined;
  return typeof caught.code === 'string' ? caught.code : undefined;
};

const errorName = (caught: unknown): string | undefined =>
  caught instanceof Error ? caught.name : undefined;

export function translateWalletError(
  caught: unknown,
  t: Translator,
  context: ErrorContext = 'wallet',
): string {
  const code = errorCode(caught);
  if (code && code in SEND_ERROR_KEYS) {
    return t(SEND_ERROR_KEYS[code as TransparentSendErrorCode]);
  }
  if (code && CRYPTO_ERROR_KEYS[code]) return t(CRYPTO_ERROR_KEYS[code]);

  const name = errorName(caught);
  if (name && ERROR_NAME_KEYS[name]) return t(ERROR_NAME_KEYS[name]);

  return t(CONTEXT_KEYS[context]);
}

const NETWORK_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  SCAN_INCOMPLETE: 'errors.scanIncomplete',
  SCAN_ABORTED: 'errors.scanAborted',
  ELECTRUM_SESSION_UNHEALTHY: 'errors.electrumDisconnected',
  ELECTRUM_DISCONNECTED: 'errors.electrumDisconnected',
  CHAIN_REORG: 'errors.chainReorg',
  NETWORK_SYNC_FAILED: 'errors.networkOperation',
};

export function translateNetworkError(
  code: string | undefined,
  t: Translator,
): string | undefined {
  if (!code) return undefined;
  return t(NETWORK_ERROR_KEYS[code] ?? 'errors.networkOperation');
}

export const TRANSLATED_SEND_ERROR_CODES = Object.freeze(
  Object.keys(SEND_ERROR_KEYS) as TransparentSendErrorCode[],
);
