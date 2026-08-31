import { sha256 } from '@noble/hashes/sha2.js';
import * as btc from '@scure/btc-signer';
import { bech32, bech32m } from 'bech32';

import {
  NITO_ELECTRUM_SERVERS,
  type ElectrumServer,
} from './electrumServers';

export { NITO_ELECTRUM_SERVERS } from './electrumServers';

const ELECTRUM_PROTOCOL_VERSION = '1.4';
const DEFAULT_TIMEOUT_MS = 30_000;
const ELECTRUM_REQUEST_MAX_ATTEMPTS = 3;
const ELECTRUM_REQUEST_RETRY_DELAY_MS = 100;
const ELECTRUM_RECONNECT_MAX_DELAY_MS = 10_000;
export const DEFAULT_ELECTRUM_MAX_CONCURRENT_REQUESTS = 6;
export const ELECTRUM_MAX_MESSAGE_CHARACTERS = 8 * 1024 * 1024;
export const ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS = 200_000;
export const ELECTRUM_MAX_COLLECTION_ENTRIES = 100_000;

export type ElectrumBalance = {
  confirmedSats: number;
  unconfirmedSats: number;
  totalSats: number;
};

export type ElectrumUtxo = {
  txid: string;
  vout: number;
  valueSats: number;
  height: number;
  address: string;
  confirmations: number;
  isCoinbase?: boolean;
  rawTx?: string;
};

export type ElectrumHistoryEntry = {
  txid: string;
  height: number;
  address: string;
  direction?: 'sent' | 'received' | 'self';
  counterparty?: string;
  amountSats?: number;
  feeSats?: number;
  blockTime?: number;
  provisional?: boolean;
};

export type ElectrumVerboseTransaction = {
  txid?: string;
  time?: number;
  blocktime?: number;
  vin: {
    txid?: string;
    vout?: number;
    coinbase?: string;
  }[];
  vout: {
    n?: number;
    value: number | string;
    scriptPubKey?: {
      address?: string;
      addresses?: string[];
    };
  }[];
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type QueuedRequest = {
  queuedAt: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type ElectrumRequestMetrics = Readonly<{
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  peakInFlight: number;
  maxQueueDepth: number;
  totalQueueWaitMs: number;
}>;

export type NitoElectrumClientOptions = {
  timeoutMs?: number;
  maxConcurrentRequests?: number;
  reconnectDelayMs?: number;
};

export class ElectrumSessionUnhealthyError extends Error {
  readonly originalError: Error;

  constructor(cause: unknown) {
    const originalError = cause instanceof Error ? cause : new Error(String(cause));
    super(originalError.message);
    this.name = 'ElectrumSessionUnhealthyError';
    this.originalError = originalError;
  }
}

export class ElectrumInvalidResponseError extends Error {
  constructor(method: string, detail: string) {
    super(`ElectrumX returned an invalid ${method} response: ${detail}.`);
    this.name = 'ElectrumInvalidResponseError';
  }
}

export class ElectrumRpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'ElectrumRpcError';
    this.code = code;
  }
}

type JsonRpcResponse = {
  id?: number;
  method?: string;
  params?: unknown[];
  result?: unknown;
  error?: { message?: string; code?: number };
};

type ScripthashStatusListener = (status: string | null) => void;
type BlockHeightListener = (height: number, previousHeight: number) => void;
export type ElectrumConnectionState = Readonly<{
  connected: boolean;
  serverUrl: string;
  reconnected: boolean;
  error?: Error;
}>;
type ConnectionStateListener = (state: ElectrumConnectionState) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isSafeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isTxid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
const isTransactionHex = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS &&
  value.length % 2 === 0 &&
  /^[0-9a-f]+$/iu.test(value);
const isSubscriptionStatus = (value: unknown): value is string | null =>
  value === null || isTxid(value);

const validateHeader = (
  value: unknown,
  method = 'blockchain.headers.subscribe',
): { height: number; hex?: string } => {
  if (!isRecord(value) || !isSafeInteger(value.height)) {
    throw new ElectrumInvalidResponseError(
      method,
      'height must be a non-negative safe integer',
    );
  }
  if (
    value.hex !== undefined &&
    (typeof value.hex !== 'string' ||
      value.hex.length === 0 ||
      value.hex.length % 2 !== 0 ||
      !/^[0-9a-f]+$/iu.test(value.hex))
  ) {
    throw new ElectrumInvalidResponseError(
      method,
      'hex must be an even-length hexadecimal string',
    );
  }
  return {
    height: value.height,
    ...(typeof value.hex === 'string' ? { hex: value.hex.toLowerCase() } : {}),
  };
};

const validateBalance = (value: unknown): { confirmed: number; unconfirmed: number } => {
  if (
    !isRecord(value) ||
    !isSafeInteger(value.confirmed) ||
    !isSafeInteger(value.unconfirmed, Number.MIN_SAFE_INTEGER)
  ) {
    throw new ElectrumInvalidResponseError(
      'blockchain.scripthash.get_balance',
      'confirmed and unconfirmed must be safe integers',
    );
  }
  return { confirmed: value.confirmed, unconfirmed: value.unconfirmed };
};

const validateUtxos = (
  value: unknown,
): readonly { tx_hash: string; tx_pos: number; value: number; height: number }[] => {
  if (!Array.isArray(value)) {
    throw new ElectrumInvalidResponseError(
      'blockchain.scripthash.listunspent',
      'result must be an array',
    );
  }
  if (value.length > ELECTRUM_MAX_COLLECTION_ENTRIES) {
    throw new ElectrumInvalidResponseError(
      'blockchain.scripthash.listunspent',
      'result contains too many entries',
    );
  }
  let aggregateValue = 0;
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !isTxid(entry.tx_hash) ||
      !isSafeInteger(entry.tx_pos) ||
      !isSafeInteger(entry.value) ||
      !isSafeInteger(entry.height)
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.scripthash.listunspent',
        `entry ${index} has invalid fields`,
      );
    }
    aggregateValue += entry.value;
    if (!Number.isSafeInteger(aggregateValue)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.scripthash.listunspent',
        'aggregate value exceeds the safe integer range',
      );
    }
    return {
      tx_hash: entry.tx_hash.toLowerCase(),
      tx_pos: entry.tx_pos,
      value: entry.value,
      height: entry.height,
    };
  });
};

const validateHistory = (
  value: unknown,
): readonly { tx_hash: string; height: number }[] => {
  if (!Array.isArray(value)) {
    throw new ElectrumInvalidResponseError(
      'blockchain.scripthash.get_history',
      'result must be an array',
    );
  }
  if (value.length > ELECTRUM_MAX_COLLECTION_ENTRIES) {
    throw new ElectrumInvalidResponseError(
      'blockchain.scripthash.get_history',
      'result contains too many entries',
    );
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !isTxid(entry.tx_hash) ||
      !isSafeInteger(entry.height, -1)
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.scripthash.get_history',
        `entry ${index} has invalid fields`,
      );
    }
    return { tx_hash: entry.tx_hash.toLowerCase(), height: entry.height };
  });
};

const validateVerboseTransaction = (
  value: unknown,
  requestedTxid: string,
): ElectrumVerboseTransaction => {
  if (!isRecord(value) || !Array.isArray(value.vin) || !Array.isArray(value.vout)) {
    throw new ElectrumInvalidResponseError(
      'blockchain.transaction.get',
      `transaction ${requestedTxid} is not an object with vin and vout arrays`,
    );
  }
  if (
    value.vin.length > ELECTRUM_MAX_COLLECTION_ENTRIES ||
    value.vout.length > ELECTRUM_MAX_COLLECTION_ENTRIES
  ) {
    throw new ElectrumInvalidResponseError(
      'blockchain.transaction.get',
      `transaction ${requestedTxid} contains too many inputs or outputs`,
    );
  }
  if (value.txid !== undefined && !isTxid(value.txid)) {
    throw new ElectrumInvalidResponseError(
      'blockchain.transaction.get',
      `transaction ${requestedTxid} has an invalid txid`,
    );
  }
  for (const field of ['time', 'blocktime'] as const) {
    if (value[field] !== undefined && !isSafeInteger(value[field])) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} has an invalid ${field}`,
      );
    }
  }

  const vin = value.vin.map((input, index) => {
    if (!isRecord(input)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} input ${index} is invalid`,
      );
    }
    const coinbase = input.coinbase;
    const inputTxid = input.txid;
    const inputVout = input.vout;
    const hasCoinbase =
      typeof coinbase === 'string' &&
      coinbase.length > 0 &&
      coinbase.length <= ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS &&
      coinbase.length % 2 === 0 &&
      /^[0-9a-f]+$/iu.test(coinbase);
    const hasOutpoint = isTxid(inputTxid) && isSafeInteger(inputVout);
    if (!hasCoinbase && !hasOutpoint) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} input ${index} has no valid outpoint`,
      );
    }
    return {
      ...(hasOutpoint
        ? { txid: (inputTxid as string).toLowerCase(), vout: inputVout as number }
        : {}),
      ...(hasCoinbase ? { coinbase } : {}),
    };
  });

  const vout = value.vout.map((output, index) => {
    if (!isRecord(output)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} is invalid`,
      );
    }
    const numericValue =
      typeof output.value === 'number'
        ? output.value
        : typeof output.value === 'string' && output.value.trim() !== ''
          ? Number(output.value)
          : Number.NaN;
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} has an invalid value`,
      );
    }
    if (!Number.isSafeInteger(Math.round(numericValue * 100_000_000))) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} exceeds the safe integer range`,
      );
    }
    if (output.n !== undefined && !isSafeInteger(output.n)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} has an invalid index`,
      );
    }
    if (output.scriptPubKey !== undefined && !isRecord(output.scriptPubKey)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} has an invalid script`,
      );
    }
    const scriptPubKey = output.scriptPubKey as Record<string, unknown> | undefined;
    if (
      scriptPubKey?.address !== undefined &&
      (typeof scriptPubKey.address !== 'string' ||
        scriptPubKey.address.length === 0 ||
        scriptPubKey.address.length > 128)
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} has an invalid address`,
      );
    }
    if (
      scriptPubKey?.addresses !== undefined &&
      (!Array.isArray(scriptPubKey.addresses) ||
        scriptPubKey.addresses.length > ELECTRUM_MAX_COLLECTION_ENTRIES ||
        scriptPubKey.addresses.some(
          (address) =>
            typeof address !== 'string' || address.length === 0 || address.length > 128,
        ))
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${requestedTxid} output ${index} has invalid addresses`,
      );
    }
    return {
      ...(isSafeInteger(output.n) ? { n: output.n } : {}),
      value: output.value as number | string,
      ...(scriptPubKey
        ? {
            scriptPubKey: {
              ...(typeof scriptPubKey.address === 'string'
                ? { address: scriptPubKey.address }
                : {}),
              ...(Array.isArray(scriptPubKey.addresses)
                ? { addresses: scriptPubKey.addresses as string[] }
                : {}),
            },
          }
        : {}),
    };
  });

  return {
    ...(typeof value.txid === 'string' ? { txid: value.txid.toLowerCase() } : {}),
    ...(typeof value.time === 'number' ? { time: value.time } : {}),
    ...(typeof value.blocktime === 'number' ? { blocktime: value.blocktime } : {}),
    vin,
    vout,
  };
};

export const isElectrumTransactionNotFoundError = (error: unknown): boolean =>
  error instanceof ElectrumRpcError &&
  /no such mempool|not found|unknown transaction|transaction.*unknown/iu.test(error.message);

const NITO_ADDRESS_NETWORK = {
  bech32: 'nito',
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4,
  },
};

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const concatBytes = (...chunks: Uint8Array[]) => {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
};

const opForWitnessVersion = (version: number) => {
  if (version === 0) return 0x00;
  if (version >= 1 && version <= 16) return 0x50 + version;
  throw new Error(`Unsupported witness version: ${version}`);
};

export const scriptPubKeyForNitoAddress = (address: string) => {
  const normalized = address.trim();
  const lower = normalized.toLowerCase();

  if (!lower.startsWith('nito1')) {
    const decoded = btc.Address(NITO_ADDRESS_NETWORK).decode(normalized);

    if (decoded && decoded.type === 'pkh' && 'hash' in decoded) {
      const hash = Uint8Array.from(decoded.hash);
      return concatBytes(
        Uint8Array.from([0x76, 0xa9, 0x14]),
        hash,
        Uint8Array.from([0x88, 0xac]),
      );
    }

    if (decoded && decoded.type === 'sh' && 'hash' in decoded) {
      const hash = Uint8Array.from(decoded.hash);
      return concatBytes(Uint8Array.from([0xa9, 0x14]), hash, Uint8Array.from([0x87]));
    }

    throw new Error('Unsupported Nito address.');
  }

  if (!lower.startsWith('nito1q') && !lower.startsWith('nito1p')) {
    throw new Error('Private address unavailable in this public version.');
  }

  if (normalized !== lower && normalized !== normalized.toUpperCase()) {
    throw new Error('A mixed-case Bech32 address is invalid.');
  }

  const decoded = lower.startsWith('nito1p') ? bech32m.decode(lower) : bech32.decode(lower);

  if (decoded.prefix !== 'nito') {
    throw new Error(`Unexpected Bech32 prefix: ${decoded.prefix}`);
  }

  const [version, ...programWords] = decoded.words;
  if (typeof version !== 'number') {
    throw new Error('Witness version is missing.');
  }

  const program = Uint8Array.from(bech32.fromWords(programWords));
  const expectedVersion = lower.startsWith('nito1p') ? 1 : 0;
  const expectedProgramLength = expectedVersion === 1 ? 32 : 20;
  if (version !== expectedVersion || program.length !== expectedProgramLength) {
    throw new Error(
      `Invalid public witness address: version ${version}, ${program.length}-byte program.`,
    );
  }
  return concatBytes(Uint8Array.from([opForWitnessVersion(version), program.length]), program);
};

export const electrumScripthashFromScript = (scriptPubKey: Uint8Array) => {
  const digest = sha256(scriptPubKey);
  return toHex(Uint8Array.from(digest).reverse());
};

export const addressToElectrumScripthash = (address: string) =>
  electrumScripthashFromScript(scriptPubKeyForNitoAddress(address));

export class NitoElectrumClient {
  private readonly servers: ElectrumServer[];
  private readonly timeoutMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly reconnectDelayMs: number;
  private currentServerIndex = 0;
  private requestId = 1;
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private requestQueue: QueuedRequest[] = [];
  private activeRequests = 0;
  private requestMetrics: ElectrumRequestMetrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    peakInFlight: 0,
    maxQueueDepth: 0,
    totalQueueWaitMs: 0,
  };
  private scripthashListeners = new Map<string, Set<ScripthashStatusListener>>();
  private blockHeightListeners = new Set<BlockHeightListener>();
  private connectionStateListeners = new Set<ConnectionStateListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectEnabled = false;
  private hasConnectedBefore = false;
  private blockHeaderFingerprint = '';

  connected = false;
  blockHeight = 0;

  constructor(
    servers = NITO_ELECTRUM_SERVERS,
    timeoutOrOptions: number | NitoElectrumClientOptions = {},
  ) {
    const options =
      typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
    const maxConcurrentRequests =
      options.maxConcurrentRequests ?? DEFAULT_ELECTRUM_MAX_CONCURRENT_REQUESTS;
    if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
      throw new Error('Electrum concurrency must be a positive integer.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const reconnectDelayMs = options.reconnectDelayMs ?? 500;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Electrum timeout must be a positive number.');
    }
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs < 0) {
      throw new Error('Electrum reconnect delay must be a non-negative number.');
    }
    if (servers.length === 0) {
      throw new Error('At least one ElectrumX server is required.');
    }
    this.servers = [...servers].sort((a, b) => a.priority - b.priority);
    this.timeoutMs = timeoutMs;
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  getRequestMetrics(): ElectrumRequestMetrics {
    return { ...this.requestMetrics };
  }

  resetRequestMetrics(): void {
    this.requestMetrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      peakInFlight: this.activeRequests,
      maxQueueDepth: this.requestQueue.length,
      totalQueueWaitMs: 0,
    };
  }

  get currentServerUrl() {
    const server = this.servers[this.currentServerIndex];
    if (!server) throw new Error('No ElectrumX server configured.');
    return `${server.protocol}://${server.host}:${server.port}`;
  }

  async connect() {
    this.reconnectEnabled = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (this.connected) return;

    const pendingConnect = this.connectToAvailableServer();
    this.connectPromise = pendingConnect;

    try {
      await pendingConnect;
    } finally {
      if (this.connectPromise === pendingConnect) this.connectPromise = null;
    }
  }

  private async connectToAvailableServer() {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      const attemptedServerUrl = this.currentServerUrl;
      try {
        await this.openSocket(attemptedServerUrl);
        const serverVersion = await this.requestRaw<unknown>('server.version', [
          'Nito-Web-Wallet',
          ELECTRUM_PROTOCOL_VERSION,
        ]);
        if (
          !Array.isArray(serverVersion) ||
          typeof serverVersion[0] !== 'string' ||
          typeof serverVersion[1] !== 'string'
        ) {
          throw new Error('ElectrumX returned an invalid server.version response.');
        }
        const header = validateHeader(
          await this.requestRaw<unknown>('blockchain.headers.subscribe', []),
        );
        this.blockHeight = header.height;
        this.blockHeaderFingerprint = header.hex ?? '';
        await this.restoreScripthashSubscriptions();
        const reconnected = this.hasConnectedBefore;
        this.hasConnectedBefore = true;
        this.reconnectAttempt = 0;
        this.emitConnectionState({
          connected: true,
          serverUrl: attemptedServerUrl,
          reconnected,
        });
        return;
      } catch (caught) {
        const failure =
          caught instanceof Error ? caught : new Error('ElectrumX connection failed.');
        lastError = new Error(
          `ElectrumX server unavailable: ${attemptedServerUrl}. ${failure.message}`,
        );
        this.closeSocket(lastError);
        this.currentServerIndex = (this.currentServerIndex + 1) % this.servers.length;
      }
    }

    throw lastError || new Error('All ElectrumX servers are unavailable.');
  }

  disconnect(reason: Error = new Error('ElectrumX connection closed.')) {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket(reason);
  }

  private closeSocket(reason: Error) {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    socket?.close();
    this.rejectOutstandingRequests(reason);
  }

  private markSessionUnhealthy(reason: ElectrumSessionUnhealthyError) {
    const wasConnected = this.connected;
    this.closeSocket(reason);
    if (this.servers.length > 1) {
      this.currentServerIndex = (this.currentServerIndex + 1) % this.servers.length;
    }
    if (wasConnected) {
      this.emitConnectionState({
        connected: false,
        serverUrl: this.currentServerUrl,
        reconnected: false,
        error: reason,
      });
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    const hasLiveObservers =
      this.connectionStateListeners.size > 0 ||
      this.blockHeightListeners.size > 0 ||
      this.scripthashListeners.size > 0;
    if (
      !this.reconnectEnabled ||
      !hasLiveObservers ||
      this.reconnectTimer ||
      this.connected ||
      this.connectPromise
    ) {
      return;
    }
    const delayMs = Math.min(
      ELECTRUM_RECONNECT_MAX_DELAY_MS,
      this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((caught) => {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        this.emitConnectionState({
          connected: false,
          serverUrl: this.currentServerUrl,
          reconnected: false,
          error,
        });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private emitConnectionState(state: ElectrumConnectionState) {
    this.connectionStateListeners.forEach((listener) => listener(state));
  }

  subscribeConnectionState(listener: ConnectionStateListener) {
    this.connectionStateListeners.add(listener);
    if (!this.connected && this.hasConnectedBefore) this.scheduleReconnect();
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  private async restoreScripthashSubscriptions() {
    const scripthashes = [...this.scripthashListeners.keys()];
    for (let offset = 0; offset < scripthashes.length; offset += this.maxConcurrentRequests) {
      const batch = scripthashes.slice(offset, offset + this.maxConcurrentRequests);
      await Promise.all(
        batch.map(async (scripthash) => {
          const status = await this.requestRaw<unknown>('blockchain.scripthash.subscribe', [
            scripthash,
          ]);
          if (!isSubscriptionStatus(status)) {
            throw new ElectrumInvalidResponseError(
              'blockchain.scripthash.subscribe',
              'status must be a string or null',
            );
          }
          this.scripthashListeners
            .get(scripthash)
            ?.forEach((listener) => listener(status));
        }),
      );
    }
  }

  private rejectOutstandingRequests(reason: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    this.pending.clear();
    for (const request of this.requestQueue.splice(0)) {
      this.recordFailedRequest();
      request.reject(reason);
    }
  }

  async request<T>(method: string, params: unknown[] = []) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ELECTRUM_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      if (!this.connected || this.connectPromise) await this.connect();

      try {
        return await this.requestRaw<T>(method, params);
      } catch (caught) {
        lastError = caught;
        if (
          method === 'blockchain.transaction.get' &&
          isElectrumTransactionNotFoundError(caught)
        ) {
          throw caught;
        }
        if (!this.connected || caught instanceof ElectrumSessionUnhealthyError) throw caught;
        if (attempt < ELECTRUM_REQUEST_MAX_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, ELECTRUM_REQUEST_RETRY_DELAY_MS * attempt);
          });
        }
      }
    }

    const unhealthyError = new ElectrumSessionUnhealthyError(lastError);
    this.markSessionUnhealthy(unhealthyError);
    throw unhealthyError;
  }

  async getAddressBalance(address: string): Promise<ElectrumBalance> {
    const scripthash = addressToElectrumScripthash(address);
    const balance = validateBalance(
      await this.request<unknown>('blockchain.scripthash.get_balance', [scripthash]),
    );
    const totalSats = balance.confirmed + balance.unconfirmed;
    if (!Number.isSafeInteger(totalSats) || totalSats < 0) {
      throw new ElectrumInvalidResponseError(
        'blockchain.scripthash.get_balance',
        'aggregate balance exceeds the safe integer range',
      );
    }

    return {
      confirmedSats: balance.confirmed,
      unconfirmedSats: balance.unconfirmed,
      totalSats,
    };
  }

  async getAddressUtxos(address: string): Promise<ElectrumUtxo[]> {
    const scripthash = addressToElectrumScripthash(address);
    const utxos = validateUtxos(
      await this.request<unknown>('blockchain.scripthash.listunspent', [scripthash]),
    );

    return utxos.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      valueSats: utxo.value,
      height: utxo.height,
      address,
      confirmations:
        utxo.height > 0 && this.blockHeight > 0
          ? Math.max(0, this.blockHeight - utxo.height + 1)
          : 0,
    }));
  }

  async getAddressHistory(address: string): Promise<ElectrumHistoryEntry[]> {
    const scripthash = addressToElectrumScripthash(address);
    const history = validateHistory(
      await this.request<unknown>('blockchain.scripthash.get_history', [scripthash]),
    );
    return history.map((entry) => ({
      txid: entry.tx_hash,
      height: entry.height,
      address,
    }));
  }

  async estimateFeeRate(targetBlocks = 1): Promise<bigint> {
    if (!Number.isInteger(targetBlocks) || targetBlocks < 1 || targetBlocks > 1_008) {
      throw new Error('Electrum fee target must be between 1 and 1008 blocks.');
    }
    const estimate = await this.request<unknown>('blockchain.estimatefee', [
      targetBlocks,
    ]);
    if (
      typeof estimate !== 'number' ||
      !Number.isFinite(estimate) ||
      estimate <= 0
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.estimatefee',
        'fee estimate must be a positive coin/kB number',
      );
    }
    // Electrum expresses this value in NITO/kB with nitoshi precision. Round
    // once at that protocol boundary to avoid binary floating-point turning
    // an exact 2 nitoshi/vB estimate into 3.
    const nitoshisPerKilobyte = Math.round(estimate * 100_000_000);
    const nitoshisPerVbyte = Math.ceil(nitoshisPerKilobyte / 1_000);
    if (
      !Number.isSafeInteger(nitoshisPerKilobyte) ||
      !Number.isSafeInteger(nitoshisPerVbyte) ||
      nitoshisPerVbyte < 1 ||
      nitoshisPerVbyte > 10_000
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.estimatefee',
        'fee estimate is outside the accepted range',
      );
    }
    return BigInt(nitoshisPerVbyte);
  }

  async subscribeAddressStatus(
    address: string,
    listener: (status: string | null, address: string) => void,
  ) {
    const scripthash = addressToElectrumScripthash(address);
    const wrappedListener: ScripthashStatusListener = (status) => listener(status, address);
    const listeners =
      this.scripthashListeners.get(scripthash) ?? new Set<ScripthashStatusListener>();
    listeners.add(wrappedListener);
    this.scripthashListeners.set(scripthash, listeners);

    const unsubscribe = () => {
      const current = this.scripthashListeners.get(scripthash);
      current?.delete(wrappedListener);
      if (current && current.size === 0) this.scripthashListeners.delete(scripthash);
    };

    try {
      const status = await this.request<unknown>('blockchain.scripthash.subscribe', [
        scripthash,
      ]);
      if (!isSubscriptionStatus(status)) {
        throw new ElectrumInvalidResponseError(
          'blockchain.scripthash.subscribe',
          'status must be a string or null',
        );
      }
      return { status, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  async broadcastTransaction(txHex: string, expectedTxid?: string) {
    if (!isTransactionHex(txHex)) {
      throw new Error('Cannot broadcast an invalid transaction payload.');
    }
    if (expectedTxid !== undefined && !isTxid(expectedTxid)) {
      throw new Error('Cannot broadcast a transaction with an invalid local txid.');
    }
    const reportedTxid = await this.request<unknown>('blockchain.transaction.broadcast', [
      txHex,
    ]);
    if (!isTxid(reportedTxid)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.broadcast',
        'txid must be 64 hexadecimal characters',
      );
    }
    if (
      expectedTxid !== undefined &&
      reportedTxid.toLowerCase() !== expectedTxid.toLowerCase()
    ) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.broadcast',
        'the server txid does not match the locally signed transaction',
      );
    }
    return expectedTxid?.toLowerCase() ?? reportedTxid.toLowerCase();
  }

  async getTransactionHex(txid: string) {
    if (!isTxid(txid)) {
      throw new Error('Cannot request a transaction with an invalid txid.');
    }
    const transactionHex = await this.request<unknown>('blockchain.transaction.get', [txid]);
    if (!isTransactionHex(transactionHex)) {
      throw new ElectrumInvalidResponseError(
        'blockchain.transaction.get',
        `transaction ${txid} is not valid hexadecimal data`,
      );
    }
    return transactionHex.toLowerCase();
  }

  async getVerboseTransaction(txid: string) {
    if (!isTxid(txid)) {
      throw new Error('Cannot request a transaction with an invalid txid.');
    }
    const transaction = await this.request<unknown>('blockchain.transaction.get', [txid, true]);
    return validateVerboseTransaction(transaction, txid);
  }

  subscribeBlockHeight(listener: BlockHeightListener) {
    this.blockHeightListeners.add(listener);
    return () => {
      this.blockHeightListeners.delete(listener);
    };
  }

  private openSocket(url: string) {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      let opened = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error(`Timeout ElectrumX: ${url}`));
      }, this.timeoutMs);

      socket.onopen = () => {
        if (settled) {
          socket.close();
          return;
        }
        settled = true;
        opened = true;
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        resolve();
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`ElectrumX WebSocket error: ${url}`));
      };

      socket.onclose = () => {
        if (!opened && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`ElectrumX WebSocket closed during connection: ${url}`));
          return;
        }
        if (this.socket === socket) {
          this.socket = null;
          this.connected = false;
          const error = new ElectrumSessionUnhealthyError(
            new Error('ElectrumX connection closed unexpectedly.'),
          );
          this.rejectOutstandingRequests(error);
          if (this.servers.length > 1) {
            this.currentServerIndex = (this.currentServerIndex + 1) % this.servers.length;
          }
          this.emitConnectionState({
            connected: false,
            serverUrl: this.currentServerUrl,
            reconnected: false,
            error,
          });
          this.scheduleReconnect();
        }
      };

      socket.onmessage = (event) => {
        try {
          if (typeof event.data !== 'string') {
            throw new ElectrumInvalidResponseError(
              'websocket',
              'messages must be UTF-8 JSON text',
            );
          }
          this.handleMessage(event.data);
        } catch (caught) {
          this.disconnect(new ElectrumSessionUnhealthyError(caught));
        }
      };
    });
  }

  private requestRaw<T = unknown>(method: string, params: unknown[] = []) {
    this.requestMetrics = {
      ...this.requestMetrics,
      totalRequests: this.requestMetrics.totalRequests + 1,
    };

    return new Promise<T>((resolve, reject) => {
      const queued: QueuedRequest = {
        queuedAt: Date.now(),
        run: () => this.sendRequestRaw<T>(method, params),
        resolve: (value) => resolve(value as T),
        reject,
      };
      this.requestQueue.push(queued);
      this.requestMetrics = {
        ...this.requestMetrics,
        maxQueueDepth: Math.max(
          this.requestMetrics.maxQueueDepth,
          Math.max(
            0,
            this.requestQueue.length -
              Math.max(0, this.maxConcurrentRequests - this.activeRequests),
          ),
        ),
      };
      this.drainRequestQueue();
    });
  }

  private drainRequestQueue() {
    while (
      this.activeRequests < this.maxConcurrentRequests &&
      this.requestQueue.length > 0
    ) {
      const queued = this.requestQueue.shift();
      if (!queued) return;
      this.activeRequests += 1;
      this.requestMetrics = {
        ...this.requestMetrics,
        peakInFlight: Math.max(this.requestMetrics.peakInFlight, this.activeRequests),
        totalQueueWaitMs:
          this.requestMetrics.totalQueueWaitMs + Math.max(0, Date.now() - queued.queuedAt),
      };
      void queued
        .run()
        .then((value) => {
          this.requestMetrics = {
            ...this.requestMetrics,
            successfulRequests: this.requestMetrics.successfulRequests + 1,
          };
          queued.resolve(value);
        })
        .catch((error: unknown) => {
          this.recordFailedRequest();
          queued.reject(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          this.activeRequests -= 1;
          this.drainRequestQueue();
        });
    }
  }

  private recordFailedRequest() {
    this.requestMetrics = {
      ...this.requestMetrics,
      failedRequests: this.requestMetrics.failedRequests + 1,
    };
  }

  private sendRequestRaw<T = unknown>(method: string, params: unknown[] = []) {
    const socket = this.socket;
    if (!socket || !this.connected) {
      return Promise.reject(new Error('ElectrumX not connected.'));
    }

    return new Promise<T>((resolve, reject) => {
      const id = this.requestId;
      this.requestId += 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout ElectrumX: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
      } catch (caught) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });
  }

  private handleMessage(raw: string) {
    if (raw.length > ELECTRUM_MAX_MESSAGE_CHARACTERS) {
      throw new ElectrumInvalidResponseError(
        'websocket',
        `message exceeds ${ELECTRUM_MAX_MESSAGE_CHARACTERS} characters`,
      );
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new ElectrumInvalidResponseError('websocket', 'message must be a JSON object');
    }
    const message = parsed as JsonRpcResponse;
    if (message.id !== undefined && !isSafeInteger(message.id)) {
      throw new ElectrumInvalidResponseError(
        'websocket',
        'JSON-RPC id must be a non-negative safe integer',
      );
    }
    if (
      message.method !== undefined &&
      (typeof message.method !== 'string' ||
        message.method.length === 0 ||
        message.method.length > 128)
    ) {
      throw new ElectrumInvalidResponseError(
        'websocket',
        'JSON-RPC method must be a bounded non-empty string',
      );
    }

    if (message.method === 'blockchain.headers.subscribe') {
      if (!Array.isArray(message.params) || message.params.length < 1) {
        throw new ElectrumInvalidResponseError(
          'blockchain.headers.subscribe',
          'notification parameters are missing',
        );
      }
      const header = validateHeader(message.params[0]);
      const previousHeight = this.blockHeight;
      const previousFingerprint = this.blockHeaderFingerprint;
      const nextHeight = header.height;
      const nextFingerprint = header.hex ?? previousFingerprint;
      this.blockHeight = nextHeight;
      this.blockHeaderFingerprint = nextFingerprint;

      if (
        nextHeight !== previousHeight ||
        (nextHeight === previousHeight &&
          previousFingerprint !== '' &&
          nextFingerprint !== previousFingerprint)
      ) {
        this.blockHeightListeners.forEach((listener) =>
          listener(nextHeight, previousHeight),
        );
      }
      return;
    }

    if (message.method === 'blockchain.scripthash.subscribe') {
      const [scripthash, status] = Array.isArray(message.params) ? message.params : [];

      if (!isTxid(scripthash) || !isSubscriptionStatus(status)) {
        throw new ElectrumInvalidResponseError(
          'blockchain.scripthash.subscribe',
          'notification must contain a 64-character scripthash and status',
        );
      }
      const listeners = this.scripthashListeners.get(scripthash);
      listeners?.forEach((listener) => listener(status));
      return;
    }

    if (message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;

    clearTimeout(request.timer);
    this.pending.delete(message.id);

    if (message.error !== undefined) {
      if (
        !isRecord(message.error) ||
        (message.error.message !== undefined &&
          (typeof message.error.message !== 'string' || message.error.message.length > 1_024)) ||
        (message.error.code !== undefined && !Number.isSafeInteger(message.error.code))
      ) {
        request.reject(
          new ElectrumInvalidResponseError('websocket', 'JSON-RPC error object is invalid'),
        );
        return;
      }
      request.reject(
        new ElectrumRpcError(
          message.error.message || `ElectrumX error ${message.error.code || ''}`.trim(),
          message.error.code,
        ),
      );
      return;
    }

    request.resolve(message.result);
  }
}
