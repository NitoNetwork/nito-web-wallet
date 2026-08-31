import { describe, expect, it } from 'vitest';

import type { ElectrumUtxo } from '../network/electrum';
import {
  acceptedTransactionAddresses,
  acceptedTransactionIsVisible,
  projectAcceptedTransparentTransaction,
  projectReplacementTransparentTransaction,
  walletTransactionIsUnconfirmed,
  type AcceptedTransparentTransaction,
} from './transparentBroadcast';
import {
  rebuildTransparentWalletSnapshot,
  type ScannedAddress,
  type TransparentWalletSnapshot,
} from './transparentScan';

const FUNDING_TXID = '1'.repeat(64);
const BROADCAST_TXID = '2'.repeat(64);
const REPLACEMENT_TXID = '3'.repeat(64);
const PUBLIC_KEY = `02${'11'.repeat(32)}`;
const INPUT_ADDRESS = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const CHANGE_ADDRESS = 'nito1qw508d6qejxtdg4y5r3zarvary0c5xw7kfauqqr';

const makeAddress = (
  keyAddressIndex: number,
  address: string,
  utxos: ElectrumUtxo[] = [],
): ScannedAddress => {
  const confirmedSats = utxos
    .filter(({ confirmations }) => confirmations > 0)
    .reduce((total, { valueSats }) => total + valueSats, 0);
  const unconfirmedSats = utxos
    .filter(({ confirmations }) => confirmations === 0)
    .reduce((total, { valueSats }) => total + valueSats, 0);
  return {
    ownerKind: 'single-key',
    keyAddressIndex,
    publicKeyCompressed: true,
    publicKeyHex: PUBLIC_KEY,
    scriptType: keyAddressIndex === 0 ? 'p2pkh' : 'p2wpkh',
    scriptHex:
      keyAddressIndex === 0
        ? '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
        : '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    address,
    balance: {
      confirmedSats,
      unconfirmedSats,
      totalSats: confirmedSats + unconfirmedSats,
    },
    utxos,
    history: utxos.map((utxo) => ({
      txid: utxo.txid,
      height: utxo.height,
      address,
    })),
    used: utxos.length > 0,
  };
};

const fundingUtxo: ElectrumUtxo = {
  txid: FUNDING_TXID,
  vout: 0,
  valueSats: 100_000,
  height: 100,
  confirmations: 10,
  address: INPUT_ADDRESS,
};

const makeSnapshot = (): TransparentWalletSnapshot => {
  const base: TransparentWalletSnapshot = {
    schemaVersion: 1,
    sourceKind: 'single-private-key',
    scanMode: 'single-key',
    confirmedSats: 0,
    unconfirmedSats: 0,
    balanceSats: 0,
    spendableSats: 0,
    immatureCoinbaseSats: 0,
    immatureCoinbaseBlocksRemaining: 0,
    utxos: [],
    history: [],
    addresses: [],
    usedAddresses: [],
    spendableAddresses: [],
    gapLimit: null,
    coverage: [{ mode: 'single-key', addressCount: 2, complete: true }],
    scannedAt: '2026-08-30T00:00:00.000Z',
  };
  return rebuildTransparentWalletSnapshot(base, [
    makeAddress(0, INPUT_ADDRESS, [fundingUtxo]),
    makeAddress(1, CHANGE_ADDRESS),
  ]);
};

const transaction = (outputs: AcceptedTransparentTransaction['outputs']) => ({
  txid: BROADCAST_TXID,
  inputs: [
    {
      txid: FUNDING_TXID,
      vout: 0,
      valueSats: 100_000,
      address: INPUT_ADDRESS,
    },
  ],
  outputs,
});

describe('accepted transparent transaction projection', () => {
  it('shows a self-payment immediately without publishing a temporary zero balance', () => {
    const accepted = transaction([
      { vout: 0, valueSats: 40_000, address: INPUT_ADDRESS },
      { vout: 1, valueSats: 59_000, address: CHANGE_ADDRESS },
    ]);

    const projected = projectAcceptedTransparentTransaction(
      makeSnapshot(),
      accepted,
    );

    expect(projected.balanceSats).toBe(99_000);
    expect(projected.confirmedSats).toBe(0);
    expect(projected.unconfirmedSats).toBe(99_000);
    expect(projected.spendableSats).toBe(0);
    expect(projected.utxos).toHaveLength(2);
    expect(projected.utxos.every(({ txid }) => txid === BROADCAST_TXID)).toBe(
      true,
    );
    expect(projected.history.some(({ txid }) => txid === BROADCAST_TXID)).toBe(
      true,
    );
    expect(acceptedTransactionIsVisible(projected, accepted)).toBe(true);
  });

  it('deducts an external payment and its fee while keeping wallet change pending', () => {
    const accepted = transaction([
      { vout: 1, valueSats: 59_000, address: CHANGE_ADDRESS },
    ]);

    const projected = projectAcceptedTransparentTransaction(
      makeSnapshot(),
      accepted,
    );

    expect(projected.balanceSats).toBe(59_000);
    expect(projected.unconfirmedSats).toBe(59_000);
    expect(projected.spendableSats).toBe(0);
    expect(projected.utxos).toEqual([
      expect.objectContaining({
        txid: BROADCAST_TXID,
        vout: 1,
        valueSats: 59_000,
        address: CHANGE_ADDRESS,
      }),
    ]);
  });

  it('rejects a partial Electrum view until both spent inputs and wallet outputs agree', () => {
    const accepted = transaction([
      { vout: 1, valueSats: 59_000, address: CHANGE_ADDRESS },
    ]);
    const initial = makeSnapshot();
    const partial = rebuildTransparentWalletSnapshot(
      initial,
      initial.addresses.map((address, index) =>
        makeAddress(index, address.address),
      ),
    );

    expect(acceptedTransactionIsVisible(initial, accepted)).toBe(false);
    expect(acceptedTransactionIsVisible(partial, accepted)).toBe(false);
    expect(acceptedTransactionAddresses(accepted)).toEqual([
      INPUT_ADDRESS,
      CHANGE_ADDRESS,
    ]);
  });

  it('replaces the projected unconfirmed transaction without restoring spent inputs', () => {
    const original = transaction([
      { vout: 1, valueSats: 59_000, address: CHANGE_ADDRESS },
    ]);
    const projected = projectAcceptedTransparentTransaction(
      makeSnapshot(),
      original,
    );
    const replacement: AcceptedTransparentTransaction = {
      txid: REPLACEMENT_TXID,
      inputs: original.inputs,
      outputs: [{ vout: 0, valueSats: 98_000, address: CHANGE_ADDRESS }],
    };
    const replaced = projectReplacementTransparentTransaction(
      projected,
      original,
      replacement,
    );

    expect(walletTransactionIsUnconfirmed(projected, BROADCAST_TXID)).toBe(
      true,
    );
    expect(walletTransactionIsUnconfirmed(replaced, BROADCAST_TXID)).toBe(
      false,
    );
    expect(walletTransactionIsUnconfirmed(replaced, REPLACEMENT_TXID)).toBe(
      true,
    );
    expect(replaced.balanceSats).toBe(98_000);
    expect(replaced.utxos).toEqual([
      expect.objectContaining({
        txid: REPLACEMENT_TXID,
        vout: 0,
        valueSats: 98_000,
      }),
    ]);
  });

  it('rejects replacement after the original transaction is confirmed', () => {
    const original = transaction([
      { vout: 1, valueSats: 59_000, address: CHANGE_ADDRESS },
    ]);
    const projected = projectAcceptedTransparentTransaction(
      makeSnapshot(),
      original,
    );
    const confirmed = rebuildTransparentWalletSnapshot(
      projected,
      projected.addresses.map((address) => ({
        ...address,
        history: address.history.map((entry) =>
          entry.txid === BROADCAST_TXID ? { ...entry, height: 101 } : entry,
        ),
      })),
    );

    expect(walletTransactionIsUnconfirmed(confirmed, BROADCAST_TXID)).toBe(
      false,
    );
    expect(() =>
      projectReplacementTransparentTransaction(confirmed, original, {
        txid: REPLACEMENT_TXID,
        inputs: original.inputs,
        outputs: [{ vout: 0, valueSats: 98_000, address: CHANGE_ADDRESS }],
      }),
    ).toThrow(/only an unconfirmed/u);
  });
});
