import { describe, expect, it } from 'vitest';

import { nitoTransactionExplorerUrl } from './explorer';

describe('NITO explorer links', () => {
  it('builds a canonical HTTPS transaction link', () => {
    const txid = 'AB'.repeat(32);
    expect(nitoTransactionExplorerUrl(txid)).toBe(
      `https://mempool-explorer.nito.network/tx/${txid.toLowerCase()}`,
    );
  });

  it('rejects malformed transaction identifiers', () => {
    expect(() => nitoTransactionExplorerUrl('javascript:alert(1)')).toThrow();
  });
});
