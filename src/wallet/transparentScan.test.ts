import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { NitoWasmCrypto, instantiateNitoWasmCrypto } from '../crypto/wasmAbi';
import type { SingleKeyAddress } from '../crypto/workerProtocol';
import { deriveHdPath } from '../domain/wallet-policy';
import type {
  ElectrumBalance,
  ElectrumHistoryEntry,
} from '../network/electrum';
import {
  HD_SCAN_TEMPLATES,
  refreshTransparentWalletSnapshot,
  scanSingleKeyWallet,
  scanTransparentHdRecoveryRanges,
  scanTransparentHdWallet,
  TransparentScanAbortedError,
  TransparentScanIncompleteError,
  TransparentSnapshotIntegrityError,
  type ElectrumReader,
  type HdAddressDeriver,
} from './transparentScan';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const REGULAR_TRANSACTION = `0100000001${'11'.repeat(32)}000000000100ffffffff0000000000`;

type AddressState = {
  txid: string;
  valueSats: number;
  historyOnly?: boolean;
  confirmations?: number;
};

const emptyBalance = (): ElectrumBalance => ({
  confirmedSats: 0,
  unconfirmedSats: 0,
  totalSats: 0,
});

const createReader = (states = new Map<string, AddressState>()): ElectrumReader => ({
  async getAddressBalance(address) {
    const state = states.get(address);
    if (!state || state.historyOnly) return emptyBalance();
    const confirmed = (state.confirmations ?? 200) > 0 ? state.valueSats : 0;
    const unconfirmed = confirmed === 0 ? state.valueSats : 0;
    return {
      confirmedSats: confirmed,
      unconfirmedSats: unconfirmed,
      totalSats: state.valueSats,
    };
  },
  async getAddressHistory(address) {
    const state = states.get(address);
    return state ? [{ txid: state.txid, height: 100, address }] : [];
  },
  async getAddressUtxos(address) {
    const state = states.get(address);
    if (!state || state.historyOnly) return [];
    const confirmations = state.confirmations ?? 200;
    return [
      {
        txid: state.txid,
        vout: 0,
        valueSats: state.valueSats,
        height: confirmations > 0 ? 100 : 0,
        address,
        confirmations,
      },
    ];
  },
  async getTransactionHex() {
    return REGULAR_TRANSACTION;
  },
});

describe('transparent wallet scan', () => {
  let wasm: NitoWasmCrypto;
  let deriveAddresses: HdAddressDeriver;

  beforeAll(async () => {
    const bytes = await readFile(
      resolve(process.cwd(), 'public', 'wasm', 'nito_wallet_crypto_web.wasm'),
    );
    wasm = await instantiateNitoWasmCrypto(bytes, (target) => target.fill(0x5a));
    deriveAddresses = async (_sessionId, requests) =>
      wasm.invoke('deriveAddresses', { mnemonic: MNEMONIC, requests });
  });

  it('proves a gap on all 16 account/family/branch sequences', async () => {
    const snapshot = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(),
      deriveAddresses,
      gapLimit: 2,
    });

    expect(snapshot.scanMode).toBe('gap');
    expect(snapshot.addresses).toHaveLength(32);
    expect(snapshot.coverage).toHaveLength(16);
    expect(
      snapshot.coverage.every(
        (coverage) =>
          coverage.mode === 'gap' &&
          coverage.highestScannedIndex === 1 &&
          coverage.trailingUnused === 2 &&
          coverage.complete,
      ),
    ).toBe(true);
    expect(
      new Set(
        snapshot.addresses
          .filter((address) => address.ownerKind === 'hd')
          .map(
            (address) =>
              `${address.account}:${address.accountKey}:${address.branch}`,
          ),
    ).size,
    ).toBe(16);
  });

  it('keeps every issued empty address inside authoritative gap coverage', async () => {
    const snapshot = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(),
      deriveAddresses,
      gapLimit: 2,
      issuedAddresses: [
        {
          account: 0,
          accountKey: 'bech32',
          branch: 'external',
          highestIssuedIndex: 25,
        },
      ],
    });

    expect(
      snapshot.coverage.find(
        (coverage) =>
          coverage.mode === 'gap' &&
          coverage.account === 0 &&
          coverage.accountKey === 'bech32' &&
          coverage.branch === 'external',
      ),
    ).toMatchObject({
      highestScannedIndex: 25,
      lastUsedIndex: -1,
      trailingUnused: 26,
      complete: true,
    });
    expect(
      snapshot.addresses.some(
        (address) =>
          address.ownerKind === 'hd' &&
          address.account === 0 &&
          address.accountKey === 'bech32' &&
          address.branch === 'external' &&
          address.index === 25,
      ),
    ).toBe(true);
  });

  it('aggregates funded UTXOs from every one of the 16 HD sequences', async () => {
    const requests = HD_SCAN_TEMPLATES.flatMap((template) =>
      (['external', 'internal'] as const).map((branch) => ({
        path: deriveHdPath(template, branch, 0),
        scriptType: template.scriptType,
      })),
    );
    const funded = await deriveAddresses('test-session', requests);
    const states = new Map<string, AddressState>(
      funded.map((address, index) => [
        address.address,
        {
          txid: (index + 1).toString(16).padStart(64, '0'),
          valueSats: (index + 1) * 1_000,
        },
      ]),
    );

    const snapshot = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'email-credentials',
      electrum: createReader(states),
      deriveAddresses,
      gapLimit: 2,
    });

    expect(snapshot.balanceSats).toBe(136_000);
    expect(snapshot.spendableSats).toBe(136_000);
    expect(snapshot.utxos).toHaveLength(16);
    expect(snapshot.history).toHaveLength(16);
    expect(snapshot.usedAddresses).toHaveLength(16);
    expect(snapshot.addresses).toHaveLength(48);
    expect(
      snapshot.coverage.every(
        (coverage) =>
          coverage.mode === 'gap' &&
          coverage.lastUsedIndex === 0 &&
          coverage.trailingUnused === 2,
      ),
    ).toBe(true);
    expect(
      snapshot.addresses.filter(
        (address) => address.ownerKind === 'hd' && address.account === 1,
      ),
    ).not.toHaveLength(0);
  });

  it('treats zero-balance history as used and extends the branch gap', async () => {
    const template = HD_SCAN_TEMPLATES.find(
      (candidate) => candidate.account === 0 && candidate.key === 'bech32',
    )!;
    const [target] = await deriveAddresses('test-session', [
      { path: deriveHdPath(template, 'external', 1), scriptType: template.scriptType },
    ]);
    const states = new Map<string, AddressState>([
      [
        target!.address,
        { txid: 'ab'.repeat(32), valueSats: 0, historyOnly: true },
      ],
    ]);

    const snapshot = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(states),
      deriveAddresses,
      gapLimit: 2,
    });
    const coverage = snapshot.coverage.find(
      (item) =>
        item.mode === 'gap' &&
        item.sequenceKey === template.sequenceKey &&
        item.branch === 'external',
    );

    expect(coverage).toMatchObject({
      mode: 'gap',
      lastUsedIndex: 1,
      highestScannedIndex: 3,
      trailingUnused: 2,
    });
    expect(snapshot.history.map(({ txid }) => txid)).toContain('ab'.repeat(32));
    expect(snapshot.balanceSats).toBe(0);
  });

  it('retries failed reads and rejects instead of reporting an incomplete zero', async () => {
    const template = HD_SCAN_TEMPLATES[0]!;
    const [target] = await deriveAddresses('test-session', [
      { path: deriveHdPath(template, 'external', 0), scriptType: template.scriptType },
    ]);
    let attempts = 0;
    const reader = createReader();
    reader.getAddressHistory = async (address) => {
      if (address === target!.address) {
        attempts += 1;
        throw new Error('persistent history failure');
      }
      return [];
    };

    await expect(
      scanTransparentHdWallet({
        sessionId: 'test-session',
        sourceKind: 'bip39-hd',
        electrum: reader,
        deriveAddresses,
        gapLimit: 1,
      }),
    ).rejects.toBeInstanceOf(TransparentScanIncompleteError);
    expect(attempts).toBe(3);
  });

  it('refreshes a complete previous snapshot before deciding the next gap', async () => {
    const initial = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(),
      deriveAddresses,
      gapLimit: 2,
    });
    const template = HD_SCAN_TEMPLATES.find(
      (candidate) => candidate.account === 1 && candidate.key === 'taproot',
    )!;
    const target = initial.addresses.find(
      (address) =>
        address.ownerKind === 'hd' &&
        address.account === 1 &&
        address.accountKey === 'taproot' &&
        address.branch === 'internal' &&
        address.index === 1,
    )!;
    const states = new Map<string, AddressState>([
      [target.address, { txid: 'cd'.repeat(32), valueSats: 42_000 }],
    ]);

    const refreshed = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(states),
      deriveAddresses,
      gapLimit: 2,
      previousSnapshot: initial,
    });

    expect(refreshed.balanceSats).toBe(42_000);
    expect(refreshed.addresses).toHaveLength(34);
    expect(
      refreshed.coverage.find(
        (item) =>
          item.mode === 'gap' &&
          item.sequenceKey === template.sequenceKey &&
          item.branch === 'internal',
      ),
    ).toMatchObject({ lastUsedIndex: 1, highestScannedIndex: 3 });
  });

  it('bounds all balance/history calls behind one global network limiter', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const delayed = async <T>(value: T) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return value;
    };
    const reader: ElectrumReader = {
      getAddressBalance: () => delayed(emptyBalance()),
      getAddressHistory: () => delayed([] as ElectrumHistoryEntry[]),
      async getAddressUtxos() {
        return [];
      },
    };

    await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: reader,
      deriveAddresses,
      gapLimit: 1,
    });
    expect(peakInFlight).toBeLessThanOrEqual(6);
  });

  it('scans WIF/HEX encodings without inventing HD paths', async () => {
    const inspected = wasm.invoke<{
      addresses: SingleKeyAddress[];
    }>('inspectPrivateKey', {
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
    });
    const target = inspected.addresses.find((address) => address.scriptType === 'p2wpkh')!;
    const states = new Map<string, AddressState>([
      [target.address, { txid: 'ef'.repeat(32), valueSats: 75_000 }],
    ]);

    const snapshot = await scanSingleKeyWallet({
      addresses: inspected.addresses,
      electrum: createReader(states),
    });

    expect(snapshot.scanMode).toBe('single-key');
    expect(snapshot.addresses).toHaveLength(3);
    expect(snapshot.addresses.map((address) => address.scriptType)).toEqual([
      'p2pkh',
      'p2sh-p2wpkh',
      'p2wpkh',
    ]);
    expect(snapshot.balanceSats).toBe(75_000);
    expect(snapshot.addresses.every((address) => address.ownerKind === 'single-key')).toBe(
      true,
    );
    expect(snapshot.addresses.some((address) => 'path' in address)).toBe(false);
  });

  it('refreshes only a pending address when a new block confirms it', async () => {
    const inspected = wasm.invoke<{
      addresses: SingleKeyAddress[];
    }>('inspectPrivateKey', {
      privateKey: '0000000000000000000000000000000000000000000000000000000000000001',
    });
    const target = inspected.addresses.find((address) => address.scriptType === 'p2wpkh')!;
    const states = new Map<string, AddressState>([
      [
        target.address,
        { txid: 'fa'.repeat(32), valueSats: 25_000, confirmations: 0 },
      ],
    ]);
    const reader = createReader(states);
    let balanceCalls = 0;
    const getAddressBalance = reader.getAddressBalance.bind(reader);
    reader.getAddressBalance = (address) => {
      balanceCalls += 1;
      return getAddressBalance(address);
    };
    const initial = await scanSingleKeyWallet({
      addresses: inspected.addresses,
      electrum: reader,
    });
    expect(initial.unconfirmedSats).toBe(25_000);

    states.set(target.address, {
      txid: 'fa'.repeat(32),
      valueSats: 25_000,
      confirmations: 1,
    });
    const refreshed = await refreshTransparentWalletSnapshot({
      snapshot: initial,
      addresses: [target.address],
      electrum: reader,
    });

    expect(balanceCalls).toBe(inspected.addresses.length + 1);
    expect(refreshed.confirmedSats).toBe(25_000);
    expect(refreshed.unconfirmedSats).toBe(0);
    expect(refreshed.addresses.find(({ address }) => address === target.address)?.utxos[0])
      .toMatchObject({ confirmations: 1 });
  });

  it('scans an explicit account-1 range through index 9,999 and records its bounds', async () => {
    const template = HD_SCAN_TEMPLATES.find(
      (candidate) => candidate.account === 1 && candidate.key === 'bech32',
    )!;
    const [target] = await deriveAddresses('test-session', [
      { path: deriveHdPath(template, 'internal', 9_999), scriptType: template.scriptType },
    ]);
    const states = new Map<string, AddressState>([
      [target!.address, { txid: '12'.repeat(32), valueSats: 99_999 }],
    ]);

    const snapshot = await scanTransparentHdRecoveryRanges({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      ranges: [
        {
          account: 1,
          accountKey: 'bech32',
          branch: 'internal',
          fromIndex: 9_998,
          toIndex: 9_999,
        },
      ],
      electrum: createReader(states),
      deriveAddresses,
    });

    expect(snapshot.balanceSats).toBe(99_999);
    expect(snapshot.addresses.map((address) => address.ownerKind === 'hd' && address.index)).toEqual([
      9_998,
      9_999,
    ]);
    expect(snapshot.coverage).toEqual([
      {
        mode: 'explicit-range',
        sequenceKey: template.sequenceKey,
        account: 1,
        accountKey: 'bech32',
        branch: 'internal',
        fromIndex: 9_998,
        toIndex: 9_999,
        complete: true,
      },
    ]);
  });

  it('retains and refreshes discovered deep-recovery funds during later gap scans', async () => {
    const base = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(),
      deriveAddresses,
      gapLimit: 1,
    });
    const template = HD_SCAN_TEMPLATES.find(
      (candidate) => candidate.account === 1 && candidate.key === 'bech32',
    )!;
    const [target] = await deriveAddresses('test-session', [
      { path: deriveHdPath(template, 'internal', 9_999), scriptType: template.scriptType },
    ]);
    const states = new Map<string, AddressState>([
      [target!.address, { txid: '56'.repeat(32), valueSats: 123_456 }],
    ]);
    const recovered = await scanTransparentHdRecoveryRanges({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      ranges: [
        {
          account: 1,
          accountKey: 'bech32',
          branch: 'internal',
          fromIndex: 9_999,
          toIndex: 9_999,
        },
      ],
      electrum: createReader(states),
      deriveAddresses,
      baseSnapshot: base,
    });
    expect(recovered.scanMode).toBe('gap-with-recovery');
    expect(recovered.balanceSats).toBe(123_456);

    const refreshed = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(states),
      deriveAddresses,
      gapLimit: 1,
      previousSnapshot: recovered,
    });
    expect(refreshed.scanMode).toBe('gap-with-recovery');
    expect(refreshed.balanceSats).toBe(123_456);
    expect(
      refreshed.addresses.some(
        (address) => address.ownerKind === 'hd' && address.index === 9_999,
      ),
    ).toBe(true);
    expect(
      refreshed.coverage.some((coverage) => coverage.mode === 'explicit-range'),
    ).toBe(true);
  });

  it('merges repeated and overlapping recovery coverage without duplicating addresses', async () => {
    const base = await scanTransparentHdWallet({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      electrum: createReader(),
      deriveAddresses,
      gapLimit: 1,
    });
    const first = await scanTransparentHdRecoveryRanges({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      ranges: [{
        account: 1,
        accountKey: 'bech32',
        branch: 'internal',
        fromIndex: 25,
        toIndex: 29,
      }],
      electrum: createReader(),
      deriveAddresses,
      baseSnapshot: base,
    });
    const repeated = await scanTransparentHdRecoveryRanges({
      sessionId: 'test-session',
      sourceKind: 'bip39-hd',
      ranges: [{
        account: 1,
        accountKey: 'bech32',
        branch: 'internal',
        fromIndex: 28,
        toIndex: 32,
      }],
      electrum: createReader(),
      deriveAddresses,
      baseSnapshot: first,
    });

    expect(
      repeated.coverage.filter((coverage) => coverage.mode === 'explicit-range'),
    ).toEqual([expect.objectContaining({ fromIndex: 25, toIndex: 32 })]);
    const identities = repeated.addresses.map((address) =>
      address.ownerKind === 'hd' ? address.path : `single:${address.keyAddressIndex}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('fails closed on an Electrum balance/listunspent contradiction', async () => {
    const template = HD_SCAN_TEMPLATES[0]!;
    const [target] = await deriveAddresses('test-session', [
      { path: deriveHdPath(template, 'external', 0), scriptType: template.scriptType },
    ]);
    const reader = createReader(
      new Map([
        [target!.address, { txid: '34'.repeat(32), valueSats: 1_000 }],
      ]),
    );
    reader.getAddressUtxos = async () => [];

    await expect(
      scanTransparentHdWallet({
        sessionId: 'test-session',
        sourceKind: 'bip39-hd',
        electrum: reader,
        deriveAddresses,
        gapLimit: 1,
      }),
    ).rejects.toBeInstanceOf(TransparentSnapshotIntegrityError);
  });

  it('honors cancellation before deriving or contacting the network', async () => {
    const controller = new AbortController();
    controller.abort();
    const deriver = vi.fn(deriveAddresses);
    const reader = createReader();
    const balanceSpy = vi.spyOn(reader, 'getAddressBalance');

    await expect(
      scanTransparentHdWallet({
        sessionId: 'test-session',
        sourceKind: 'bip39-hd',
        electrum: reader,
        deriveAddresses: deriver,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TransparentScanAbortedError);
    expect(deriver).not.toHaveBeenCalled();
    expect(balanceSpy).not.toHaveBeenCalled();
  });
});
