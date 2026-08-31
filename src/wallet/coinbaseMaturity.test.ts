import { describe, expect, it, vi } from 'vitest';

import type { ElectrumUtxo } from '../network/electrum';
import {
  annotateCoinbaseMaturity,
  getImmatureCoinbaseSummary,
  isCoinbaseTransactionHex,
  isTransparentUtxoSpendable,
} from './coinbaseMaturity';

const coinbaseTransaction = `0100000001${'00'.repeat(32)}ffffffff0100ffffffff0000000000`;
const regularTransaction = `0100000001${'11'.repeat(32)}000000000100ffffffff0000000000`;

const utxo = (confirmations: number, isCoinbase?: boolean): ElectrumUtxo => ({
  txid: 'ab'.repeat(32),
  vout: 0,
  valueSats: 5_000_000_000,
  height: 1,
  address: 'nito1test',
  confirmations,
  isCoinbase,
});

describe('coinbase maturity', () => {
  it('identifies a coinbase transaction from its null prevout', () => {
    expect(isCoinbaseTransactionHex(coinbaseTransaction)).toBe(true);
    expect(isCoinbaseTransactionHex(regularTransaction)).toBe(false);
  });

  it('locks coinbase through 100 confirmations and unlocks it at 101', () => {
    expect(isTransparentUtxoSpendable(utxo(100, true))).toBe(false);
    expect(getImmatureCoinbaseSummary([utxo(100, true)])).toEqual({
      amountSats: 5_000_000_000,
      blocksRemaining: 1,
    });
    expect(isTransparentUtxoSpendable(utxo(101, true))).toBe(true);
    expect(isTransparentUtxoSpendable(utxo(1, false))).toBe(true);
  });

  it('reuses cached classification and bounds new transaction reads', async () => {
    const loadTransactionHex = vi.fn(async () => regularTransaction);
    const known = await annotateCoinbaseMaturity([utxo(2)], [utxo(1, true)], loadTransactionHex);
    expect(known[0]?.isCoinbase).toBe(true);
    expect(loadTransactionHex).not.toHaveBeenCalled();

    let inFlight = 0;
    let peakInFlight = 0;
    const youngUtxos = Array.from({ length: 18 }, (_, index) => ({
      ...utxo(1),
      txid: index.toString(16).padStart(64, '0'),
    }));
    await annotateCoinbaseMaturity(youngUtxos, [], async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return regularTransaction;
    });
    expect(peakInFlight).toBeLessThanOrEqual(6);
  });

  it('fails closed when required classification data cannot be read', async () => {
    await expect(
      annotateCoinbaseMaturity([utxo(1)], [], async () => {
        throw new Error('coinbase source unavailable');
      }),
    ).rejects.toThrow('coinbase source unavailable');
  });
});
