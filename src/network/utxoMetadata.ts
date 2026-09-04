import type { ElectrumUtxo } from './electrum';
import { mapWithConcurrency } from '../services/concurrency';

const MAX_CACHED_BLOCKS = 2_048;
const MAX_PENDING_TRANSACTIONS = 10_000;

/** Display metadata only: it must never determine a balance or spending policy. */
export class UtxoMetadataCache {
  private generation = 0;
  private blockTimes = new Map<number, Promise<number>>();
  private firstSeen = new Map<string, number>();

  constructor(
    private readonly loadHeader: (height: number) => Promise<unknown>,
  ) {}

  clear() {
    this.generation++;
    this.blockTimes.clear();
    this.firstSeen.clear();
  }

  invalidateBlocks() {
    this.blockTimes.clear();
  }

  private blockTime(height: number): Promise<number> {
    const cached = this.blockTimes.get(height);
    if (cached) return cached;
    const request = this.loadHeader(height).then((header) => {
      // NITO transparent block headers retain the standard 80-byte layout.
      if (typeof header !== 'string' || !/^[a-f\d]{160}$/iu.test(header)) {
        throw new Error('Invalid block header for UTXO timestamp.');
      }
      const bytes = Uint8Array.from(header.match(/../gu)!, (byte) =>
        parseInt(byte, 16),
      );
      const timestamp = new DataView(bytes.buffer).getUint32(68, true);
      if (timestamp === 0) throw new Error('Invalid block timestamp.');
      return timestamp;
    });
    this.blockTimes.set(height, request);
    // Failed metadata is retryable on the next synchronization, not cached forever.
    void request.catch(() => {
      if (this.blockTimes.get(height) === request)
        this.blockTimes.delete(height);
    });
    if (this.blockTimes.size > MAX_CACHED_BLOCKS) {
      this.blockTimes.delete(this.blockTimes.keys().next().value!);
    }
    return request;
  }

  async annotate(utxos: ElectrumUtxo[]): Promise<ElectrumUtxo[]> {
    const generation = this.generation;
    return mapWithConcurrency(utxos, 6, async (utxo) => {
      if (generation !== this.generation) return utxo;
      if (utxo.height > 0) {
        this.firstSeen.delete(utxo.txid);
        try {
          return { ...utxo, blockTime: await this.blockTime(utxo.height) };
        } catch {
          // An unavailable date is shown explicitly; financial data stays intact.
          return utxo;
        }
      }
      const firstSeenAt =
        this.firstSeen.get(utxo.txid) ?? Math.floor(Date.now() / 1_000);
      this.firstSeen.set(utxo.txid, firstSeenAt);
      if (this.firstSeen.size > MAX_PENDING_TRANSACTIONS) {
        this.firstSeen.delete(this.firstSeen.keys().next().value!);
      }
      return { ...utxo, firstSeenAt };
    });
  }
}
