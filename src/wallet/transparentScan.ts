import type {
  ElectrumBalance,
  ElectrumHistoryEntry,
  ElectrumUtxo,
} from '../network/electrum';
import { ElectrumSessionUnhealthyError } from '../network/electrum';
import type { DerivedAddress as WorkerDerivedAddress, SingleKeyAddress } from '../crypto/workerProtocol';
import {
  DEFAULT_HD_GAP_LIMIT,
  deriveHdPath,
  HD_ACCOUNT_TEMPLATES,
  LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX,
  LEGACY_ACCOUNT_ONE_TEMPLATES,
  type HdAccountTemplate,
  type HdBranch,
  type HdScanRequirement,
  type TransparentScriptType,
  type WalletSourceKind,
} from '../domain/wallet-policy';
import { createConcurrencyLimiter, mapWithConcurrency } from '../services/concurrency';
import {
  mergeWalletHistoryPublication,
  normalizeWalletHistory,
} from '../services/walletHistory';
import {
  annotateCoinbaseMaturity,
  getImmatureCoinbaseSummary,
  isTransparentUtxoSpendable,
} from './coinbaseMaturity';

const SCAN_BATCH_SIZE = 5;
const ELECTRUM_READ_MAX_ATTEMPTS = 3;
const ELECTRUM_READ_RETRY_DELAY_MS = 100;
const SCAN_NETWORK_CONCURRENCY = 6;
const SCAN_COLLECTION_CONCURRENCY = 6;
const MAX_GAP_LIMIT = 100;

export type HdSourceKind = Extract<WalletSourceKind, 'bip39-hd' | 'email-credentials'>;

export type HdScanTemplate = HdAccountTemplate & {
  account: 0 | 1;
  sequenceKey: string;
};

export const HD_SCAN_TEMPLATES: readonly HdScanTemplate[] = [
  ...HD_ACCOUNT_TEMPLATES.map((template) => ({
    ...template,
    account: 0 as const,
    sequenceKey: `account-0:${template.key}`,
  })),
  ...LEGACY_ACCOUNT_ONE_TEMPLATES.map((template) => ({
    ...template,
    account: 1 as const,
    sequenceKey: `account-1:${template.key}`,
  })),
];

type PublicAddressMaterial = Pick<
  WorkerDerivedAddress,
  | 'address'
  | 'publicKeyHex'
  | 'scriptHex'
  | 'redeemScriptHex'
  | 'tapInternalKeyHex'
  | 'scriptType'
>;

export type HdWalletAddress = PublicAddressMaterial & {
  ownerKind: 'hd';
  account: 0 | 1;
  accountKey: HdAccountTemplate['key'];
  accountLabel: string;
  accountPath: string;
  recoveryOnly: boolean;
  branch: HdBranch;
  index: number;
  path: string;
};

export type SingleKeyWalletAddress = PublicAddressMaterial & {
  ownerKind: 'single-key';
  keyAddressIndex: number;
  publicKeyCompressed: boolean;
};

export type WalletAddress = HdWalletAddress | SingleKeyWalletAddress;

export type ScannedAddress = WalletAddress & {
  balance: ElectrumBalance;
  utxos: ElectrumUtxo[];
  history: ElectrumHistoryEntry[];
  used: boolean;
};

export type HdGapCoverage = {
  mode: 'gap';
  sequenceKey: string;
  account: 0 | 1;
  accountKey: HdAccountTemplate['key'];
  branch: HdBranch;
  highestScannedIndex: number;
  lastUsedIndex: number;
  trailingUnused: number;
  gapLimit: number;
  complete: true;
};

export type ExplicitRangeCoverage = {
  mode: 'explicit-range';
  sequenceKey: string;
  account: 0 | 1;
  accountKey: HdAccountTemplate['key'];
  branch: HdBranch;
  fromIndex: number;
  toIndex: number;
  complete: true;
};

export type SingleKeyCoverage = {
  mode: 'single-key';
  addressCount: number;
  complete: true;
};

export type ScanCoverage = HdGapCoverage | ExplicitRangeCoverage | SingleKeyCoverage;

export type TransparentWalletSnapshot = {
  schemaVersion: 1;
  sourceKind: WalletSourceKind;
  scanMode: 'gap' | 'gap-with-recovery' | 'explicit-range' | 'single-key';
  confirmedSats: number;
  unconfirmedSats: number;
  balanceSats: number;
  spendableSats: number;
  immatureCoinbaseSats: number;
  immatureCoinbaseBlocksRemaining: number;
  utxos: ElectrumUtxo[];
  history: ElectrumHistoryEntry[];
  addresses: ScannedAddress[];
  usedAddresses: ScannedAddress[];
  spendableAddresses: ScannedAddress[];
  gapLimit: number | null;
  coverage: ScanCoverage[];
  scannedAt: string;
};

export type ElectrumReader = {
  getAddressBalance(address: string): Promise<ElectrumBalance>;
  getAddressUtxos(address: string): Promise<ElectrumUtxo[]>;
  getAddressHistory(address: string): Promise<ElectrumHistoryEntry[]>;
  getTransactionHex?(txid: string): Promise<string>;
};

export type HdAddressDeriver = (
  sessionId: string,
  requests: Array<{ path: string; scriptType: TransparentScriptType }>,
) => Promise<WorkerDerivedAddress[]>;

export type TransparentScanProgress = Readonly<{
  completedAddresses: number;
  scheduledAddresses: number;
  sequenceKey?: string;
  branch?: HdBranch;
}>;

export type TransparentScanProgressListener = (progress: TransparentScanProgress) => void;

type ElectrumScanOperation = 'balance' | 'history' | 'utxos';
type NetworkTaskRunner = <T>(task: () => Promise<T>) => Promise<T>;
type ScanControl = {
  failure: unknown;
  signal?: AbortSignal;
  fail(caught: unknown): void;
  check(): void;
};

type ScanProgressTracker = {
  reserve(count: number, sequenceKey?: string, branch?: HdBranch): void;
  complete(sequenceKey?: string, branch?: HdBranch): void;
  finish(total: number): void;
};

export class TransparentScanAbortedError extends Error {
  constructor() {
    super('Transparent wallet scan aborted.');
    this.name = 'TransparentScanAbortedError';
  }
}

export class TransparentScanIncompleteError extends Error {
  readonly address: string;
  readonly operation: ElectrumScanOperation;
  readonly attempts: number;
  readonly originalError: Error;

  constructor({
    address,
    operation,
    attempts,
    cause,
  }: {
    address: string;
    operation: ElectrumScanOperation;
    attempts: number;
    cause: unknown;
  }) {
    super(`Transparent wallet scan incomplete: failed to read ${operation} for ${address}.`);
    this.name = 'TransparentScanIncompleteError';
    this.address = address;
    this.operation = operation;
    this.attempts = attempts;
    this.originalError = cause instanceof Error ? cause : new Error(String(cause));
  }
}

export class TransparentScanRangeExhaustedError extends Error {
  constructor(sequenceKey: string, branch: HdBranch) {
    super(
      `Transparent wallet scan cannot prove gap completion for ${sequenceKey}/${branch} before index ${LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX}.`,
    );
    this.name = 'TransparentScanRangeExhaustedError';
  }
}

export class TransparentSnapshotIntegrityError extends Error {
  constructor(detail: string) {
    super(`Transparent wallet snapshot rejected: ${detail}.`);
    this.name = 'TransparentSnapshotIntegrityError';
  }
}

const createScanControl = (signal?: AbortSignal): ScanControl => ({
  failure: undefined,
  signal,
  fail(caught) {
    if (this.failure === undefined) this.failure = caught;
  },
  check() {
    if (this.signal?.aborted) throw new TransparentScanAbortedError();
    if (this.failure !== undefined) throw this.failure;
  },
});

const createScanProgressTracker = (
  onProgress?: TransparentScanProgressListener,
): ScanProgressTracker | undefined => {
  if (!onProgress) return undefined;
  let completedAddresses = 0;
  let scheduledAddresses = 0;

  const emit = (sequenceKey?: string, branch?: HdBranch) =>
    onProgress({
      completedAddresses,
      scheduledAddresses,
      ...(sequenceKey ? { sequenceKey } : {}),
      ...(branch ? { branch } : {}),
    });

  return {
    reserve(count, sequenceKey, branch) {
      scheduledAddresses += count;
      emit(sequenceKey, branch);
    },
    complete(sequenceKey, branch) {
      completedAddresses += 1;
      emit(sequenceKey, branch);
    },
    finish(total) {
      completedAddresses = total;
      scheduledAddresses = total;
      emit();
    },
  };
};

const settleAll = async <T>(tasks: readonly Promise<T>[]): Promise<T[]> => {
  const settled = await Promise.allSettled(tasks);
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
};

const waitBeforeElectrumRetry = (attempt: number, control: ScanControl) =>
  new Promise<void>((resolve, reject) => {
    const signal = control.signal;
    const finish = () => {
      if (signal) signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ELECTRUM_READ_RETRY_DELAY_MS * attempt);
    const abort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      reject(new TransparentScanAbortedError());
    };
    if (!signal) return;
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });

const readElectrumWithRetry = async <T>({
  address,
  operation,
  read,
  control,
}: {
  address: string;
  operation: ElectrumScanOperation;
  read: () => Promise<T>;
  control: ScanControl;
}) => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ELECTRUM_READ_MAX_ATTEMPTS; attempt += 1) {
    control.check();
    try {
      return await read();
    } catch (caught) {
      if (
        caught instanceof ElectrumSessionUnhealthyError ||
        caught instanceof TransparentScanAbortedError
      ) {
        throw caught;
      }
      lastError = caught;
      if (attempt < ELECTRUM_READ_MAX_ATTEMPTS) {
        await waitBeforeElectrumRetry(attempt, control);
      }
    }
  }

  throw new TransparentScanIncompleteError({
    address,
    operation,
    attempts: ELECTRUM_READ_MAX_ATTEMPTS,
    cause: lastError,
  });
};

const validateGapLimit = (gapLimit: number) => {
  if (!Number.isSafeInteger(gapLimit) || gapLimit < 1 || gapLimit > MAX_GAP_LIMIT) {
    throw new Error(`Gap limit must be an integer between 1 and ${MAX_GAP_LIMIT}.`);
  }
};

const issuedRequirementKey = ({
  account,
  accountKey,
  branch,
}: Pick<HdScanRequirement, 'account' | 'accountKey' | 'branch'>) =>
  `${account}:${accountKey}:${branch}`;

const normalizeIssuedRequirements = (
  requirements: readonly HdScanRequirement[],
) => {
  const normalized = new Map<string, number>();
  for (const requirement of requirements) {
    const template = HD_SCAN_TEMPLATES.find(
      (candidate) =>
        candidate.account === requirement.account &&
        candidate.key === requirement.accountKey,
    );
    if (
      !template ||
      (requirement.branch !== 'external' && requirement.branch !== 'internal') ||
      !Number.isSafeInteger(requirement.highestIssuedIndex) ||
      requirement.highestIssuedIndex < 0 ||
      requirement.highestIssuedIndex > LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX
    ) {
      throw new Error('Invalid issued HD address requirement.');
    }
    const key = issuedRequirementKey(requirement);
    if (normalized.has(key)) {
      throw new Error(`Duplicate issued HD address requirement for ${key}.`);
    }
    normalized.set(key, requirement.highestIssuedIndex);
  }
  return normalized;
};

const validateIndex = (index: number, label: string) => {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX
  ) {
    throw new Error(
      `${label} must be between 0 and ${LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX}.`,
    );
  }
};

const validatePublicAddressMaterial = (
  address: PublicAddressMaterial,
  expectedScriptType: TransparentScriptType,
) => {
  if (address.scriptType !== expectedScriptType) {
    throw new TransparentSnapshotIntegrityError('derived script type does not match request');
  }
  if (address.address.trim() === '') {
    throw new TransparentSnapshotIntegrityError('derived address is empty');
  }
  for (const [label, value] of [
    ['public key', address.publicKeyHex],
    ['script', address.scriptHex],
  ] as const) {
    if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(value)) {
      throw new TransparentSnapshotIntegrityError(`derived ${label} is not valid hex`);
    }
  }
};

const deriveAddressBatch = async (
  sessionId: string,
  template: HdScanTemplate,
  branch: HdBranch,
  indices: number[],
  deriveAddresses: HdAddressDeriver,
  control: ScanControl,
): Promise<HdWalletAddress[]> => {
  control.check();
  const requests = indices.map((index) => ({
    path: deriveHdPath(template, branch, index),
    scriptType: template.scriptType,
  }));
  const derived = await deriveAddresses(sessionId, requests);
  control.check();
  if (derived.length !== requests.length) {
    throw new TransparentSnapshotIntegrityError('address derivation returned a partial batch');
  }

  return derived.map((address, offset) => {
    const request = requests[offset];
    const index = indices[offset];
    if (!request || index === undefined || address.path !== request.path) {
      throw new TransparentSnapshotIntegrityError('address derivation returned an unexpected path');
    }
    validatePublicAddressMaterial(address, request.scriptType);
    return {
      ownerKind: 'hd',
      account: template.account,
      accountKey: template.key,
      accountLabel: template.label,
      accountPath: template.accountPath,
      recoveryOnly: template.recoveryOnly,
      branch,
      index,
      path: address.path,
      scriptType: address.scriptType,
      address: address.address,
      publicKeyHex: address.publicKeyHex,
      scriptHex: address.scriptHex,
      ...(address.redeemScriptHex ? { redeemScriptHex: address.redeemScriptHex } : {}),
      ...(address.tapInternalKeyHex
        ? { tapInternalKeyHex: address.tapInternalKeyHex }
        : {}),
    };
  });
};

const addressIdentity = (address: WalletAddress) =>
  address.ownerKind === 'hd' ? address.path : `single-key:${address.keyAddressIndex}`;

const compareAddresses = (left: ScannedAddress, right: ScannedAddress) => {
  if (left.ownerKind !== right.ownerKind) return left.ownerKind.localeCompare(right.ownerKind);
  if (left.ownerKind === 'single-key' && right.ownerKind === 'single-key') {
    return left.keyAddressIndex - right.keyAddressIndex;
  }
  if (left.ownerKind === 'hd' && right.ownerKind === 'hd') {
    if (left.account !== right.account) return left.account - right.account;
    const leftFamily = HD_SCAN_TEMPLATES.findIndex(
      (template) =>
        template.account === left.account && template.key === left.accountKey,
    );
    const rightFamily = HD_SCAN_TEMPLATES.findIndex(
      (template) =>
        template.account === right.account && template.key === right.accountKey,
    );
    if (leftFamily !== rightFamily) return leftFamily - rightFamily;
    if (left.branch !== right.branch) return left.branch === 'external' ? -1 : 1;
    return left.index - right.index;
  }
  return 0;
};

const safeAdd = (total: number, value: number, label: string) => {
  const next = total + value;
  if (!Number.isSafeInteger(next)) {
    throw new TransparentSnapshotIntegrityError(`${label} exceeds the safe integer range`);
  }
  return next;
};

const buildSnapshot = ({
  sourceKind,
  scanMode,
  addresses,
  gapLimit,
  coverage,
}: {
  sourceKind: WalletSourceKind;
  scanMode: TransparentWalletSnapshot['scanMode'];
  addresses: ScannedAddress[];
  gapLimit: number | null;
  coverage: ScanCoverage[];
}): TransparentWalletSnapshot => {
  const identities = new Set<string>();
  for (const address of addresses) {
    const identity = addressIdentity(address);
    if (identities.has(identity)) {
      throw new TransparentSnapshotIntegrityError(`duplicate address owner ${identity}`);
    }
    identities.add(identity);
  }

  const sortedAddresses = [...addresses].sort(compareAddresses);
  const usedAddresses = sortedAddresses.filter((address) => address.used);
  const utxoMap = new Map<string, ElectrumUtxo>();
  const historyMap = new Map<string, ElectrumHistoryEntry>();

  for (const address of usedAddresses) {
    for (const utxo of address.utxos) {
      const outpoint = `${utxo.txid}:${utxo.vout}`;
      const existing = utxoMap.get(outpoint);
      if (
        existing &&
        (existing.address !== utxo.address ||
          existing.valueSats !== utxo.valueSats ||
          existing.height !== utxo.height)
      ) {
        throw new TransparentSnapshotIntegrityError(
          `Electrum returned conflicting data for ${outpoint}`,
        );
      }
      utxoMap.set(outpoint, utxo);
    }

    for (const entry of address.history) {
      const existing = historyMap.get(entry.txid);
      if (
        !existing ||
        entry.height > existing.height ||
        (entry.height === existing.height && entry.address < existing.address)
      ) {
        historyMap.set(entry.txid, entry);
      }
    }
  }

  const confirmedSats = sortedAddresses.reduce(
    (total, address) => safeAdd(total, address.balance.confirmedSats, 'confirmed balance'),
    0,
  );
  const unconfirmedSats = sortedAddresses.reduce(
    (total, address) =>
      safeAdd(total, address.balance.unconfirmedSats, 'unconfirmed balance'),
    0,
  );
  const balanceSats = safeAdd(confirmedSats, unconfirmedSats, 'aggregate balance');
  if (balanceSats < 0) {
    throw new TransparentSnapshotIntegrityError('aggregate balance is negative');
  }
  const utxos = [...utxoMap.values()];
  const spendableSats = utxos
    .filter(isTransparentUtxoSpendable)
    .reduce(
      (total, utxo) => safeAdd(total, utxo.valueSats, 'spendable balance'),
      0,
    );
  const spendableAddresses = usedAddresses.filter((address) =>
    address.utxos.some(isTransparentUtxoSpendable),
  );
  const immatureCoinbase = getImmatureCoinbaseSummary(utxos);

  return {
    schemaVersion: 1,
    sourceKind,
    scanMode,
    confirmedSats,
    unconfirmedSats,
    balanceSats,
    spendableSats,
    immatureCoinbaseSats: immatureCoinbase.amountSats,
    immatureCoinbaseBlocksRemaining: immatureCoinbase.blocksRemaining,
    utxos,
    history: normalizeWalletHistory([...historyMap.values()]),
    addresses: sortedAddresses,
    usedAddresses,
    spendableAddresses,
    gapLimit,
    coverage,
    scannedAt: new Date().toISOString(),
  };
};

export const rebuildTransparentWalletSnapshot = (
  snapshot: TransparentWalletSnapshot,
  addresses: readonly ScannedAddress[],
): TransparentWalletSnapshot =>
  buildSnapshot({
    sourceKind: snapshot.sourceKind,
    scanMode: snapshot.scanMode,
    addresses: [...addresses],
    gapLimit: snapshot.gapLimit,
    coverage: snapshot.coverage,
  });

const validateBalanceForAddress = (balance: ElectrumBalance) => {
  if (
    !Number.isSafeInteger(balance.confirmedSats) ||
    balance.confirmedSats < 0 ||
    !Number.isSafeInteger(balance.unconfirmedSats) ||
    !Number.isSafeInteger(balance.totalSats) ||
    balance.totalSats < 0 ||
    balance.confirmedSats + balance.unconfirmedSats !== balance.totalSats
  ) {
    throw new TransparentSnapshotIntegrityError('Electrum returned an invalid balance');
  }
};

const validateAddressHistory = (
  address: string,
  history: ElectrumHistoryEntry[],
) => {
  for (const entry of history) {
    if (
      !/^[0-9a-f]{64}$/iu.test(entry.txid) ||
      !Number.isSafeInteger(entry.height) ||
      entry.height < -1 ||
      entry.address !== address
    ) {
      throw new TransparentSnapshotIntegrityError(
        `Electrum returned invalid history for ${address}`,
      );
    }
  }
};

const validateAddressUtxos = (address: string, utxos: ElectrumUtxo[]) => {
  for (const utxo of utxos) {
    if (
      !/^[0-9a-f]{64}$/iu.test(utxo.txid) ||
      !Number.isSafeInteger(utxo.vout) ||
      utxo.vout < 0 ||
      !Number.isSafeInteger(utxo.valueSats) ||
      utxo.valueSats < 0 ||
      !Number.isSafeInteger(utxo.height) ||
      utxo.height < 0 ||
      !Number.isSafeInteger(utxo.confirmations) ||
      utxo.confirmations < 0 ||
      utxo.address !== address
    ) {
      throw new TransparentSnapshotIntegrityError(
        `Electrum returned invalid UTXO data for ${address}`,
      );
    }
  }
};

const hydrateLegacyUtxos = async (
  utxos: ElectrumUtxo[],
  electrum: ElectrumReader,
  runNetworkTask: NetworkTaskRunner,
  control: ScanControl,
) => {
  if (!electrum.getTransactionHex || utxos.length === 0) return utxos;

  return mapWithConcurrency(
    utxos,
    SCAN_COLLECTION_CONCURRENCY,
    async (utxo) => {
      control.check();
      const rawTx = await runNetworkTask(() => electrum.getTransactionHex!(utxo.txid));
      control.check();
      return { ...utxo, rawTx };
    },
  );
};

const scanAddressUnchecked = async (
  derived: WalletAddress,
  electrum: ElectrumReader,
  includeHistory: boolean,
  runNetworkTask: NetworkTaskRunner,
  control: ScanControl,
  progress?: ScanProgressTracker,
  previousAddress?: ScannedAddress,
  sequenceKey?: string,
  branch?: HdBranch,
): Promise<ScannedAddress> => {
  const [addressHistory, reportedBalance] = await Promise.all([
    readElectrumWithRetry({
      address: derived.address,
      operation: 'history',
      read: () => runNetworkTask(() => electrum.getAddressHistory(derived.address)),
      control,
    }),
    readElectrumWithRetry({
      address: derived.address,
      operation: 'balance',
      read: () => runNetworkTask(() => electrum.getAddressBalance(derived.address)),
      control,
    }),
  ] as const);
  validateAddressHistory(derived.address, addressHistory);
  validateBalanceForAddress(reportedBalance);
  const history = addressHistory;
  const serverBalance = reportedBalance;
  const used = history.length > 0 || serverBalance.totalSats !== 0;

  if (!used) {
    progress?.complete(sequenceKey, branch);
    return {
      ...derived,
      balance: { confirmedSats: 0, unconfirmedSats: 0, totalSats: 0 },
      utxos: [],
      history: [],
      used: false,
    };
  }

  const baseUtxos = await readElectrumWithRetry({
    address: derived.address,
    operation: 'utxos',
    read: () => runNetworkTask(() => electrum.getAddressUtxos(derived.address)),
    control,
  });
  validateAddressUtxos(derived.address, baseUtxos);
  const hydratedUtxos =
    derived.scriptType === 'p2pkh'
      ? await hydrateLegacyUtxos(baseUtxos, electrum, runNetworkTask, control)
      : baseUtxos;
  const utxos = await annotateCoinbaseMaturity(
    hydratedUtxos,
    previousAddress?.utxos ?? [],
    async (txid) => {
      const cached = hydratedUtxos.find((utxo) => utxo.txid === txid)?.rawTx;
      if (cached) return cached;
      if (!electrum.getTransactionHex) {
        throw new Error('Transaction lookup unavailable for coinbase classification.');
      }
      control.check();
      return runNetworkTask(() => electrum.getTransactionHex!(txid));
    },
  );
  const confirmedSats = utxos
    .filter((utxo) => utxo.confirmations > 0)
    .reduce(
      (total, utxo) => safeAdd(total, utxo.valueSats, 'address confirmed balance'),
      0,
    );
  const unconfirmedSats = utxos
    .filter((utxo) => utxo.confirmations <= 0)
    .reduce(
      (total, utxo) => safeAdd(total, utxo.valueSats, 'address unconfirmed balance'),
      0,
    );
  const totalSats = safeAdd(confirmedSats, unconfirmedSats, 'address balance');
  if (serverBalance.totalSats !== totalSats) {
    throw new TransparentSnapshotIntegrityError(
      `balance/listunspent mismatch for ${derived.address}`,
    );
  }
  const balance: ElectrumBalance = { confirmedSats, unconfirmedSats, totalSats };
  const spendableUtxoTxids = new Set(
    utxos.filter(isTransparentUtxoSpendable).map((utxo) => utxo.txid),
  );
  const currentHistory = includeHistory
    ? history
    : history.filter((entry) => spendableUtxoTxids.has(entry.txid));
  const retainedHistory = mergeWalletHistoryPublication(
    previousAddress?.history ?? [],
    currentHistory,
    'authoritative',
  );
  progress?.complete(sequenceKey, branch);
  return { ...derived, balance, utxos, history: retainedHistory, used };
};

const scanAddress = (
  derived: WalletAddress,
  electrum: ElectrumReader,
  includeHistory: boolean,
  runNetworkTask: NetworkTaskRunner,
  control: ScanControl,
  progress?: ScanProgressTracker,
  previousAddress?: ScannedAddress,
  sequenceKey?: string,
  branch?: HdBranch,
): Promise<ScannedAddress> => {
  try {
    control.check();
  } catch (caught) {
    return Promise.reject(caught);
  }
  return scanAddressUnchecked(
    derived,
    electrum,
    includeHistory,
    runNetworkTask,
    control,
    progress,
    previousAddress,
    sequenceKey,
    branch,
  ).catch((caught) => {
    control.fail(caught);
    throw caught;
  });
};

const trailingUnusedCount = (addresses: readonly ScannedAddress[]) => {
  let count = 0;
  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    const address = addresses[index];
    if (!address || address.used) break;
    count += 1;
  }
  return count;
};

const createGapCoverage = (
  template: HdScanTemplate,
  branch: HdBranch,
  addresses: readonly ScannedAddress[],
  gapLimit: number,
): HdGapCoverage => {
  const hdAddresses = addresses.filter(
    (address): address is ScannedAddress & HdWalletAddress => address.ownerKind === 'hd',
  );
  const highestScannedIndex = hdAddresses.at(-1)?.index ?? -1;
  const lastUsedIndex = hdAddresses.reduce(
    (last, address) => (address.used ? address.index : last),
    -1,
  );
  const trailingUnused = trailingUnusedCount(hdAddresses);
  if (trailingUnused < gapLimit) {
    throw new TransparentSnapshotIntegrityError(
      `gap coverage for ${template.sequenceKey}/${branch} is incomplete`,
    );
  }
  return {
    mode: 'gap',
    sequenceKey: template.sequenceKey,
    account: template.account,
    accountKey: template.key,
    branch,
    highestScannedIndex,
    lastUsedIndex,
    trailingUnused,
    gapLimit,
    complete: true,
  };
};

type BranchScanResult = {
  addresses: ScannedAddress[];
  coverage: HdGapCoverage;
};

const scanHdBranch = async (
  sessionId: string,
  template: HdScanTemplate,
  branch: HdBranch,
  electrum: ElectrumReader,
  gapLimit: number,
  includeHistory: boolean,
  deriveAddresses: HdAddressDeriver,
  runNetworkTask: NetworkTaskRunner,
  control: ScanControl,
  highestIssuedIndex: number,
  progress?: ScanProgressTracker,
  previousSnapshot?: TransparentWalletSnapshot,
): Promise<BranchScanResult> => {
  const addresses: ScannedAddress[] = [];
  const allPreviousBranch =
    previousSnapshot?.addresses
      .filter(
        (address): address is ScannedAddress & HdWalletAddress =>
          address.ownerKind === 'hd' &&
          address.account === template.account &&
          address.accountKey === template.key &&
          address.branch === branch,
      )
      .sort((left, right) => left.index - right.index) ?? [];

  const previousByIndex = new Map<number, ScannedAddress & HdWalletAddress>();
  for (const address of allPreviousBranch) {
    if (
      previousByIndex.has(address.index) ||
      address.path !== deriveHdPath(template, branch, address.index) ||
      address.scriptType !== template.scriptType
    ) {
      throw new TransparentSnapshotIntegrityError(
        `previous coverage for ${template.sequenceKey}/${branch} is invalid`,
      );
    }
    previousByIndex.set(address.index, address);
  }
  const previousGap: Array<ScannedAddress & HdWalletAddress> = [];
  while (previousByIndex.has(previousGap.length)) {
    previousGap.push(previousByIndex.get(previousGap.length)!);
  }
  const previousRecovery = allPreviousBranch.filter(
    (address) => address.index >= previousGap.length,
  );
  const recoveryToRefresh = previousRecovery.filter(
    (address) =>
      address.used || address.utxos.length > 0 || address.balance.totalSats !== 0,
  );
  const recoveryRefreshSet = new Set(recoveryToRefresh.map((address) => address.path));
  const retainedRecovery = previousRecovery.filter(
    (address) => !recoveryRefreshSet.has(address.path),
  );

  let nextIndex = previousGap.length;
  if (previousGap.length > 0 || recoveryToRefresh.length > 0) {
    progress?.reserve(
      previousGap.length + recoveryToRefresh.length,
      template.sequenceKey,
      branch,
    );
    const refreshed = await mapWithConcurrency(
      [...previousGap, ...recoveryToRefresh],
      SCAN_COLLECTION_CONCURRENCY,
      (address) =>
        scanAddress(
          address,
          electrum,
          includeHistory,
          runNetworkTask,
          control,
          progress,
          address,
          template.sequenceKey,
          branch,
        ),
    );
    const refreshedGap = refreshed.slice(0, previousGap.length);
    const refreshedRecovery = refreshed.slice(previousGap.length);
    addresses.push(...refreshedGap, ...retainedRecovery, ...refreshedRecovery);
    if (
      previousGap.length > 0 &&
      trailingUnusedCount(refreshedGap) >= gapLimit &&
      previousGap.length - 1 >= highestIssuedIndex
    ) {
      return {
        addresses,
        coverage: createGapCoverage(template, branch, refreshedGap, gapLimit),
      };
    }
  }

  const gapAddresses = addresses.filter(
    (address) =>
      address.ownerKind === 'hd' && address.index < nextIndex,
  );
  let consecutiveUnused = trailingUnusedCount(gapAddresses);
  while (consecutiveUnused < gapLimit || nextIndex <= highestIssuedIndex) {
    control.check();
    const remainingForGap = Math.max(0, gapLimit - consecutiveUnused);
    const remainingForIssued = Math.max(0, highestIssuedIndex - nextIndex + 1);
    const batchSize = Math.min(
      SCAN_BATCH_SIZE,
      Math.max(remainingForGap, remainingForIssued),
    );
    const lastBatchIndex = nextIndex + batchSize - 1;
    if (lastBatchIndex > LEGACY_ACCOUNT_ONE_MAX_ALLOCATED_INDEX) {
      throw new TransparentScanRangeExhaustedError(template.sequenceKey, branch);
    }
    const indices = Array.from({ length: batchSize }, (_, offset) => nextIndex + offset);
    const derivedBatch = await deriveAddressBatch(
      sessionId,
      template,
      branch,
      indices,
      deriveAddresses,
      control,
    );
    progress?.reserve(derivedBatch.length, template.sequenceKey, branch);
    const scannedBatch = await settleAll(
      derivedBatch.map((derived) =>
        scanAddress(
          derived,
          electrum,
          includeHistory,
          runNetworkTask,
          control,
          progress,
          undefined,
          template.sequenceKey,
          branch,
        ),
      ),
    );
    addresses.push(...scannedBatch);
    gapAddresses.push(...scannedBatch);
    const lastUsedOffset = scannedBatch.reduce(
      (last, address, offset) => (address.used ? offset : last),
      -1,
    );
    consecutiveUnused =
      lastUsedOffset === -1
        ? consecutiveUnused + scannedBatch.length
        : scannedBatch.length - lastUsedOffset - 1;
    nextIndex += scannedBatch.length;
  }

  const sorted = [...new Map(addresses.map((address) => [addressIdentity(address), address])).values()]
    .sort((left, right) => {
    if (left.ownerKind !== 'hd' || right.ownerKind !== 'hd') return 0;
    return left.index - right.index;
  });
  return {
    addresses: sorted,
    coverage: createGapCoverage(template, branch, gapAddresses, gapLimit),
  };
};

export const scanTransparentHdWallet = async ({
  sessionId,
  sourceKind,
  electrum,
  deriveAddresses,
  gapLimit = DEFAULT_HD_GAP_LIMIT,
  includeHistory = true,
  previousSnapshot,
  issuedAddresses = [],
  onProgress,
  signal,
  maxConcurrentNetworkRequests = SCAN_NETWORK_CONCURRENCY,
}: {
  sessionId: string;
  sourceKind: HdSourceKind;
  electrum: ElectrumReader;
  deriveAddresses: HdAddressDeriver;
  gapLimit?: number;
  includeHistory?: boolean;
  previousSnapshot?: TransparentWalletSnapshot | null;
  issuedAddresses?: readonly HdScanRequirement[];
  onProgress?: TransparentScanProgressListener;
  signal?: AbortSignal;
  maxConcurrentNetworkRequests?: number;
}): Promise<TransparentWalletSnapshot> => {
  if (sessionId.trim() === '') throw new Error('A crypto session is required for HD scan.');
  validateGapLimit(gapLimit);
  const issuedRequirements = normalizeIssuedRequirements(issuedAddresses);
  if (
    previousSnapshot &&
    (previousSnapshot.scanMode === 'single-key' ||
      previousSnapshot.sourceKind !== sourceKind)
  ) {
    throw new TransparentSnapshotIntegrityError(
      'previous snapshot does not match this HD gap scan',
    );
  }

  const control = createScanControl(signal);
  control.check();
  const networkLimiter = createConcurrencyLimiter(maxConcurrentNetworkRequests);
  const runNetworkTask: NetworkTaskRunner = (task) =>
    networkLimiter.run(() => {
      control.check();
      return task();
    });
  const progress = createScanProgressTracker(onProgress);
  const branchTasks = HD_SCAN_TEMPLATES.flatMap((template) =>
    (['external', 'internal'] as const).map((branch) =>
      scanHdBranch(
        sessionId,
        template,
        branch,
        electrum,
        gapLimit,
        includeHistory,
        deriveAddresses,
        runNetworkTask,
        control,
        issuedRequirements.get(
          issuedRequirementKey({
            account: template.account,
            accountKey: template.key,
            branch,
          }),
        ) ?? -1,
        progress,
        previousSnapshot ?? undefined,
      ).catch((caught) => {
        control.fail(caught);
        throw caught;
      }),
    ),
  );
  const results = await settleAll(branchTasks);
  control.check();
  const addresses = results.flatMap((result) => result.addresses);
  progress?.finish(addresses.length);
  const recoveryCoverage =
    previousSnapshot?.coverage.filter((coverage) => coverage.mode === 'explicit-range') ?? [];
  return buildSnapshot({
    sourceKind,
    scanMode: recoveryCoverage.length > 0 ? 'gap-with-recovery' : 'gap',
    addresses,
    gapLimit,
    coverage: [...results.map((result) => result.coverage), ...recoveryCoverage],
  });
};

export const scanSingleKeyWallet = async ({
  addresses,
  electrum,
  includeHistory = true,
  previousSnapshot,
  onProgress,
  signal,
  maxConcurrentNetworkRequests = SCAN_NETWORK_CONCURRENCY,
}: {
  addresses: SingleKeyAddress[];
  electrum: ElectrumReader;
  includeHistory?: boolean;
  previousSnapshot?: TransparentWalletSnapshot | null;
  onProgress?: TransparentScanProgressListener;
  signal?: AbortSignal;
  maxConcurrentNetworkRequests?: number;
}): Promise<TransparentWalletSnapshot> => {
  if (addresses.length < 1 || addresses.length > 4) {
    throw new Error('A single-key scan requires between one and four address encodings.');
  }
  if (
    previousSnapshot &&
    (previousSnapshot.scanMode !== 'single-key' ||
      previousSnapshot.sourceKind !== 'single-private-key')
  ) {
    throw new TransparentSnapshotIntegrityError(
      'previous snapshot does not match this single-key scan',
    );
  }

  const uniqueAddresses = new Set<string>();
  const derived: SingleKeyWalletAddress[] = addresses.map((address, keyAddressIndex) => {
    validatePublicAddressMaterial(address, address.scriptType);
    if (uniqueAddresses.has(address.address)) {
      throw new TransparentSnapshotIntegrityError('single-key address is duplicated');
    }
    uniqueAddresses.add(address.address);
    return {
      ownerKind: 'single-key',
      keyAddressIndex,
      scriptType: address.scriptType,
      publicKeyCompressed: address.publicKeyCompressed,
      address: address.address,
      publicKeyHex: address.publicKeyHex,
      scriptHex: address.scriptHex,
      ...(address.redeemScriptHex ? { redeemScriptHex: address.redeemScriptHex } : {}),
      ...(address.tapInternalKeyHex
        ? { tapInternalKeyHex: address.tapInternalKeyHex }
        : {}),
    };
  });
  const previousByIdentity = new Map(
    previousSnapshot?.addresses.map((address) => [addressIdentity(address), address]) ?? [],
  );
  const control = createScanControl(signal);
  control.check();
  const networkLimiter = createConcurrencyLimiter(maxConcurrentNetworkRequests);
  const runNetworkTask: NetworkTaskRunner = (task) =>
    networkLimiter.run(() => {
      control.check();
      return task();
    });
  const progress = createScanProgressTracker(onProgress);
  progress?.reserve(derived.length);
  const scanned = await mapWithConcurrency(
    derived,
    SCAN_COLLECTION_CONCURRENCY,
    (address) =>
      scanAddress(
        address,
        electrum,
        includeHistory,
        runNetworkTask,
        control,
        progress,
        previousByIdentity.get(addressIdentity(address)),
      ),
  );
  control.check();
  progress?.finish(scanned.length);
  return buildSnapshot({
    sourceKind: 'single-private-key',
    scanMode: 'single-key',
    addresses: scanned,
    gapLimit: null,
    coverage: [{ mode: 'single-key', addressCount: scanned.length, complete: true }],
  });
};

/**
 * Reconciles a known subset of an already complete in-memory snapshot.
 *
 * This deliberately does not discover new HD indexes: callers may use it for
 * address-status notifications, pending confirmations and coinbase maturity,
 * while a normal gap scan remains the authority for discovery coverage.
 */
export const refreshTransparentWalletSnapshot = async ({
  snapshot,
  addresses,
  electrum,
  includeHistory = true,
  signal,
  maxConcurrentNetworkRequests = SCAN_NETWORK_CONCURRENCY,
}: {
  snapshot: TransparentWalletSnapshot;
  addresses: readonly string[];
  electrum: ElectrumReader;
  includeHistory?: boolean;
  signal?: AbortSignal;
  maxConcurrentNetworkRequests?: number;
}): Promise<TransparentWalletSnapshot> => {
  const requested = new Set(addresses);
  if (requested.size === 0) return snapshot;

  const previousByAddress = new Map(
    snapshot.addresses.map((address) => [address.address, address] as const),
  );
  for (const address of requested) {
    if (!previousByAddress.has(address)) {
      throw new TransparentSnapshotIntegrityError(
        'targeted refresh requested an address outside the scanned snapshot',
      );
    }
  }

  const control = createScanControl(signal);
  control.check();
  const networkLimiter = createConcurrencyLimiter(maxConcurrentNetworkRequests);
  const runNetworkTask: NetworkTaskRunner = (task) =>
    networkLimiter.run(() => {
      control.check();
      return task();
    });
  const targets = snapshot.addresses.filter((address) => requested.has(address.address));
  const refreshed = await mapWithConcurrency(
    targets,
    SCAN_COLLECTION_CONCURRENCY,
    (address) =>
      scanAddress(
        address,
        electrum,
        includeHistory,
        runNetworkTask,
        control,
        undefined,
        address,
      ),
  );
  control.check();

  const refreshedByIdentity = new Map(
    refreshed.map((address) => [addressIdentity(address), address] as const),
  );
  return buildSnapshot({
    sourceKind: snapshot.sourceKind,
    scanMode: snapshot.scanMode,
    addresses: snapshot.addresses.map(
      (address) => refreshedByIdentity.get(addressIdentity(address)) ?? address,
    ),
    gapLimit: snapshot.gapLimit,
    coverage: snapshot.coverage,
  });
};

export type DeepRecoveryRange = Readonly<{
  account: 0 | 1;
  accountKey: HdAccountTemplate['key'];
  branch: HdBranch;
  fromIndex: number;
  toIndex: number;
}>;

const RECOVERY_DERIVATION_BATCH_SIZE = 50;
const MAX_EXPLICIT_RECOVERY_ADDRESSES_PER_RUN = 10_000;

const mergeExplicitRangeCoverage = (
  coverage: readonly ExplicitRangeCoverage[],
): ExplicitRangeCoverage[] => {
  const groups = new Map<string, ExplicitRangeCoverage[]>();
  for (const item of coverage) {
    const key = `${item.sequenceKey}:${item.branch}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap((group) => {
    const sorted = [...group].sort(
      (left, right) => left.fromIndex - right.fromIndex || left.toIndex - right.toIndex,
    );
    const merged: ExplicitRangeCoverage[] = [];
    for (const item of sorted) {
      const previous = merged.at(-1);
      if (previous && item.fromIndex <= previous.toIndex + 1) {
        previous.toIndex = Math.max(previous.toIndex, item.toIndex);
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  });
};

const resolveRecoveryTemplate = (range: DeepRecoveryRange) => {
  const template = HD_SCAN_TEMPLATES.find(
    (candidate) =>
      candidate.account === range.account && candidate.key === range.accountKey,
  );
  if (!template) {
    throw new Error(`Unknown HD recovery account/family: ${range.account}/${range.accountKey}.`);
  }
  return template;
};

export const scanTransparentHdRecoveryRanges = async ({
  sessionId,
  sourceKind,
  ranges,
  electrum,
  deriveAddresses,
  baseSnapshot,
  includeHistory = true,
  onProgress,
  signal,
  maxConcurrentNetworkRequests = SCAN_NETWORK_CONCURRENCY,
}: {
  sessionId: string;
  sourceKind: HdSourceKind;
  ranges: readonly DeepRecoveryRange[];
  electrum: ElectrumReader;
  deriveAddresses: HdAddressDeriver;
  baseSnapshot?: TransparentWalletSnapshot | null;
  includeHistory?: boolean;
  onProgress?: TransparentScanProgressListener;
  signal?: AbortSignal;
  maxConcurrentNetworkRequests?: number;
}): Promise<TransparentWalletSnapshot> => {
  if (sessionId.trim() === '') throw new Error('A crypto session is required for HD recovery.');
  if (ranges.length === 0) throw new Error('At least one HD recovery range is required.');
  if (baseSnapshot && baseSnapshot.sourceKind !== sourceKind) {
    throw new TransparentSnapshotIntegrityError(
      'base snapshot does not match this HD recovery',
    );
  }

  let requestedAddressCount = 0;
  const normalizedRanges = ranges.map((range) => {
    validateIndex(range.fromIndex, 'Recovery start index');
    validateIndex(range.toIndex, 'Recovery end index');
    if (range.fromIndex > range.toIndex) {
      throw new Error('Recovery start index must not exceed the end index.');
    }
    requestedAddressCount += range.toIndex - range.fromIndex + 1;
    return { range, template: resolveRecoveryTemplate(range) };
  });
  if (requestedAddressCount > MAX_EXPLICIT_RECOVERY_ADDRESSES_PER_RUN) {
    throw new Error(
      `One recovery run is limited to ${MAX_EXPLICIT_RECOVERY_ADDRESSES_PER_RUN} addresses.`,
    );
  }

  const rangeIdentities = new Set<string>();
  for (const { range, template } of normalizedRanges) {
    for (let index = range.fromIndex; index <= range.toIndex; index += 1) {
      const identity = deriveHdPath(template, range.branch, index);
      if (rangeIdentities.has(identity)) {
        throw new Error(`Recovery ranges overlap at ${identity}.`);
      }
      rangeIdentities.add(identity);
    }
  }

  const control = createScanControl(signal);
  control.check();
  const networkLimiter = createConcurrencyLimiter(maxConcurrentNetworkRequests);
  const runNetworkTask: NetworkTaskRunner = (task) =>
    networkLimiter.run(() => {
      control.check();
      return task();
    });
  const progress = createScanProgressTracker(onProgress);
  const existingByIdentity = new Map(
    baseSnapshot?.addresses.map((address) => [addressIdentity(address), address]) ?? [],
  );
  const recovered: ScannedAddress[] = [];
  const explicitCoverage: ExplicitRangeCoverage[] = [];

  for (const { range, template } of normalizedRanges) {
    for (
      let batchStart = range.fromIndex;
      batchStart <= range.toIndex;
      batchStart += RECOVERY_DERIVATION_BATCH_SIZE
    ) {
      control.check();
      const batchEnd = Math.min(
        range.toIndex,
        batchStart + RECOVERY_DERIVATION_BATCH_SIZE - 1,
      );
      const indices = Array.from(
        { length: batchEnd - batchStart + 1 },
        (_, offset) => batchStart + offset,
      );
      const derived = await deriveAddressBatch(
        sessionId,
        template,
        range.branch,
        indices,
        deriveAddresses,
        control,
      );
      progress?.reserve(derived.length, template.sequenceKey, range.branch);
      const scanned = await mapWithConcurrency(
        derived,
        SCAN_COLLECTION_CONCURRENCY,
        (address) =>
          scanAddress(
            address,
            electrum,
            includeHistory,
            runNetworkTask,
            control,
            progress,
            existingByIdentity.get(addressIdentity(address)),
            template.sequenceKey,
            range.branch,
          ),
      );
      recovered.push(...scanned);
    }
    explicitCoverage.push({
      mode: 'explicit-range',
      sequenceKey: template.sequenceKey,
      account: template.account,
      accountKey: template.key,
      branch: range.branch,
      fromIndex: range.fromIndex,
      toIndex: range.toIndex,
      complete: true,
    });
  }

  control.check();
  const mergedByIdentity = new Map(
    baseSnapshot?.addresses.map((address) => [addressIdentity(address), address]) ?? [],
  );
  for (const address of recovered) mergedByIdentity.set(addressIdentity(address), address);
  progress?.finish(recovered.length);
  const baseHasGapCoverage = baseSnapshot?.coverage.some(
    (coverage) => coverage.mode === 'gap',
  ) ?? false;
  const gapCoverage =
    baseSnapshot?.coverage.filter((coverage) => coverage.mode === 'gap') ?? [];
  const mergedExplicitCoverage = mergeExplicitRangeCoverage([
    ...(baseSnapshot?.coverage.filter(
      (coverage): coverage is ExplicitRangeCoverage =>
        coverage.mode === 'explicit-range',
    ) ?? []),
    ...explicitCoverage,
  ]);
  return buildSnapshot({
    sourceKind,
    scanMode: baseHasGapCoverage ? 'gap-with-recovery' : 'explicit-range',
    addresses: [...mergedByIdentity.values()],
    gapLimit: baseSnapshot?.gapLimit ?? null,
    coverage: [...gapCoverage, ...mergedExplicitCoverage],
  });
};
