import type { ElectrumHistoryEntry, ElectrumUtxo } from '../network/electrum';
import { mergeWalletHistoryPublication } from '../services/walletHistory';
import {
  rebuildTransparentWalletSnapshot,
  TransparentSnapshotIntegrityError,
  type ScannedAddress,
  type TransparentWalletSnapshot,
} from './transparentScan';

export type WalletOwnedTransactionInput = Readonly<{
  txid: string;
  vout: number;
  valueSats: number;
  address: string;
}>;

export type WalletOwnedTransactionOutput = Readonly<{
  vout: number;
  valueSats: number;
  address: string;
}>;

export type AcceptedTransparentTransaction = Readonly<{
  txid: string;
  inputs: readonly WalletOwnedTransactionInput[];
  outputs: readonly WalletOwnedTransactionOutput[];
}>;

const outpointKey = (txid: string, vout: number) =>
  `${txid.toLowerCase()}:${vout}`;

const assertTxid = (txid: string, label: string) => {
  if (!/^[0-9a-f]{64}$/u.test(txid)) {
    throw new TransparentSnapshotIntegrityError(
      `${label} is not a valid transaction id`,
    );
  }
};

const assertOutputIndex = (vout: number, label: string) => {
  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new TransparentSnapshotIntegrityError(
      `${label} has an invalid output index`,
    );
  }
};

const assertValue = (valueSats: number, label: string) => {
  if (!Number.isSafeInteger(valueSats) || valueSats < 0) {
    throw new TransparentSnapshotIntegrityError(
      `${label} has an invalid value`,
    );
  }
};

const balanceFromUtxos = (utxos: readonly ElectrumUtxo[]) => {
  let confirmedSats = 0;
  let unconfirmedSats = 0;
  for (const utxo of utxos) {
    if (utxo.confirmations > 0) confirmedSats += utxo.valueSats;
    else unconfirmedSats += utxo.valueSats;
    if (
      !Number.isSafeInteger(confirmedSats) ||
      !Number.isSafeInteger(unconfirmedSats)
    ) {
      throw new TransparentSnapshotIntegrityError(
        'projected transaction balance exceeds the safe integer range',
      );
    }
  }
  const totalSats = confirmedSats + unconfirmedSats;
  if (!Number.isSafeInteger(totalSats)) {
    throw new TransparentSnapshotIntegrityError(
      'projected transaction balance exceeds the safe integer range',
    );
  }
  return { confirmedSats, unconfirmedSats, totalSats };
};

const validateAcceptedTransaction = (
  snapshot: TransparentWalletSnapshot,
  transaction: AcceptedTransparentTransaction,
) => {
  assertTxid(transaction.txid, 'accepted transaction');
  if (transaction.inputs.length === 0) {
    throw new TransparentSnapshotIntegrityError(
      'accepted transaction has no wallet input',
    );
  }

  const knownAddresses = new Set(
    snapshot.addresses.map(({ address }) => address),
  );
  const knownUtxos = new Map(
    snapshot.utxos.map(
      (utxo) => [outpointKey(utxo.txid, utxo.vout), utxo] as const,
    ),
  );
  const inputOutpoints = new Set<string>();
  for (const input of transaction.inputs) {
    assertTxid(input.txid, 'wallet input');
    assertOutputIndex(input.vout, 'wallet input');
    assertValue(input.valueSats, 'wallet input');
    const key = outpointKey(input.txid, input.vout);
    if (inputOutpoints.has(key)) {
      throw new TransparentSnapshotIntegrityError(
        'accepted transaction repeats a wallet input',
      );
    }
    inputOutpoints.add(key);
    const known = knownUtxos.get(key);
    if (
      !known ||
      known.address !== input.address ||
      known.valueSats !== input.valueSats
    ) {
      throw new TransparentSnapshotIntegrityError(
        'accepted transaction wallet input does not match the current snapshot',
      );
    }
  }

  const outputIndexes = new Set<number>();
  for (const output of transaction.outputs) {
    assertOutputIndex(output.vout, 'wallet output');
    assertValue(output.valueSats, 'wallet output');
    if (!knownAddresses.has(output.address)) {
      throw new TransparentSnapshotIntegrityError(
        'accepted transaction contains an unknown wallet output',
      );
    }
    if (outputIndexes.has(output.vout)) {
      throw new TransparentSnapshotIntegrityError(
        'accepted transaction repeats a wallet output',
      );
    }
    outputIndexes.add(output.vout);
  }
};

export const acceptedTransactionAddresses = (
  transaction: AcceptedTransparentTransaction,
): string[] => [
  ...new Set([
    ...transaction.inputs.map(({ address }) => address),
    ...transaction.outputs.map(({ address }) => address),
  ]),
];

export const projectAcceptedTransparentTransaction = (
  snapshot: TransparentWalletSnapshot,
  transaction: AcceptedTransparentTransaction,
): TransparentWalletSnapshot => {
  validateAcceptedTransaction(snapshot, transaction);
  const inputOutpoints = new Set(
    transaction.inputs.map((input) => outpointKey(input.txid, input.vout)),
  );
  const affectedAddresses = new Set(acceptedTransactionAddresses(transaction));
  const outputsByAddress = new Map<string, ElectrumUtxo[]>();
  for (const output of transaction.outputs) {
    const outputs = outputsByAddress.get(output.address) ?? [];
    outputs.push({
      txid: transaction.txid,
      vout: output.vout,
      valueSats: output.valueSats,
      height: 0,
      confirmations: 0,
      address: output.address,
    });
    outputsByAddress.set(output.address, outputs);
  }

  const addresses = snapshot.addresses.map((address): ScannedAddress => {
    if (!affectedAddresses.has(address.address)) return address;
    const utxos = [
      ...address.utxos.filter(
        (utxo) => !inputOutpoints.has(outpointKey(utxo.txid, utxo.vout)),
      ),
      ...(outputsByAddress.get(address.address) ?? []),
    ];
    const projectedHistory: ElectrumHistoryEntry = {
      txid: transaction.txid,
      height: 0,
      address: address.address,
    };
    return {
      ...address,
      balance: balanceFromUtxos(utxos),
      utxos,
      history: mergeWalletHistoryPublication(
        address.history,
        [projectedHistory],
        'partial',
      ),
      used: true,
    };
  });

  return rebuildTransparentWalletSnapshot(snapshot, addresses);
};

export const acceptedTransactionIsVisible = (
  snapshot: TransparentWalletSnapshot,
  transaction: AcceptedTransparentTransaction,
): boolean => {
  const currentUtxos = new Map(
    snapshot.utxos.map(
      (utxo) => [outpointKey(utxo.txid, utxo.vout), utxo] as const,
    ),
  );
  const inputsAreSpent = transaction.inputs.every(
    (input) => !currentUtxos.has(outpointKey(input.txid, input.vout)),
  );
  const outputsAreVisible = transaction.outputs.every((output) => {
    const utxo = currentUtxos.get(outpointKey(transaction.txid, output.vout));
    return (
      utxo?.address === output.address && utxo.valueSats === output.valueSats
    );
  });
  return inputsAreSpent && outputsAreVisible;
};

export const walletTransactionIsUnconfirmed = (
  snapshot: TransparentWalletSnapshot,
  txid: string,
): boolean => {
  const entries = snapshot.history.filter(
    (entry) => entry.txid.toLowerCase() === txid.toLowerCase(),
  );
  return entries.length > 0 && entries.every((entry) => entry.height <= 0);
};

const validateReplacementTransaction = (
  snapshot: TransparentWalletSnapshot,
  original: AcceptedTransparentTransaction,
  replacement: AcceptedTransparentTransaction,
) => {
  assertTxid(original.txid, 'original transaction');
  assertTxid(replacement.txid, 'replacement transaction');
  if (original.txid.toLowerCase() === replacement.txid.toLowerCase()) {
    throw new TransparentSnapshotIntegrityError(
      'replacement transaction must have a different transaction id',
    );
  }
  if (!walletTransactionIsUnconfirmed(snapshot, original.txid)) {
    throw new TransparentSnapshotIntegrityError(
      'only an unconfirmed wallet transaction can be replaced',
    );
  }
  if (original.inputs.length !== replacement.inputs.length) {
    throw new TransparentSnapshotIntegrityError(
      'replacement transaction inputs differ from the original transaction',
    );
  }
  const originalInputs = new Map(
    original.inputs.map((input) => [
      outpointKey(input.txid, input.vout),
      input,
    ]),
  );
  for (const input of replacement.inputs) {
    const expected = originalInputs.get(outpointKey(input.txid, input.vout));
    if (
      !expected ||
      expected.address !== input.address ||
      expected.valueSats !== input.valueSats
    ) {
      throw new TransparentSnapshotIntegrityError(
        'replacement transaction inputs differ from the original transaction',
      );
    }
  }
  const currentUtxos = new Map(
    snapshot.utxos.map((utxo) => [outpointKey(utxo.txid, utxo.vout), utxo]),
  );
  if (
    original.inputs.some((input) =>
      currentUtxos.has(outpointKey(input.txid, input.vout)),
    )
  ) {
    throw new TransparentSnapshotIntegrityError(
      'original transaction inputs are no longer in a replaceable state',
    );
  }
  for (const output of original.outputs) {
    const current = currentUtxos.get(outpointKey(original.txid, output.vout));
    if (
      !current ||
      current.address !== output.address ||
      current.valueSats !== output.valueSats
    ) {
      throw new TransparentSnapshotIntegrityError(
        'original wallet outputs are no longer in a replaceable state',
      );
    }
  }

  const knownAddresses = new Set(
    snapshot.addresses.map(({ address }) => address),
  );
  const outputIndexes = new Set<number>();
  for (const output of replacement.outputs) {
    assertOutputIndex(output.vout, 'replacement wallet output');
    assertValue(output.valueSats, 'replacement wallet output');
    if (!knownAddresses.has(output.address) || outputIndexes.has(output.vout)) {
      throw new TransparentSnapshotIntegrityError(
        'replacement transaction contains an invalid wallet output',
      );
    }
    outputIndexes.add(output.vout);
  }
};

export const projectReplacementTransparentTransaction = (
  snapshot: TransparentWalletSnapshot,
  original: AcceptedTransparentTransaction,
  replacement: AcceptedTransparentTransaction,
): TransparentWalletSnapshot => {
  validateReplacementTransaction(snapshot, original, replacement);
  const affectedAddresses = new Set([
    ...acceptedTransactionAddresses(original),
    ...acceptedTransactionAddresses(replacement),
  ]);
  const outputsByAddress = new Map<string, ElectrumUtxo[]>();
  for (const output of replacement.outputs) {
    const outputs = outputsByAddress.get(output.address) ?? [];
    outputs.push({
      txid: replacement.txid,
      vout: output.vout,
      valueSats: output.valueSats,
      height: 0,
      confirmations: 0,
      address: output.address,
    });
    outputsByAddress.set(output.address, outputs);
  }

  const addresses = snapshot.addresses.map((address): ScannedAddress => {
    if (!affectedAddresses.has(address.address)) return address;
    const utxos = [
      ...address.utxos.filter(
        (utxo) => utxo.txid.toLowerCase() !== original.txid.toLowerCase(),
      ),
      ...(outputsByAddress.get(address.address) ?? []),
    ];
    const history = address.history.filter(
      (entry) => entry.txid.toLowerCase() !== original.txid.toLowerCase(),
    );
    history.push({
      txid: replacement.txid,
      height: 0,
      address: address.address,
    });
    return {
      ...address,
      balance: balanceFromUtxos(utxos),
      utxos,
      history,
      used: true,
    };
  });
  return rebuildTransparentWalletSnapshot(snapshot, addresses);
};
