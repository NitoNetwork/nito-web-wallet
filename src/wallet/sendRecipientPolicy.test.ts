import { describe, expect, it } from 'vitest';
import { prepareMaxRecipients } from './sendRecipientPolicy';

describe('recipient amounts for MAX', () => {
  const recipients = ['5000', '', '5000', '5000'].map((amount, i) => ({ address: String(i), amount }));

  it.each([0, 1, 2, 3])('fills row %i and preserves the amounts on either side', (selected) => {
    const { outputs, targetIndex } = prepareMaxRecipients(recipients, selected);
    expect(outputs[targetIndex]).toEqual({ address: String(selected), amountSats: BigInt(0) });
    expect(outputs.filter((_, i) => i !== targetIndex)).toEqual(
      recipients.filter((row, i) => i !== selected && row.amount).map(row =>
        ({ address: row.address, amountSats: BigInt(500_000_000_000) })),
    );
  });

  it('requires the selected address and preserves invalid drafts for correction', () => {
    expect(() => prepareMaxRecipients([{ address: '', amount: '' }], 0)).toThrow();
    for (const other of [{ address: '', amount: '5' }, { address: 'a', amount: 'bad' }]) {
      expect(() => prepareMaxRecipients([recipients[0]!, other], 0)).toThrow();
    }
  });
});
