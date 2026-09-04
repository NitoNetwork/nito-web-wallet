import { describe, expect, it, vi } from 'vitest';
import { UtxoMetadataCache } from './utxoMetadata';
import { NitoElectrumClient, type ElectrumUtxo } from './electrum';

const utxo = (height = 10, vout = 0): ElectrumUtxo => ({
  txid: 'ab'.repeat(32),
  vout,
  height,
  address: 'nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02',
  valueSats: 10_000,
  confirmations: height > 0 ? 1 : 0,
});
const header = (timestamp = 1_780_000_000) => {
  const bytes = new Uint8Array(80);
  new DataView(bytes.buffer).setUint32(68, timestamp, true);
  return Buffer.from(bytes).toString('hex');
};

describe('UTXO display metadata', () => {
  it('does not schedule remaining metadata reads after the session is closed', async () => {
    let resolveHeader!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveHeader = resolve;
    });
    const load = vi.fn(() => pending);
    const cache = new UtxoMetadataCache(load);
    const work = cache.annotate(
      Array.from({ length: 30 }, (_, i) => utxo(i + 1)),
    );
    await Promise.resolve();
    cache.clear();
    resolveHeader(header());
    await work;
    expect(load.mock.calls.length).toBeLessThanOrEqual(6);
  });
  it('deduplicates parallel block lookups across addresses and repeat syncs', async () => {
    const load = vi.fn(async () => header());
    const cache = new UtxoMetadataCache(load);
    const [a, b] = await Promise.all([
      cache.annotate([utxo()]),
      cache.annotate([utxo(10, 1)]),
    ]);
    expect(a[0].blockTime).toBe(1_780_000_000);
    expect(b[0].blockTime).toBe(a[0].blockTime);
    await cache.annotate([utxo()]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps first-observed time during a session, replaces it with block time at confirmation', async () => {
    const load = vi.fn(async () => header());
    const cache = new UtxoMetadataCache(load);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    try {
      const [a] = await cache.annotate([utxo(0)]);
      clock.mockReturnValue(1_790_000_010_000);
      expect((await cache.annotate([utxo(-1)]))[0].firstSeenAt).toBe(
        a.firstSeenAt,
      );
      expect(load).not.toHaveBeenCalled();
      const [confirmed] = await cache.annotate([utxo(10)]);
      expect(confirmed.firstSeenAt).toBeUndefined();
      expect(confirmed.blockTime).toBe(1_780_000_000);
      cache.clear();
      expect((await cache.annotate([utxo(0)]))[0].firstSeenAt).toBe(
        1_790_000_010,
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('never invents a timestamp or changes money on failure, and retries later', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('bad')
      .mockResolvedValue(header());
    const cache = new UtxoMetadataCache(load);
    expect(await cache.annotate([utxo()])).toEqual([utxo()]);
    expect(await cache.annotate([utxo()])).toEqual([utxo()]);
    expect((await cache.annotate([utxo()]))[0].blockTime).toBe(1_780_000_000);
  });

  it('invalidates dates after a reorg and bounds simultaneous work', async () => {
    let active = 0;
    let peak = 0;
    const load = vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return header();
    });
    const cache = new UtxoMetadataCache(load);
    await cache.annotate(
      Array.from({ length: 30 }, (_, index) => utxo(index + 1)),
    );
    expect(peak).toBeLessThanOrEqual(6);
    cache.invalidateBlocks();
    await cache.annotate([utxo()]);
    expect(load).toHaveBeenCalledTimes(31);
  });

  it('integrates listunspent metadata without additional requests for pending outputs', async () => {
    const client = new NitoElectrumClient();
    client.blockHeight = 12;
    const rpc = vi
      .spyOn(client, 'request')
      .mockImplementation(async (method) => {
        if (method === 'blockchain.block.header') return header();
        return [0, 10, 10].map((height, tx_pos) => ({
          tx_hash: utxo().txid,
          tx_pos,
          value: 10_000,
          height,
        }));
      });
    const outputs = await client.getAddressUtxos(utxo().address);
    expect(outputs.map((output) => output.confirmations)).toEqual([0, 3, 3]);
    expect(outputs[0].firstSeenAt).toBeTypeOf('number');
    expect(outputs[1].blockTime).toBe(1_780_000_000);
    expect(rpc).toHaveBeenCalledTimes(2);
    client.disconnect();
  });
});
