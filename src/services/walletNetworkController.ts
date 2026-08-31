import type {
  ElectrumConnectionState,
  NitoElectrumClient,
} from '../network/electrum';
import { NitoElectrumClient as DefaultNitoElectrumClient } from '../network/electrum';
import type {
  SingleKeyAddress,
  WalletSessionSummary,
} from '../crypto/workerProtocol';
import type { HdBranch, HdScanRequirement } from '../domain/wallet-policy';
import {
  scanSingleKeyWallet,
  scanTransparentHdRecoveryRanges,
  scanTransparentHdWallet,
  refreshTransparentWalletSnapshot,
  TransparentScanAbortedError,
  TransparentScanIncompleteError,
  TransparentSnapshotIntegrityError,
  type DeepRecoveryRange,
  type ElectrumReader,
  type HdAddressDeriver,
  type HdSourceKind,
  type TransparentScanProgress,
  type TransparentWalletSnapshot,
} from '../wallet/transparentScan';
import {
  acceptedTransactionAddresses,
  acceptedTransactionIsVisible,
  projectAcceptedTransparentTransaction,
  projectReplacementTransparentTransaction,
  type AcceptedTransparentTransaction,
} from '../wallet/transparentBroadcast';
import { mapWithConcurrency } from './concurrency';
import { DirtySyncQueue, type DirtySyncOptions } from './syncDirtyQueue';

const SUBSCRIPTION_CONCURRENCY = 6;
const BROADCAST_RECONCILIATION_MAX_RETRIES = 7;
const BROADCAST_RECONCILIATION_RETRY_MS = 250;

export type WalletElectrumPort = ElectrumReader & {
  connected: boolean;
  blockHeight: number;
  readonly currentServerUrl: string;
  broadcastTransaction?(txHex: string, expectedTxid?: string): Promise<string>;
  estimateFeeRate?(targetBlocks?: number): Promise<bigint>;
  connect(): Promise<void>;
  disconnect(reason?: Error): void;
  subscribeConnectionState(
    listener: (state: ElectrumConnectionState) => void,
  ): () => void;
  subscribeBlockHeight(
    listener: (height: number, previousHeight: number) => void,
  ): () => void;
  subscribeAddressStatus(
    address: string,
    listener: (status: string | null, address: string) => void,
  ): Promise<{ status: string | null; unsubscribe: () => void }>;
};

export type WalletNetworkSession = Readonly<{
  wallet: WalletSessionSummary;
  deriveAddresses?: HdAddressDeriver;
  getIssuedAddresses?: () => Promise<readonly HdScanRequirement[]>;
}>;

export type WalletNetworkStatus =
  | 'idle'
  | 'connecting'
  | 'scanning'
  | 'ready'
  | 'stale'
  | 'error';

export type WalletSnapshotRecord = Readonly<{
  status: 'fresh' | 'stale';
  staleReason?: 'network-error' | 'connection-lost' | 'reorg';
  serverUrl: string;
  observedBlockHeight: number;
  updatedAt: string;
  snapshot: TransparentWalletSnapshot;
}>;

export type WalletNetworkState = Readonly<{
  status: WalletNetworkStatus;
  record?: WalletSnapshotRecord;
  progress?: TransparentScanProgress;
  serverUrl: string;
  blockHeight: number;
  errorCode?: string;
}>;

type WalletNetworkListener = (state: WalletNetworkState) => void;
type StaleReason = NonNullable<WalletSnapshotRecord['staleReason']>;
type PendingBroadcastReconciliation = {
  transaction: AcceptedTransparentTransaction;
  addresses: string[];
  retries: number;
  competingOriginalTxid?: string;
};

const initialNetworkState = (): WalletNetworkState => ({
  status: 'idle',
  serverUrl: '',
  blockHeight: 0,
});

const classifyNetworkError = (caught: unknown) => {
  if (caught instanceof TransparentScanIncompleteError)
    return 'SCAN_INCOMPLETE';
  if (caught instanceof TransparentScanAbortedError) return 'SCAN_ABORTED';
  if (
    caught instanceof Error &&
    caught.name === 'ElectrumSessionUnhealthyError'
  ) {
    return 'ELECTRUM_SESSION_UNHEALTHY';
  }
  return 'NETWORK_SYNC_FAILED';
};

const freshRecord = (
  client: WalletElectrumPort,
  snapshot: TransparentWalletSnapshot,
): WalletSnapshotRecord => ({
  status: 'fresh',
  serverUrl: client.currentServerUrl,
  observedBlockHeight: client.blockHeight,
  updatedAt: new Date().toISOString(),
  snapshot,
});

const addressesNeedingBlockRefresh = (snapshot: TransparentWalletSnapshot) =>
  snapshot.addresses
    .filter(
      (address) =>
        address.balance.unconfirmedSats !== 0 ||
        address.history.some((entry) => entry.height <= 0) ||
        address.utxos.some(
          (utxo) =>
            utxo.confirmations <= 0 ||
            (utxo.isCoinbase === true && utxo.confirmations < 101),
        ),
    )
    .map(({ address }) => address);

export class WalletNetworkController {
  private readonly listeners = new Set<WalletNetworkListener>();
  private readonly dirtyQueue = new DirtySyncQueue();
  private state: WalletNetworkState = initialNetworkState();
  private generation = 0;
  private session: WalletNetworkSession | undefined;
  private client: WalletElectrumPort | undefined;
  private scanAbortController: AbortController | undefined;
  private syncPromise: Promise<void> | undefined;
  private pendingReorg = false;
  private connectionUnsubscribe: (() => void) | undefined;
  private blockUnsubscribe: (() => void) | undefined;
  private addressUnsubscribes: Array<() => void> = [];
  private pendingBroadcast: PendingBroadcastReconciliation | undefined;
  private broadcastReconciliationTimer:
    | ReturnType<typeof setTimeout>
    | undefined;

  constructor(
    private readonly createClient: () => WalletElectrumPort = () =>
      new DefaultNitoElectrumClient() as NitoElectrumClient,
    private readonly gapLimit = 20,
  ) {}

  getState(): WalletNetworkState {
    return this.state;
  }

  subscribe(listener: WalletNetworkListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async start(session: WalletNetworkSession): Promise<WalletNetworkState> {
    this.stop();
    const generation = this.generation;
    this.validateSession(session);
    this.session = session;

    const client = this.createClient();
    this.client = client;
    this.connectionUnsubscribe = client.subscribeConnectionState(
      (connection) => {
        if (generation === this.generation)
          this.handleConnectionState(connection);
      },
    );
    this.blockUnsubscribe = client.subscribeBlockHeight(
      (height, previousHeight) => {
        if (generation === this.generation)
          this.handleBlockHeight(height, previousHeight);
      },
    );
    this.publish({
      status: 'connecting',
      serverUrl: client.currentServerUrl,
      blockHeight: 0,
    });

    this.requestSync();
    await this.waitForIdle();
    if (generation !== this.generation) return this.state;
    if (this.state.status === 'error') {
      const code = this.state.errorCode ?? 'NETWORK_SYNC_FAILED';
      throw Object.assign(new Error(code), { code });
    }
    return this.state;
  }

  async refresh(): Promise<WalletNetworkState> {
    if (!this.session || !this.client)
      throw new Error('Wallet network session is not active.');
    this.requestSync();
    await this.waitForIdle();
    return this.state;
  }

  /**
   * Silently refreshes known wallet addresses without launching HD discovery.
   * This lets a short-lived transaction dialog follow mempool and confirmation
   * state without turning transaction tracking into a complete wallet scan.
   */
  async refreshKnownAddresses(
    addresses: readonly string[],
  ): Promise<WalletNetworkState> {
    await this.waitForIdle();
    const snapshot = this.state.record?.snapshot;
    if (
      !this.session ||
      !this.client ||
      this.state.status !== 'ready' ||
      this.state.record?.status !== 'fresh' ||
      !snapshot
    ) {
      throw new Error('Wallet network session is not ready.');
    }
    const knownAddresses = new Set(
      snapshot.addresses.map(({ address }) => address),
    );
    const requested = [...new Set(addresses)];
    if (
      requested.length === 0 ||
      requested.some((address) => !knownAddresses.has(address))
    ) {
      throw new Error('Transaction tracking requires a known wallet address.');
    }
    this.requestSync({ silent: true, onlyAddresses: requested });
    await this.waitForIdle();
    return this.state;
  }

  async estimateHighPriorityFeeRate(): Promise<bigint> {
    await this.waitForIdle();
    const client = this.client;
    if (
      !client?.connected ||
      !client.estimateFeeRate ||
      this.state.status !== 'ready' ||
      this.state.record?.status !== 'fresh'
    ) {
      throw new Error(
        'A fresh connected wallet is required before estimating fees.',
      );
    }
    return client.estimateFeeRate(1);
  }

  async recoverRanges(
    ranges: readonly DeepRecoveryRange[],
  ): Promise<WalletNetworkState> {
    await this.waitForIdle();
    const generation = this.generation;
    const session = this.session;
    const client = this.client;
    if (!session || !client || !session.wallet.hd || !session.deriveAddresses) {
      throw new Error('Deep recovery requires an active HD wallet session.');
    }
    await this.trackOperation(
      this.performRecoveryRanges(ranges, generation, session, client),
    );
    return this.state;
  }

  async broadcastTransaction(
    txHex: string,
    expectedTxid: string,
    walletTransaction?: Omit<AcceptedTransparentTransaction, 'txid'>,
  ): Promise<string> {
    await this.waitForIdle();
    const generation = this.generation;
    const client = this.client;
    const snapshot = this.state.record?.snapshot;
    if (
      !client?.connected ||
      !client.broadcastTransaction ||
      this.state.status !== 'ready' ||
      this.state.record?.status !== 'fresh' ||
      !snapshot
    ) {
      throw new Error('A fresh connected wallet is required before broadcast.');
    }
    const acceptedTransaction = walletTransaction
      ? {
          txid: expectedTxid.toLowerCase(),
          inputs: walletTransaction.inputs,
          outputs: walletTransaction.outputs,
        }
      : undefined;
    const projectedSnapshot = acceptedTransaction
      ? projectAcceptedTransparentTransaction(snapshot, acceptedTransaction)
      : undefined;

    let txid = '';
    await this.trackOperation(
      Promise.resolve().then(async () => {
        txid = await client.broadcastTransaction!(txHex, expectedTxid);
        if (generation !== this.generation)
          throw new TransparentScanAbortedError();
        if (acceptedTransaction && projectedSnapshot) {
          const transaction = {
            ...acceptedTransaction,
            txid: txid.toLowerCase(),
          };
          const addresses = acceptedTransactionAddresses(transaction);
          this.clearBroadcastReconciliation();
          this.pendingBroadcast = { transaction, addresses, retries: 0 };
          this.publish({
            status: 'ready',
            record: freshRecord(client, projectedSnapshot),
            serverUrl: client.currentServerUrl,
            blockHeight: client.blockHeight,
          });
        }
      }),
    );
    if (!txid) throw new Error('Electrum did not return a transaction id.');

    if (acceptedTransaction) {
      this.requestSync({
        silent: true,
        onlyAddresses: acceptedTransactionAddresses(acceptedTransaction),
      });
    } else {
      this.requestSync({ rescanGap: true });
      await this.waitForIdle();
    }
    return txid;
  }

  async broadcastReplacementTransaction(
    txHex: string,
    expectedTxid: string,
    originalTransaction: AcceptedTransparentTransaction,
    replacementTransaction: Omit<AcceptedTransparentTransaction, 'txid'>,
  ): Promise<string> {
    await this.waitForIdle();
    const generation = this.generation;
    const client = this.client;
    const snapshot = this.state.record?.snapshot;
    if (
      !client?.connected ||
      !client.broadcastTransaction ||
      this.state.status !== 'ready' ||
      this.state.record?.status !== 'fresh' ||
      !snapshot
    ) {
      throw new Error(
        'A fresh connected wallet is required before replacement.',
      );
    }
    const replacement = {
      txid: expectedTxid.toLowerCase(),
      inputs: replacementTransaction.inputs,
      outputs: replacementTransaction.outputs,
    };
    const projectedSnapshot = projectReplacementTransparentTransaction(
      snapshot,
      originalTransaction,
      replacement,
    );

    let txid = '';
    await this.trackOperation(
      Promise.resolve().then(async () => {
        txid = await client.broadcastTransaction!(txHex, expectedTxid);
        if (generation !== this.generation)
          throw new TransparentScanAbortedError();
        const accepted = { ...replacement, txid: txid.toLowerCase() };
        const addresses = [
          ...new Set([
            ...acceptedTransactionAddresses(originalTransaction),
            ...acceptedTransactionAddresses(accepted),
          ]),
        ];
        this.clearBroadcastReconciliation();
        this.pendingBroadcast = {
          transaction: accepted,
          addresses,
          retries: 0,
          competingOriginalTxid: originalTransaction.txid.toLowerCase(),
        };
        this.publish({
          status: 'ready',
          record: freshRecord(client, projectedSnapshot),
          serverUrl: client.currentServerUrl,
          blockHeight: client.blockHeight,
        });
      }),
    );
    if (!txid)
      throw new Error('Electrum did not return a replacement transaction id.');

    this.requestSync({
      silent: true,
      onlyAddresses: [
        ...new Set([
          ...acceptedTransactionAddresses(originalTransaction),
          ...acceptedTransactionAddresses(replacement),
        ]),
      ],
    });
    return txid;
  }

  async waitForIdle(): Promise<void> {
    while (this.syncPromise) {
      const active = this.syncPromise;
      await active;
      if (active === this.syncPromise) await Promise.resolve();
    }
  }

  stop(): void {
    this.generation += 1;
    this.scanAbortController?.abort();
    this.scanAbortController = undefined;
    this.dirtyQueue.clear();
    this.pendingReorg = false;
    this.clearBroadcastReconciliation();
    this.clearAddressSubscriptions();
    this.connectionUnsubscribe?.();
    this.connectionUnsubscribe = undefined;
    this.blockUnsubscribe?.();
    this.blockUnsubscribe = undefined;
    this.client?.disconnect();
    this.client = undefined;
    this.session = undefined;
    this.syncPromise = undefined;
    this.publish(initialNetworkState());
  }

  close(): void {
    this.stop();
    this.listeners.clear();
  }

  private validateSession(session: WalletNetworkSession) {
    if (session.wallet.sessionId.trim() === '') {
      throw new Error('A wallet session identifier is required.');
    }
    if (session.wallet.hd && !session.deriveAddresses) {
      throw new Error(
        'HD wallet network sessions require the Worker derivation port.',
      );
    }
    if (!session.wallet.hd && session.wallet.source !== 'single-private-key') {
      throw new Error('Unsupported non-HD wallet network source.');
    }
    if (!session.wallet.hd && session.getIssuedAddresses) {
      throw new Error('Single-key wallets cannot have HD address allocations.');
    }
  }

  private requestSync(options: DirtySyncOptions = { rescanGap: true }) {
    this.dirtyQueue.request(options, Boolean(this.syncPromise), (requested) =>
      this.launchSync(requested),
    );
  }

  private launchSync(options: DirtySyncOptions) {
    if (this.syncPromise || !this.session || !this.client) return;
    void this.trackOperation(
      Promise.resolve().then(() => this.performSync(options)),
    );
  }

  private trackOperation(active: Promise<void>) {
    if (this.syncPromise)
      throw new Error('Wallet network work is already active.');
    const tracked = active.finally(() => {
      if (this.syncPromise !== tracked) return;
      this.syncPromise = undefined;
      this.drainPendingWork();
    });
    this.syncPromise = tracked;
    return tracked;
  }

  private drainPendingWork() {
    if (this.syncPromise) return;
    if (this.pendingReorg) {
      this.pendingReorg = false;
      this.markCurrentRecordStale('reorg');
      this.requestSync();
      return;
    }
    this.dirtyQueue.flush(false, (options) => this.launchSync(options));
  }

  private async performSync(options: DirtySyncOptions): Promise<void> {
    const generation = this.generation;
    const session = this.session;
    const client = this.client;
    if (!session || !client) return;
    const abortController = new AbortController();
    this.scanAbortController = abortController;
    const silent = options.silent === true && Boolean(this.state.record);
    if (!silent) {
      this.publish({
        ...this.state,
        status: client.connected ? 'scanning' : 'connecting',
        serverUrl: client.currentServerUrl,
        progress: undefined,
        errorCode: undefined,
      });
    }

    try {
      await client.connect();
      if (generation !== this.generation)
        throw new TransparentScanAbortedError();
      if (!silent) {
        this.publish({
          ...this.state,
          status: 'scanning',
          serverUrl: client.currentServerUrl,
          blockHeight: client.blockHeight,
        });
      }
      const onProgress = (progress: TransparentScanProgress) => {
        if (!silent && generation === this.generation) {
          this.publish({ ...this.state, progress });
        }
      };
      let snapshot: TransparentWalletSnapshot;
      const previousSnapshot = this.state.record?.snapshot;
      const targetedAddresses = options.rescanGap
        ? []
        : [
            ...new Set([
              ...(options.onlyAddresses ?? []),
              ...(this.pendingBroadcast?.addresses ?? []),
            ]),
          ];
      const targeted = Boolean(
        previousSnapshot && targetedAddresses.length > 0,
      );
      if (targeted) {
        snapshot = await refreshTransparentWalletSnapshot({
          snapshot: previousSnapshot!,
          addresses: targetedAddresses,
          electrum: client,
          signal: abortController.signal,
        });
      } else if (session.wallet.hd) {
        const issuedAddresses = (await session.getIssuedAddresses?.()) ?? [];
        snapshot = await scanTransparentHdWallet({
          sessionId: session.wallet.sessionId,
          sourceKind: session.wallet.source as HdSourceKind,
          electrum: client,
          deriveAddresses: session.deriveAddresses!,
          gapLimit: this.gapLimit,
          previousSnapshot,
          issuedAddresses,
          signal: abortController.signal,
          onProgress: silent ? undefined : onProgress,
        });
      } else {
        snapshot = await scanSingleKeyWallet({
          addresses: session.wallet.primaryAddresses as SingleKeyAddress[],
          electrum: client,
          previousSnapshot,
          signal: abortController.signal,
          onProgress: silent ? undefined : onProgress,
        });
      }
      if (generation !== this.generation || !client.connected) {
        throw new TransparentScanAbortedError();
      }
      const pendingBroadcast = this.pendingBroadcast;
      const competingOriginalConfirmed = Boolean(
        pendingBroadcast?.competingOriginalTxid &&
        snapshot.history.some(
          ({ txid, height }) =>
            txid.toLowerCase() ===
              pendingBroadcast.competingOriginalTxid?.toLowerCase() &&
            height > 0,
        ),
      );
      if (
        pendingBroadcast &&
        !acceptedTransactionIsVisible(snapshot, pendingBroadcast.transaction) &&
        !competingOriginalConfirmed
      ) {
        this.scheduleBroadcastReconciliation(pendingBroadcast);
        return;
      }
      if (pendingBroadcast) this.clearBroadcastReconciliation();
      const record = freshRecord(client, snapshot);
      if (!targeted)
        await this.installAddressSubscriptions(snapshot, generation);
      if (generation !== this.generation)
        throw new TransparentScanAbortedError();
      this.publish({
        status: 'ready',
        record,
        serverUrl: client.currentServerUrl,
        blockHeight: client.blockHeight,
      });
    } catch (caught) {
      if (
        this.pendingBroadcast &&
        caught instanceof TransparentSnapshotIntegrityError &&
        caught.message.includes('balance/listunspent mismatch')
      ) {
        this.scheduleBroadcastReconciliation(this.pendingBroadcast);
        return;
      }
      this.publishFailure(caught, 'network-error', generation);
    } finally {
      if (this.scanAbortController === abortController)
        this.scanAbortController = undefined;
    }
  }

  private async performRecoveryRanges(
    ranges: readonly DeepRecoveryRange[],
    generation: number,
    session: WalletNetworkSession,
    client: WalletElectrumPort,
  ): Promise<void> {
    const abortController = new AbortController();
    this.scanAbortController = abortController;
    this.publish({ ...this.state, status: 'scanning', progress: undefined });
    try {
      await client.connect();
      const snapshot = await scanTransparentHdRecoveryRanges({
        sessionId: session.wallet.sessionId,
        sourceKind: session.wallet.source as HdSourceKind,
        ranges,
        electrum: client,
        deriveAddresses: session.deriveAddresses!,
        baseSnapshot: this.state.record?.snapshot,
        signal: abortController.signal,
        onProgress: (progress) => {
          if (generation === this.generation)
            this.publish({ ...this.state, progress });
        },
      });
      if (generation !== this.generation || !client.connected) {
        throw new TransparentScanAbortedError();
      }
      const record = freshRecord(client, snapshot);
      await this.installAddressSubscriptions(snapshot, generation);
      this.publish({
        status: 'ready',
        record,
        serverUrl: client.currentServerUrl,
        blockHeight: client.blockHeight,
      });
    } catch (caught) {
      this.publishFailure(caught, 'network-error', generation);
    } finally {
      if (this.scanAbortController === abortController)
        this.scanAbortController = undefined;
    }
  }

  private async installAddressSubscriptions(
    snapshot: TransparentWalletSnapshot,
    generation: number,
  ) {
    const client = this.client;
    if (!client) throw new TransparentScanAbortedError();
    this.clearAddressSubscriptions();
    const addresses = [
      ...new Set(snapshot.addresses.map(({ address }) => address)),
    ];
    const installed: Array<() => void> = [];
    try {
      await mapWithConcurrency(
        addresses,
        SUBSCRIPTION_CONCURRENCY,
        async (address) => {
          const subscription = await client.subscribeAddressStatus(
            address,
            () => {
              if (generation !== this.generation) return;
              const known = this.state.record?.snapshot.addresses.find(
                (candidate) => candidate.address === address,
              );
              this.resetBroadcastReconciliationRetries(address);
              this.requestSync({ silent: true, onlyAddresses: [address] });
              if (this.session?.wallet.hd === true && known?.used === false) {
                this.requestSync({ silent: true, rescanGap: true });
              }
            },
          );
          if (generation !== this.generation) {
            subscription.unsubscribe();
            throw new TransparentScanAbortedError();
          }
          installed.push(subscription.unsubscribe);
        },
      );
      this.addressUnsubscribes = installed;
    } catch (caught) {
      for (const unsubscribe of installed) unsubscribe();
      throw caught;
    }
  }

  private clearAddressSubscriptions() {
    for (const unsubscribe of this.addressUnsubscribes.splice(0)) unsubscribe();
  }

  private clearBroadcastReconciliation() {
    if (this.broadcastReconciliationTimer !== undefined) {
      clearTimeout(this.broadcastReconciliationTimer);
      this.broadcastReconciliationTimer = undefined;
    }
    this.pendingBroadcast = undefined;
  }

  private resetBroadcastReconciliationRetries(address?: string) {
    const pending = this.pendingBroadcast;
    if (!pending || (address && !pending.addresses.includes(address))) return;
    pending.retries = 0;
  }

  private scheduleBroadcastReconciliation(
    pending: PendingBroadcastReconciliation,
  ) {
    if (
      this.pendingBroadcast !== pending ||
      this.broadcastReconciliationTimer !== undefined ||
      pending.retries >= BROADCAST_RECONCILIATION_MAX_RETRIES
    ) {
      return;
    }
    pending.retries += 1;
    const delay = Math.min(
      1_500,
      BROADCAST_RECONCILIATION_RETRY_MS * pending.retries,
    );
    this.broadcastReconciliationTimer = setTimeout(() => {
      this.broadcastReconciliationTimer = undefined;
      if (this.pendingBroadcast !== pending) return;
      this.requestSync({ silent: true, onlyAddresses: pending.addresses });
    }, delay);
  }

  private handleConnectionState(connection: ElectrumConnectionState) {
    if (!connection.connected) {
      this.markCurrentRecordStale('connection-lost');
    } else if (connection.reconnected) {
      this.requestSync();
    }
  }

  private handleBlockHeight(height: number, previousHeight: number) {
    if (height <= previousHeight) {
      this.pendingReorg = true;
      this.drainPendingWork();
      return;
    }

    this.publish({ ...this.state, blockHeight: height });
    const snapshot = this.state.record?.snapshot;
    if (!snapshot) return;
    this.resetBroadcastReconciliationRetries();
    const pendingAddresses = addressesNeedingBlockRefresh(snapshot);
    if (pendingAddresses.length > 0) {
      this.requestSync({ silent: true, onlyAddresses: pendingAddresses });
    }
  }

  private markCurrentRecordStale(reason: StaleReason) {
    const record = this.state.record;
    if (!record) return;
    this.publish({
      ...this.state,
      status: 'stale',
      record: { ...record, status: 'stale', staleReason: reason },
      errorCode: reason === 'reorg' ? 'CHAIN_REORG' : 'ELECTRUM_DISCONNECTED',
    });
  }

  private publishFailure(
    caught: unknown,
    reason: StaleReason,
    generation: number,
  ) {
    if (
      caught instanceof TransparentScanAbortedError &&
      generation !== this.generation
    )
      return;
    if (generation !== this.generation) return;
    const current = this.state.record;
    const record = current
      ? { ...current, status: 'stale' as const, staleReason: reason }
      : undefined;
    this.publish({
      status: record ? 'stale' : 'error',
      ...(record ? { record } : {}),
      serverUrl: this.client?.currentServerUrl ?? this.state.serverUrl,
      blockHeight: this.client?.blockHeight ?? this.state.blockHeight,
      errorCode: classifyNetworkError(caught),
    });
  }

  private publish(state: WalletNetworkState) {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A view listener must never interrupt in-memory chain reconciliation.
      }
    }
  }
}

export type { DeepRecoveryRange, HdBranch };
