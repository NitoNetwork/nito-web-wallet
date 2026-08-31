const NITO_EXPLORER_TRANSACTION_URL =
  'https://mempool-explorer.nito.network/tx/';

export const nitoTransactionExplorerUrl = (txid: string): string => {
  const normalized = txid.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(
      'A valid transaction id is required for the explorer link.',
    );
  }
  return `${NITO_EXPLORER_TRANSACTION_URL}${normalized}`;
};
