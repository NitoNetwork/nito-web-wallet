import { parseNitoAmountToSats, TransparentSendError, type TransparentSendOutput } from './transparentSend';

export function prepareMaxRecipients(
  recipients: readonly { address: string; amount: string }[],
  selected: number,
  parseAmount: (amount: string) => bigint = parseNitoAmountToSats,
) {
  if (!recipients[selected]?.address.trim()) throw new TransparentSendError('max-recipient-unavailable');
  const outputs: TransparentSendOutput[] = [];
  let targetIndex = 0;
  recipients.forEach(({ address, amount }, index) => {
    if (index === selected) {
      targetIndex = outputs.length;
      outputs.push({ address: address.trim(), amountSats: BigInt(0) });
    } else if (amount.trim()) {
      if (!address.trim()) throw new TransparentSendError('recipient-address-required');
      outputs.push({ address: address.trim(), amountSats: parseAmount(amount) });
    }
  });
  return { outputs, targetIndex };
}
