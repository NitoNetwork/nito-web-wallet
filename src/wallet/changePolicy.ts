import {
  HD_ACCOUNT_TEMPLATES,
  type HdAccountKey,
} from '../domain/wallet-policy';
import { scriptPubKeyForNitoAddress } from '../network/electrum';
import { TransparentSendError } from './transparentSend';

const PRIORITY: readonly HdAccountKey[] = [
  'taproot',
  'bech32',
  'p2sh',
  'legacy',
];

/** Bitcoin Core v30.0 CWallet::TransactionChangeType, without a changetype override.
 * Match the most modern supported recipient family; otherwise prefer the most
 * modern witness family the wallet can actually sign. Never select from inputs.
 * https://github.com/bitcoin/bitcoin/blob/v30.0/src/wallet/wallet.cpp
 */
export function automaticChangeAccount(
  recipientAddresses: readonly string[],
  available: readonly HdAccountKey[],
): HdAccountKey {
  const recipients = new Set<HdAccountKey>();
  for (const address of recipientAddresses) {
    if (!address.trim())
      throw new TransparentSendError('recipient-address-required');
    let script: Uint8Array;
    try {
      script = scriptPubKeyForNitoAddress(address.trim());
    } catch {
      throw new TransparentSendError('recipient-address-invalid');
    }
    if (script.length === 34 && script[0] === 0x51) recipients.add('taproot');
    else if (script.length === 22 && script[0] === 0) recipients.add('bech32');
    else if (script.length === 23 && script[0] === 0xa9) recipients.add('p2sh');
    else if (script.length === 25 && script[0] === 0x76)
      recipients.add('legacy');
    else throw new TransparentSendError('recipient-address-invalid');
  }
  const selected =
    PRIORITY.find((key) => available.includes(key) && recipients.has(key)) ??
    PRIORITY.find((key) => available.includes(key));
  if (!selected) throw new TransparentSendError('change-address-unavailable');
  return selected;
}

export function changeAccountForWallet(
  recipientAddresses: readonly string[],
  wallet: { hd: boolean; primaryAddresses: readonly { scriptType: string }[] },
): HdAccountKey {
  const available = HD_ACCOUNT_TEMPLATES.filter(
    (template) =>
      wallet.hd ||
      (template.key !== 'taproot' &&
        wallet.primaryAddresses.some(
          (address) => address.scriptType === template.scriptType,
        )),
  );
  return automaticChangeAccount(
    recipientAddresses,
    available.map((template) => template.key),
  );
}
