import { describe, expect, it } from 'vitest';

import type { ElectrumHistoryEntry } from '../network/electrum';
import {
  mergeWalletHistoryPublication,
  needsHistoryEnrichment,
  normalizeWalletHistory,
} from './walletHistory';

const cached: ElectrumHistoryEntry = {
  txid: 'a'.repeat(64),
  height: 100,
  address: 'nito1qcache',
  direction: 'received',
  amountSats: 120_000,
  feeSats: 0,
};

const freshScan: ElectrumHistoryEntry = {
  txid: 'a'.repeat(64),
  height: 100,
  address: 'nito1qcache',
};

describe('normalizeWalletHistory', () => {
  it('keeps enriched amount/direction when a fresh unenriched scan is merged in', () => {
    const merged = normalizeWalletHistory([freshScan, cached]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ direction: 'received', amountSats: 120_000 });
  });

  it('keeps enrichment attached to the txid when its height changes', () => {
    const reorged: ElectrumHistoryEntry = { ...freshScan, height: 101 };
    const merged = normalizeWalletHistory([cached, reorged]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      height: 101,
      direction: 'received',
      amountSats: 120_000,
      feeSats: 0,
    });
  });

  it('deduplicates and sorts by descending height then txid', () => {
    const merged = normalizeWalletHistory([
      { txid: 'b'.repeat(64), height: 50, address: 'x' },
      { txid: 'c'.repeat(64), height: 200, address: 'y' },
      { txid: 'b'.repeat(64), height: 50, address: 'x' },
    ]);
    expect(merged.map((entry) => entry.height)).toEqual([200, 50]);
  });

  it('sorts all mempool entries before confirmed entries and keeps their txid order', () => {
    const merged = normalizeWalletHistory([
      { txid: 'd'.repeat(64), height: 200, address: 'confirmed-high' },
      { txid: 'b'.repeat(64), height: 0, address: 'mempool' },
      { txid: 'c'.repeat(64), height: 100, address: 'confirmed-low' },
      { txid: 'a'.repeat(64), height: -1, address: 'mempool-parent' },
    ]);

    expect(merged.map((entry) => [entry.txid[0], entry.height])).toEqual([
      ['a', -1],
      ['b', 0],
      ['d', 200],
      ['c', 100],
    ]);
  });

  it('keeps the confirmed height when a mempool entry is merged with its confirmation', () => {
    const txid = 'e'.repeat(64);
    const merged = normalizeWalletHistory([
      { txid, height: 0, address: 'mempool' },
      { txid, height: 951_729, address: 'confirmed' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.height).toBe(951_729);
  });

  it('re-enriches a confirmed cached row whose block time is missing on the next scan', () => {
    expect(needsHistoryEnrichment({
      ...cached,
      blockTime: undefined,
    })).toBe(true);
    expect(needsHistoryEnrichment({
      ...cached,
      height: 0,
      blockTime: undefined,
    })).toBe(false);
  });

  it('never lets a partial publication regress enriched fields', () => {
    const published = mergeWalletHistoryPublication(
      [{
        ...cached,
        counterparty: 'sender',
        blockTime: 1_753_000_123,
      }],
      [freshScan],
      'partial',
    );

    expect(published).toEqual([
      expect.objectContaining({
        direction: 'received',
        amountSats: 120_000,
        feeSats: 0,
        counterparty: 'sender',
        blockTime: 1_753_000_123,
      }),
    ]);
  });

  it('lets an authoritative scan drop absent mempool rows and accept a lower reorg height', () => {
    const droppedTxid = 'b'.repeat(64);
    const published = mergeWalletHistoryPublication(
      [
        {
          ...cached,
          height: 102,
          counterparty: 'sender',
          blockTime: 1_753_000_123,
        },
        { txid: droppedTxid, height: 0, address: 'nito1qmempool' },
      ],
      [{ ...freshScan, height: 101 }],
      'authoritative',
    );

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      txid: cached.txid,
      height: 101,
      direction: 'received',
      amountSats: 120_000,
      feeSats: 0,
      counterparty: 'sender',
      provisional: true,
    });
    expect(published[0]?.blockTime).toBeUndefined();
    expect(needsHistoryEnrichment(published[0]!)).toBe(true);
  });
});
