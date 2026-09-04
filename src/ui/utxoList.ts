import type { ElectrumUtxo } from '../network/electrum';

export const UTXO_PAGE_SIZE = 5;

export const sortedUtxos = (utxos: readonly ElectrumUtxo[]) =>
  [...utxos].sort((a, b) => {
    const pendingOrder = Number(b.height <= 0) - Number(a.height <= 0);
    if (pendingOrder) return pendingOrder;
    const timeA = a.height > 0 ? a.blockTime : a.firstSeenAt;
    const timeB = b.height > 0 ? b.blockTime : b.firstSeenAt;
    return (
      (timeB ?? 0) - (timeA ?? 0) ||
      b.height - a.height ||
      a.txid.localeCompare(b.txid) ||
      a.vout - b.vout
    );
  });

export const utxoConfirmations = (utxo: ElectrumUtxo, blockHeight: number) =>
  utxo.height <= 0
    ? 0
    : blockHeight > 0
      ? Math.max(0, blockHeight - utxo.height + 1)
      : utxo.confirmations;

export const utxoPage = (
  utxos: readonly ElectrumUtxo[],
  requestedPage: number,
) => {
  const pageCount = Math.max(1, Math.ceil(utxos.length / UTXO_PAGE_SIZE));
  const page = Math.max(
    1,
    Math.min(
      pageCount,
      Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1,
    ),
  );
  return {
    page,
    pageCount,
    rows: utxos.slice((page - 1) * UTXO_PAGE_SIZE, page * UTXO_PAGE_SIZE),
  };
};
