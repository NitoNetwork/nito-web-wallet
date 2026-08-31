import type { ElectrumHistoryEntry } from '../network/electrum';

export type EnrichedHistoryRecord = {
  txid: string;
  height: number;
  amountSats: number;
  direction: 'received' | 'sent' | 'self';
  feeSats: number;
  counterparty: string;
  blockTime: number | null;
};

export type WalletHistoryPublicationMode = 'partial' | 'authoritative';

export const needsHistoryEnrichment = (
  entry: {
    height?: number;
    direction?: unknown;
    provisional?: boolean;
    blockTime?: number | null;
  },
): boolean => (
  entry.direction === undefined
  || entry.provisional === true
  || (typeof entry.height === 'number' && entry.height > 0 && entry.blockTime == null)
);

const mergeEnrichment = (
  base: ElectrumHistoryEntry,
  other: ElectrumHistoryEntry | undefined,
): ElectrumHistoryEntry => {
  if (!other || !needsHistoryEnrichment(base)) return base;
  if (other.direction === undefined) return base;

  // Same height: both describe the same confirmed state, take it as final.
  if (other.height === base.height) {
    return {
      ...base,
      direction: other.direction,
      amountSats: other.amountSats,
      feeSats: other.feeSats,
      counterparty: other.counterparty,
      blockTime: other.blockTime,
      provisional: other.provisional,
    };
  }

  // Different heights means the amounts come from a mempool sighting of a now
  // confirmed transaction. Carry the stable fields so the row is readable at
  // once, but never the block time — a mempool entry has none, and writing its
  // null would strand the row without a date. The entry stays provisional so
  // the confirmed block, which alone is authoritative, still overwrites it.
  return {
    ...base,
    direction: other.direction,
    amountSats: other.amountSats,
    feeSats: other.feeSats,
    counterparty: other.counterparty,
    provisional: true,
  };
};

export const normalizeWalletHistory = (history: ElectrumHistoryEntry[]) => {
  const byTxid = new Map<string, ElectrumHistoryEntry>();

  for (const entry of history) {
    const existing = byTxid.get(entry.txid);
    const winner = !existing
      || entry.height > existing.height
      || (entry.height === existing.height && entry.address < existing.address)
      ? entry
      : existing;
    const loser = winner === entry ? existing : entry;
    byTxid.set(entry.txid, mergeEnrichment(winner, loser));
  }

  return [...byTxid.values()].sort((a, b) => {
    const aMempool = a.height <= 0;
    const bMempool = b.height <= 0;
    if (aMempool !== bMempool) {
      return aMempool ? -1 : 1;
    }

    if (aMempool && bMempool) {
      return a.txid.localeCompare(b.txid);
    }

    if (a.height !== b.height) {
      return b.height - a.height;
    }

    return a.txid.localeCompare(b.txid);
  });
};

export const mergeWalletHistoryPublication = (
  current: readonly ElectrumHistoryEntry[],
  incoming: readonly ElectrumHistoryEntry[],
  mode: WalletHistoryPublicationMode,
): ElectrumHistoryEntry[] => {
  if (mode === 'partial') {
    return normalizeWalletHistory([...current, ...incoming]);
  }

  const currentByTxid = new Map(
    normalizeWalletHistory([...current]).map((entry) => [entry.txid, entry]),
  );
  return normalizeWalletHistory([...incoming]).map((entry) => (
    mergeEnrichment(entry, currentByTxid.get(entry.txid))
  ));
};
