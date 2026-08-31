import { describe, expect, it } from 'vitest';

import type {
  SingleKeyAddress,
  WalletSessionSummary,
} from '../crypto/workerProtocol';
import type { ElectrumConnectionState } from '../network/electrum';
import {
  WalletNetworkController,
  type WalletElectrumPort,
} from './walletNetworkController';

const SERVER_URL = 'wss://electrum1.nito.network:50005';
const TXID = 'a'.repeat(64);
const REPLACEMENT_TXID = 'c'.repeat(64);
const FUNDING_TXID = 'b'.repeat(64);
const HASH160 = '751e76e8199196d454941c45d1b3a323f1433bd6';
const PUBLIC_KEY = `02${'11'.repeat(32)}`;
const ADDRESSES: SingleKeyAddress[] = [
  {
    scriptType: 'p2pkh',
    address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
    publicKeyHex: PUBLIC_KEY,
    publicKeyCompressed: true,
    scriptHex: `76a914${HASH160}88ac`,
  },
  {
    scriptType: 'p2sh-p2wpkh',
    address: '3JvL6Ymt8MVWiCNHC7oWU6nLeHNJKLZGLN',
    publicKeyHex: PUBLIC_KEY,
    publicKeyCompressed: true,
    scriptHex: 'a914bcfeb728b584253d5f3f70bcb780e9ef218a68f487',
    redeemScriptHex: `0014${HASH160}`,
  },
  {
    scriptType: 'p2wpkh',
    address: 'nito1qw508d6qejxtdg4y5r3zarvary0c5xw7kfauqqr',
    publicKeyHex: PUBLIC_KEY,
    publicKeyCompressed: true,
    scriptHex: `0014${HASH160}`,
  },
];
const SESSION: WalletSessionSummary = {
  sessionId: 'opaque-session',
  source: 'single-private-key',
  hd: false,
  compressed: true,
  primaryAddresses: ADDRESSES,
};

class FakeElectrumClient implements WalletElectrumPort {
  connected = false;
  blockHeight = 123;
  readonly currentServerUrl = SERVER_URL;
  balanceCalls = 0;
  historyCalls = 0;
  failReads = false;
  broadcasts: string[] = [];
  pendingAddress: string | undefined;
  pendingConfirmations = 0;
  pendingTxid = FUNDING_TXID;
  pendingValueSats = 25_000;
  feeTarget: number | undefined;
  private readonly connectionListeners = new Set<
    (state: ElectrumConnectionState) => void
  >();
  private readonly blockListeners = new Set<
    (height: number, previousHeight: number) => void
  >();
  private readonly addressListeners = new Map<
    string,
    Set<(status: string | null, address: string) => void>
  >();

  async connect() {
    this.connected = true;
  }

  async estimateFeeRate(targetBlocks = 1) {
    this.feeTarget = targetBlocks;
    return BigInt(4);
  }

  disconnect() {
    this.connected = false;
  }

  subscribeConnectionState(listener: (state: ElectrumConnectionState) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  subscribeBlockHeight(
    listener: (height: number, previousHeight: number) => void,
  ) {
    this.blockListeners.add(listener);
    return () => this.blockListeners.delete(listener);
  }

  async subscribeAddressStatus(
    address: string,
    listener: (status: string | null, address: string) => void,
  ) {
    const listeners = this.addressListeners.get(address) ?? new Set();
    listeners.add(listener);
    this.addressListeners.set(address, listeners);
    return {
      status: null,
      unsubscribe: () => listeners.delete(listener),
    };
  }

  async getAddressBalance(address: string) {
    this.balanceCalls += 1;
    if (this.failReads) throw new Error('synthetic read failure');
    if (address === this.pendingAddress) {
      return this.pendingConfirmations > 0
        ? {
            confirmedSats: this.pendingValueSats,
            unconfirmedSats: 0,
            totalSats: this.pendingValueSats,
          }
        : {
            confirmedSats: 0,
            unconfirmedSats: this.pendingValueSats,
            totalSats: this.pendingValueSats,
          };
    }
    return { confirmedSats: 0, unconfirmedSats: 0, totalSats: 0 };
  }

  async getAddressHistory(address: string) {
    this.historyCalls += 1;
    if (this.failReads) throw new Error('synthetic read failure');
    if (address === this.pendingAddress) {
      return [
        {
          txid: this.pendingTxid,
          height: this.pendingConfirmations > 0 ? 124 : 0,
          address,
        },
      ];
    }
    return [];
  }

  async getAddressUtxos(address: string) {
    if (this.failReads) throw new Error('synthetic read failure');
    if (address === this.pendingAddress) {
      return [
        {
          txid: this.pendingTxid,
          vout: 0,
          valueSats: this.pendingValueSats,
          height: this.pendingConfirmations > 0 ? 124 : 0,
          confirmations: this.pendingConfirmations,
          address,
        },
      ];
    }
    return [];
  }

  async getTransactionHex() {
    return `0100000001${'11'.repeat(32)}000000000100ffffffff0000000000`;
  }

  async broadcastTransaction(_txHex: string, expectedTxid?: string) {
    if (!expectedTxid) throw new Error('expected txid required');
    this.broadcasts.push(expectedTxid);
    return expectedTxid;
  }

  loseConnection() {
    this.connected = false;
    for (const listener of this.connectionListeners) {
      listener({ connected: false, serverUrl: SERVER_URL, reconnected: false });
    }
  }

  advanceBlock(height: number) {
    const previousHeight = this.blockHeight;
    this.blockHeight = height;
    for (const listener of this.blockListeners)
      listener(height, previousHeight);
  }

  trackPending(
    address: string,
    confirmations = 0,
    txid = FUNDING_TXID,
    valueSats = 25_000,
  ) {
    this.pendingAddress = address;
    this.pendingConfirmations = confirmations;
    this.pendingTxid = txid;
    this.pendingValueSats = valueSats;
  }

  notifyAddress(address: string) {
    for (const listener of this.addressListeners.get(address) ?? []) {
      listener(this.pendingTxid, address);
    }
  }
}

describe('WalletNetworkController stateless session', () => {
  it('requests the live high-priority fee for the next block', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });

    await expect(controller.estimateHighPriorityFeeRate()).resolves.toBe(
      BigInt(4),
    );
    expect(client.feeTarget).toBe(1);
    controller.close();
  });

  it('scans all three single-key families and exposes only the completed result', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.status));

    const state = await controller.start({ wallet: SESSION });

    expect(states).toContain('scanning');
    expect(state.status).toBe('ready');
    expect(state.record?.status).toBe('fresh');
    expect(state.record?.snapshot.addresses).toHaveLength(3);
    expect(state.record?.snapshot.history).toEqual([]);
    expect(client.balanceCalls).toBe(3);
    expect(client.historyCalls).toBe(3);
    controller.close();
  });

  it('reconciles the in-memory snapshot without hiding it on refresh and after broadcast', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    const firstSnapshot = controller.getState().record?.snapshot;
    const backgroundScanRecords: boolean[] = [];
    const unsubscribe = controller.subscribe((state) => {
      if (state.status === 'scanning')
        backgroundScanRecords.push(Boolean(state.record));
    });

    await controller.refresh();
    const refreshedSnapshot = controller.getState().record?.snapshot;
    expect(client.balanceCalls).toBe(6);
    expect(client.historyCalls).toBe(6);
    expect(refreshedSnapshot).not.toBe(firstSnapshot);
    expect(backgroundScanRecords).toContain(true);

    await expect(controller.broadcastTransaction('00', TXID)).resolves.toBe(
      TXID,
    );
    const postBroadcastSnapshot = controller.getState().record?.snapshot;
    expect(client.broadcasts).toEqual([TXID]);
    expect(client.balanceCalls).toBe(9);
    expect(client.historyCalls).toBe(9);
    expect(controller.getState().status).toBe('ready');
    expect(controller.getState().record?.status).toBe('fresh');
    expect(postBroadcastSnapshot).not.toBe(refreshedSnapshot);
    unsubscribe();
    controller.close();
  });

  it('projects an accepted self-payment immediately and keeps partial Electrum data hidden', async () => {
    const client = new FakeElectrumClient();
    const address = ADDRESSES[2]!.address;
    client.trackPending(address, 1);
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    const publishedBalances: number[] = [];
    controller.subscribe((state) => {
      if (state.record)
        publishedBalances.push(state.record.snapshot.balanceSats);
    });

    await expect(
      controller.broadcastTransaction('00', TXID, {
        inputs: [
          {
            txid: FUNDING_TXID,
            vout: 0,
            valueSats: 25_000,
            address,
          },
        ],
        outputs: [{ vout: 0, valueSats: 24_000, address }],
      }),
    ).resolves.toBe(TXID);

    expect(controller.getState().record?.snapshot.balanceSats).toBe(24_000);
    expect(controller.getState().record?.snapshot.unconfirmedSats).toBe(24_000);
    expect(controller.getState().record?.snapshot.spendableSats).toBe(0);
    expect(publishedBalances).not.toContain(0);

    client.trackPending(address, 0, TXID, 24_000);
    client.notifyAddress(address);
    await controller.waitForIdle();

    expect(controller.getState().record?.snapshot.balanceSats).toBe(24_000);
    expect(controller.getState().record?.snapshot.utxos[0]?.txid).toBe(TXID);
    expect(publishedBalances).not.toContain(0);
    controller.close();
  });

  it('projects an accepted RBF replacement without a temporary double balance', async () => {
    const client = new FakeElectrumClient();
    const address = ADDRESSES[2]!.address;
    client.trackPending(address, 1);
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    const original = {
      txid: TXID,
      inputs: [
        {
          txid: FUNDING_TXID,
          vout: 0,
          valueSats: 25_000,
          address,
        },
      ],
      outputs: [{ vout: 0, valueSats: 24_000, address }],
    };
    await controller.broadcastTransaction('00', TXID, {
      inputs: original.inputs,
      outputs: original.outputs,
    });

    client.trackPending(address, 0, TXID, 24_000);
    client.notifyAddress(address);
    await controller.waitForIdle();

    await expect(
      controller.broadcastReplacementTransaction(
        '11',
        REPLACEMENT_TXID,
        original,
        {
          inputs: original.inputs,
          outputs: [{ vout: 0, valueSats: 23_000, address }],
        },
      ),
    ).resolves.toBe(REPLACEMENT_TXID);

    expect(client.broadcasts).toEqual([TXID, REPLACEMENT_TXID]);
    expect(controller.getState().record?.snapshot.balanceSats).toBe(23_000);
    expect(controller.getState().record?.snapshot.utxos).toEqual([
      expect.objectContaining({
        txid: REPLACEMENT_TXID,
        valueSats: 23_000,
      }),
    ]);

    client.trackPending(address, 0, REPLACEMENT_TXID, 23_000);
    client.notifyAddress(address);
    await controller.waitForIdle();
    client.pendingConfirmations = 1;
    client.advanceBlock(124);
    await controller.waitForIdle();

    expect(
      controller
        .getState()
        .record?.snapshot.history.find(
          ({ txid }) => txid === REPLACEMENT_TXID,
        )?.height,
    ).toBe(124);
    controller.close();
  });

  it('publishes the confirmed original transaction when it wins the RBF race', async () => {
    const client = new FakeElectrumClient();
    const address = ADDRESSES[2]!.address;
    client.trackPending(address, 1);
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    const original = {
      txid: TXID,
      inputs: [
        {
          txid: FUNDING_TXID,
          vout: 0,
          valueSats: 25_000,
          address,
        },
      ],
      outputs: [{ vout: 0, valueSats: 24_000, address }],
    };
    await controller.broadcastTransaction('00', TXID, {
      inputs: original.inputs,
      outputs: original.outputs,
    });

    client.trackPending(address, 0, TXID, 24_000);
    client.notifyAddress(address);
    await controller.waitForIdle();
    await controller.broadcastReplacementTransaction(
      '11',
      REPLACEMENT_TXID,
      original,
      {
        inputs: original.inputs,
        outputs: [{ vout: 0, valueSats: 23_000, address }],
      },
    );

    client.pendingTxid = TXID;
    client.pendingValueSats = 24_000;
    client.pendingConfirmations = 1;
    client.advanceBlock(124);
    await controller.waitForIdle();

    const snapshot = controller.getState().record?.snapshot;
    expect(snapshot?.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ txid: TXID, height: 124 }),
      ]),
    );
    expect(snapshot?.history.some(({ txid }) => txid === REPLACEMENT_TXID)).toBe(
      false,
    );
    expect(snapshot?.balanceSats).toBe(24_000);
    controller.close();
  });

  it('tracks a pending transaction through known addresses without a full HD scan', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });

    await controller.refreshKnownAddresses([ADDRESSES[2]!.address]);

    expect(client.balanceCalls).toBe(4);
    expect(client.historyCalls).toBe(4);
    await expect(
      controller.refreshKnownAddresses(['unknown-address']),
    ).rejects.toThrow(/known wallet address/u);
    controller.close();
  });

  it('refreshes an externally received payment as soon as its address status changes', async () => {
    const client = new FakeElectrumClient();
    const address = ADDRESSES[2]!.address;
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });

    client.trackPending(address);
    client.notifyAddress(address);
    await controller.waitForIdle();

    expect(controller.getState().record?.snapshot.balanceSats).toBe(25_000);
    expect(controller.getState().record?.snapshot.unconfirmedSats).toBe(25_000);
    expect(client.balanceCalls).toBe(4);
    expect(client.historyCalls).toBe(4);
    controller.close();
  });

  it('does not rescan an unchanged wallet for every ordinary new block', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });

    client.advanceBlock(124);
    await controller.waitForIdle();

    expect(client.balanceCalls).toBe(3);
    expect(client.historyCalls).toBe(3);
    expect(controller.getState().status).toBe('ready');
    expect(controller.getState().blockHeight).toBe(124);
    controller.close();
  });

  it('uses a new Electrum block to confirm only addresses with pending activity', async () => {
    const client = new FakeElectrumClient();
    client.trackPending(ADDRESSES[2]!.address);
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    expect(controller.getState().record?.snapshot.unconfirmedSats).toBe(25_000);

    client.pendingConfirmations = 1;
    client.advanceBlock(124);
    await controller.waitForIdle();

    expect(client.balanceCalls).toBe(4);
    expect(client.historyCalls).toBe(4);
    expect(controller.getState().record?.snapshot.confirmedSats).toBe(25_000);
    expect(controller.getState().record?.snapshot.unconfirmedSats).toBe(0);
    expect(controller.getState().status).toBe('ready');
    controller.close();
  });

  it('never converts a failed first scan into a zero-balance wallet', async () => {
    const client = new FakeElectrumClient();
    client.failReads = true;
    const controller = new WalletNetworkController(() => client);

    await expect(controller.start({ wallet: SESSION })).rejects.toThrow();
    expect(controller.getState().status).toBe('error');
    expect(controller.getState().record).toBeUndefined();
    controller.close();
  });

  it('marks an in-memory result stale on disconnect and blocks its use', async () => {
    const client = new FakeElectrumClient();
    const controller = new WalletNetworkController(() => client);
    await controller.start({ wallet: SESSION });
    client.loseConnection();

    expect(controller.getState().status).toBe('stale');
    expect(controller.getState().record?.status).toBe('stale');
    await expect(controller.broadcastTransaction('00', TXID)).rejects.toThrow(
      'fresh connected',
    );
    controller.close();
  });
});
