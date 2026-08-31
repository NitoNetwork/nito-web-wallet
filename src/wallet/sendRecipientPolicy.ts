import { DUST_LIMIT_SATS, parseNitoAmountToSats } from './transparentSend';

export type RecipientAmountDraft = {
  amount: string;
};

export const shouldOfferMaxForRecipient = (
  recipients: readonly RecipientAmountDraft[],
  targetIndex: number,
  spendableSats: number,
) => {
  if (
    recipients.length === 0 ||
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= recipients.length ||
    !Number.isSafeInteger(spendableSats) ||
    spendableSats < 0
  ) {
    return false;
  }

  if (recipients.length === 1) return targetIndex === 0;
  if (targetIndex !== recipients.length - 1) return false;

  let allocatedSats = BigInt(0);
  try {
    for (const recipient of recipients.slice(0, targetIndex)) {
      allocatedSats += parseNitoAmountToSats(recipient.amount);
    }
  } catch {
    return false;
  }

  return BigInt(spendableSats) - allocatedSats >= DUST_LIMIT_SATS;
};
