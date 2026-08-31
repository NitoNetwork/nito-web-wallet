import { describe, expect, it } from 'vitest';

import { shouldOfferMaxForRecipient } from './sendRecipientPolicy';

describe('multi-recipient MAX policy', () => {
  it('offers MAX on the only recipient', () => {
    expect(shouldOfferMaxForRecipient([{ amount: '' }], 0, 0)).toBe(true);
  });

  it('offers MAX only on the last recipient after every preceding amount is valid', () => {
    const recipients = [{ amount: '0.1' }, { amount: '0.2' }, { amount: '' }];

    expect(shouldOfferMaxForRecipient(recipients, 0, 100_000_000)).toBe(false);
    expect(shouldOfferMaxForRecipient(recipients, 1, 100_000_000)).toBe(false);
    expect(shouldOfferMaxForRecipient(recipients, 2, 100_000_000)).toBe(true);
  });

  it('hides MAX again when a preceding amount is cleared or invalid', () => {
    expect(
      shouldOfferMaxForRecipient(
        [{ amount: '' }, { amount: '' }],
        1,
        100_000_000,
      ),
    ).toBe(false);
    expect(
      shouldOfferMaxForRecipient(
        [{ amount: '0.000000001' }, { amount: '' }],
        1,
        100_000_000,
      ),
    ).toBe(false);
  });

  it('hides MAX when fixed recipients leave no spendable output', () => {
    expect(
      shouldOfferMaxForRecipient(
        [{ amount: '0.999995' }, { amount: '' }],
        1,
        100_000_000,
      ),
    ).toBe(false);
  });
});
