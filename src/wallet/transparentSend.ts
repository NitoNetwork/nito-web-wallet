import * as btc from '@scure/btc-signer';

import type { HdSigner, SingleKeySigner } from '../crypto/workerProtocol';
import { scriptPubKeyForNitoAddress } from '../network/electrum';
import { isTransparentUtxoSpendable } from './coinbaseMaturity';
import type {
  ScannedAddress,
  TransparentWalletSnapshot,
} from './transparentScan';

export const NITO_SIGNER_NETWORK = {
  bech32: 'nito',
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4,
  },
};

export const DEFAULT_FEE_PER_VBYTE = BigInt(2);
export const RBF_NETWORK_FEE_MARGIN_PERCENT = BigInt(20);

export const addRbfNetworkFeeMargin = (feePerVbyte: bigint) => {
  validateFeeRate(feePerVbyte);
  return (
    feePerVbyte * (BigInt(100) + RBF_NETWORK_FEE_MARGIN_PERCENT) +
    BigInt(99)
  ) / BigInt(100);
};
export const DUST_LIMIT_SATS = BigInt(546);
export const MAX_SEND_RECIPIENTS = 20;
export const RBF_SEQUENCE = 0xffff_fffd;
const MAX_FEE_PER_VBYTE = BigInt(10_000);
const RBF_MINIMUM_ABSOLUTE_INCREASE_PER_VBYTE = BigInt(1);

export type TransparentSendErrorCode =
  | 'invalid-amount-format'
  | 'amount-not-positive'
  | 'amount-below-dust'
  | 'invalid-fee-rate'
  | 'signing-material-unavailable'
  | 'legacy-signing-data-unavailable'
  | 'no-spendable-utxo'
  | 'change-address-unavailable'
  | 'change-address-not-owned'
  | 'recipient-required'
  | 'too-many-recipients'
  | 'recipient-address-required'
  | 'recipient-address-invalid'
  | 'recipient-output-dust'
  | 'max-recipient-unavailable'
  | 'insufficient-funds'
  | 'selected-input-unresolved'
  | 'signed-transaction-mismatch'
  | 'signature-invalid'
  | 'transaction-too-large'
  | 'rbf-unavailable'
  | 'rbf-original-mismatch'
  | 'rbf-transaction-confirmed'
  | 'rbf-insufficient-funds'
  | 'rbf-replacement-fee'
  | 'consolidation-not-enough-utxos'
  | 'consolidation-unavailable'
  | 'consolidation-too-large';

export class TransparentSendError extends Error {
  readonly code: TransparentSendErrorCode;
  readonly detail?: unknown;

  constructor(code: TransparentSendErrorCode, detail?: unknown) {
    super(code);
    this.name = 'TransparentSendError';
    this.code = code;
    this.detail = detail;
  }
}

export const assertTransparentSendFitsAvailable = (
  fitsAvailable: boolean,
): void => {
  if (!fitsAvailable) throw new TransparentSendError('insufficient-funds');
};

export type TransparentSendOutput = {
  address: string;
  amountSats: bigint;
};

export type MaxTransparentSendAmount = {
  amountSats: bigint;
  feeSats: number;
  inputCount: number;
  outputCount: number;
  changeUsed: boolean;
};

export type TransparentSendEstimate = Omit<
  MaxTransparentSendAmount,
  'amountSats'
> & {
  amountSats: bigint;
  totalSats: bigint;
  fitsAvailable: boolean;
};

export type PreparedTransparentTx = {
  txid: string;
  hex: string;
  feeSats: number;
  inputCount: number;
  outputCount: number;
  changeUsed: boolean;
  walletInputs: {
    txid: string;
    vout: number;
    valueSats: number;
    address: string;
  }[];
  walletOutputs: {
    vout: number;
    valueSats: number;
    address: string;
  }[];
};

export type PreparedTransparentSend = PreparedTransparentTx & {
  recipients: TransparentSendOutput[];
};

export type TransparentRbfCancellationQuote = {
  replacesTxid: string;
  returnAddress: string;
  originalFeeSats: number;
  feeSats: number;
  outputSats: number;
  estimatedVbytes: number;
  feePerVbyte: bigint;
};

export type PreparedTransparentRbfCancellation = PreparedTransparentTx & {
  replacesTxid: string;
};

export type TransparentConsolidationPlan = {
  transactions: Array<{
    outpoints: Array<{ txid: string; vout: number }>;
    outputs: TransparentSendOutput[];
    feeSats: number;
    inputCount: number;
    outputCount: number;
  }>;
  inputCount: number;
  outputCount: number;
  totalFeeSats: number;
};

export type PreparedTransparentConsolidation = {
  transactions: PreparedTransparentTx[];
  inputCount: number;
  outputCount: number;
  totalFeeSats: number;
};

export type TransparentPsbtSigner = (
  sessionId: string,
  psbtBase64: string,
  signers: HdSigner[] | SingleKeySigner[],
) => Promise<{ psbtBase64: string }>;

export const parseNitoAmountToSats = (amount: string) => {
  const normalized = amount
    .trim()
    .replace(/[\s\u00a0\u202f']/gu, '')
    .replace(',', '.');
  if (normalized.length > 32 || !/^\d+(\.\d{1,8})?$/u.test(normalized)) {
    throw new TransparentSendError('invalid-amount-format');
  }

  const [whole = '0', fraction = ''] = normalized.split('.');
  const sats =
    BigInt(whole) * BigInt(100_000_000) + BigInt(fraction.padEnd(8, '0'));
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TransparentSendError('invalid-amount-format');
  }
  if (sats <= 0) throw new TransparentSendError('amount-not-positive');
  if (sats < DUST_LIMIT_SATS)
    throw new TransparentSendError('amount-below-dust');
  return sats;
};

const validateFeeRate = (feePerVbyte: bigint) => {
  if (feePerVbyte < BigInt(1) || feePerVbyte > MAX_FEE_PER_VBYTE) {
    throw new TransparentSendError('invalid-fee-rate');
  }
};

const bytesToHex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
const hexToBytes = (value: string) =>
  Uint8Array.from(value.match(/.{1,2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
const bytesToBase64 = (value: Uint8Array) =>
  btoa(String.fromCodePoint(...value));
const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.codePointAt(0) ?? 0);

const cloneInput = (input: Record<string, unknown>) => ({
  ...input,
  witnessUtxo:
    input.witnessUtxo && typeof input.witnessUtxo === 'object'
      ? { ...(input.witnessUtxo as Record<string, unknown>) }
      : input.witnessUtxo,
});

const signerFor = (
  owner: ScannedAddress,
  txid: string,
  vout: number,
): HdSigner | SingleKeySigner =>
  owner.ownerKind === 'hd'
    ? { txid, vout, path: owner.path, scriptType: owner.scriptType }
    : {
        txid,
        vout,
        scriptType: owner.scriptType,
        publicKeyCompressed: owner.publicKeyCompressed,
      };

type PreparedSpendableInput = {
  input: Record<string, unknown>;
  signer: HdSigner | SingleKeySigner;
  valueSats: number;
  address: string;
};

const validateOwnerMaterial = (owner: ScannedAddress) => {
  let expectedScript: Uint8Array;
  try {
    expectedScript = scriptPubKeyForNitoAddress(owner.address);
  } catch (caught) {
    throw new TransparentSendError('signing-material-unavailable', caught);
  }
  if (bytesToHex(expectedScript) !== owner.scriptHex.toLowerCase()) {
    throw new TransparentSendError(
      'signing-material-unavailable',
      new Error(`Stored script mismatch for ${owner.address}.`),
    );
  }
};

const prepareSpendableInputs = (snapshot: TransparentWalletSnapshot) => {
  const owners = new Map(
    snapshot.addresses.map((address) => [address.address, address]),
  );
  const spendable: PreparedSpendableInput[] = [];

  for (const utxo of snapshot.utxos.filter(isTransparentUtxoSpendable)) {
    const owner = owners.get(utxo.address);
    if (!owner) {
      throw new TransparentSendError(
        'signing-material-unavailable',
        new Error(`No owner for ${utxo.txid}:${utxo.vout}.`),
      );
    }
    validateOwnerMaterial(owner);
    const script = hexToBytes(owner.scriptHex);
    const input: Record<string, unknown> = {
      address: owner.address,
      script,
      txid: utxo.txid,
      index: utxo.vout,
      sequence: RBF_SEQUENCE,
      ...(owner.redeemScriptHex
        ? { redeemScript: hexToBytes(owner.redeemScriptHex) }
        : {}),
      ...(owner.tapInternalKeyHex
        ? { tapInternalKey: hexToBytes(owner.tapInternalKeyHex) }
        : {}),
    };
    if (owner.scriptType === 'p2pkh') {
      if (!utxo.rawTx) {
        throw new TransparentSendError('legacy-signing-data-unavailable');
      }
      input.nonWitnessUtxo = utxo.rawTx;
    } else {
      input.witnessUtxo = { script, amount: BigInt(utxo.valueSats) };
    }
    spendable.push({
      input,
      signer: signerFor(owner, utxo.txid, utxo.vout),
      valueSats: utxo.valueSats,
      address: utxo.address,
    });
  }

  if (spendable.length === 0)
    throw new TransparentSendError('no-spendable-utxo');
  return {
    spendable,
    totalSats: spendable.reduce(
      (total, candidate) => total + BigInt(candidate.valueSats),
      BigInt(0),
    ),
  };
};

const resolveChangeAddress = (
  snapshot: TransparentWalletSnapshot,
  changeAddress?: string,
) => {
  const normalized = changeAddress?.trim();
  if (normalized) {
    const owner = snapshot.addresses.find(
      (address) => address.address === normalized,
    );
    if (!owner) throw new TransparentSendError('change-address-not-owned');
    if (snapshot.sourceKind !== 'single-private-key') {
      if (owner.ownerKind !== 'hd' || owner.branch !== 'internal') {
        throw new TransparentSendError('change-address-not-owned');
      }
    }
    validateOwnerMaterial(owner);
    return normalized;
  }
  if (snapshot.sourceKind !== 'single-private-key') {
    throw new TransparentSendError('change-address-unavailable');
  }
  const fallback =
    snapshot.addresses.find((address) => address.scriptType === 'p2wpkh') ??
    snapshot.addresses[0];
  if (!fallback) throw new TransparentSendError('change-address-unavailable');
  validateOwnerMaterial(fallback);
  return fallback.address;
};

const normalizeSendOutputs = (outputs: readonly TransparentSendOutput[]) => {
  if (outputs.length === 0)
    throw new TransparentSendError('recipient-required');
  if (outputs.length > MAX_SEND_RECIPIENTS) {
    throw new TransparentSendError('too-many-recipients');
  }
  return outputs.map((output) => {
    const address = output.address.trim();
    if (!address) throw new TransparentSendError('recipient-address-required');
    try {
      scriptPubKeyForNitoAddress(address);
    } catch (caught) {
      throw new TransparentSendError('recipient-address-invalid', caught);
    }
    if (output.amountSats < DUST_LIMIT_SATS) {
      throw new TransparentSendError('recipient-output-dust');
    }
    return { address, amountSats: output.amountSats };
  });
};

const selectSpend = ({
  spendable,
  outputs,
  feePerVbyte,
  changeAddress,
}: {
  spendable: PreparedSpendableInput[];
  outputs: { address: string; amount: bigint }[];
  feePerVbyte: bigint;
  changeAddress: string;
}) => {
  validateFeeRate(feePerVbyte);
  const inputs = spendable.map(({ input }) => cloneInput(input)) as Parameters<
    typeof btc.selectUTXO
  >[0];
  return btc.selectUTXO(
    inputs,
    outputs.map((output) => ({
      address: output.address,
      amount: output.amount,
    })),
    'default',
    {
      changeAddress,
      feePerByte: feePerVbyte,
      bip69: true,
      createTx: true,
      network: NITO_SIGNER_NETWORK,
    },
  );
};

type CalculateMaxTransparentSendAmountArgs = {
  snapshot: TransparentWalletSnapshot;
  feePerVbyte?: bigint;
  changeAddress?: string;
} & (
  | { toAddress: string; outputs?: never; targetIndex?: never }
  | { toAddress?: never; outputs: TransparentSendOutput[]; targetIndex: number }
);

export const calculateMaxTransparentSendAmount = async (
  args: CalculateMaxTransparentSendAmountArgs,
): Promise<MaxTransparentSendAmount> => {
  const { snapshot, feePerVbyte = DEFAULT_FEE_PER_VBYTE, changeAddress } = args;
  validateFeeRate(feePerVbyte);
  const { spendable, totalSats } = prepareSpendableInputs(snapshot);
  const resolvedChangeAddress = resolveChangeAddress(snapshot, changeAddress);
  const multiOutputs = args.outputs;
  const targetIndex = multiOutputs ? args.targetIndex : 0;
  const candidateOutputs = multiOutputs
    ? multiOutputs.map((output) => ({
        ...output,
        address: output.address.trim(),
      }))
    : [{ address: args.toAddress.trim(), amountSats: BigInt(0) }];
  if (
    targetIndex < 0 ||
    targetIndex >= candidateOutputs.length ||
    !candidateOutputs[targetIndex]?.address
  ) {
    throw new TransparentSendError('max-recipient-unavailable');
  }
  try {
    scriptPubKeyForNitoAddress(candidateOutputs[targetIndex]!.address);
  } catch (caught) {
    throw new TransparentSendError('recipient-address-invalid', caught);
  }
  const fixedOutputs = candidateOutputs.filter(
    (_, index) => index !== targetIndex,
  );
  if (fixedOutputs.length > 0) normalizeSendOutputs(fixedOutputs);
  const fixedTotalSats = fixedOutputs.reduce(
    (total, output) => total + output.amountSats,
    BigInt(0),
  );
  let low = DUST_LIMIT_SATS;
  let high = totalSats - fixedTotalSats;
  let best: MaxTransparentSendAmount | null = null;

  while (low <= high) {
    const amountSats = (low + high) / BigInt(2);
    const selected = selectSpend({
      spendable,
      outputs: candidateOutputs.map((output, index) => ({
        address: output.address,
        amount: index === targetIndex ? amountSats : output.amountSats,
      })),
      feePerVbyte,
      changeAddress: resolvedChangeAddress,
    });
    if (selected?.tx) {
      best = {
        amountSats,
        feeSats: Number(selected.tx.fee || selected.fee),
        inputCount: selected.inputs.length,
        outputCount: selected.outputs.length,
        changeUsed: selected.change,
      };
      low = amountSats + BigInt(1);
    } else {
      high = amountSats - BigInt(1);
    }
  }

  if (!best) throw new TransparentSendError('insufficient-funds');
  return best;
};

export const estimateTransparentMultiSend = async ({
  snapshot,
  outputs,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
  changeAddress,
}: {
  snapshot: TransparentWalletSnapshot;
  outputs: TransparentSendOutput[];
  feePerVbyte?: bigint;
  changeAddress?: string;
}): Promise<TransparentSendEstimate> => {
  const normalizedOutputs = normalizeSendOutputs(outputs);
  const { spendable } = prepareSpendableInputs(snapshot);
  const selected = selectSpend({
    spendable,
    outputs: normalizedOutputs.map((output) => ({
      address: output.address,
      amount: output.amountSats,
    })),
    feePerVbyte,
    changeAddress: resolveChangeAddress(snapshot, changeAddress),
  });
  const amountSats = normalizedOutputs.reduce(
    (total, output) => total + output.amountSats,
    BigInt(0),
  );

  if (selected?.tx) {
    const feeSats = Number(selected.tx.fee || selected.fee);
    return {
      amountSats,
      feeSats,
      totalSats: amountSats + BigInt(feeSats),
      fitsAvailable: true,
      inputCount: selected.inputs.length,
      outputCount: selected.outputs.length,
      changeUsed: selected.change,
    };
  }

  const targetIndex = normalizedOutputs.length - 1;
  const max = await calculateMaxTransparentSendAmount({
    snapshot,
    outputs: normalizedOutputs,
    targetIndex,
    feePerVbyte,
    changeAddress,
  });
  return {
    amountSats,
    feeSats: max.feeSats,
    totalSats: amountSats + BigInt(max.feeSats),
    fitsAvailable: false,
    inputCount: max.inputCount,
    outputCount: max.outputCount,
    changeUsed: max.changeUsed,
  };
};

const txidCandidates = (txid: unknown) => {
  if (typeof txid === 'string') return [txid.toLowerCase()];
  if (!(txid instanceof Uint8Array)) return [];
  return [bytesToHex(txid), bytesToHex(Uint8Array.from(txid).reverse())];
};

const selectedSpendables = (
  inputs: readonly Record<string, unknown>[],
  spendable: readonly PreparedSpendableInput[],
) => {
  const byOutpoint = new Map(
    spendable.map((candidate) => [
      `${candidate.signer.txid.toLowerCase()}:${candidate.signer.vout}`,
      candidate,
    ]),
  );
  const resolved = inputs.map((input) => {
    if (!Number.isSafeInteger(input.index)) return undefined;
    return txidCandidates(input.txid)
      .map((txid) => byOutpoint.get(`${txid}:${String(input.index)}`))
      .find((candidate) => candidate !== undefined);
  });
  if (resolved.some((candidate) => candidate === undefined)) {
    throw new TransparentSendError('selected-input-unresolved');
  }
  const complete = resolved as PreparedSpendableInput[];
  const unique = new Set(
    complete.map(({ signer }) => `${signer.txid.toLowerCase()}:${signer.vout}`),
  );
  if (unique.size !== inputs.length) {
    throw new TransparentSendError('selected-input-unresolved');
  }
  return complete;
};

const outputScriptHex = (output: Record<string, unknown>) => {
  if (output.script instanceof Uint8Array) return bytesToHex(output.script);
  if (typeof output.address !== 'string') {
    throw new TransparentSendError('signed-transaction-mismatch');
  }
  try {
    return bytesToHex(scriptPubKeyForNitoAddress(output.address));
  } catch (caught) {
    throw new TransparentSendError('signed-transaction-mismatch', caught);
  }
};

const assertSignedTemplateMatches = (
  expectedInputs: readonly Record<string, unknown>[],
  expectedOutputs: readonly Record<string, unknown>[],
  signed: btc.Transaction,
) => {
  if (
    signed.inputsLength !== expectedInputs.length ||
    signed.outputsLength !== expectedOutputs.length
  ) {
    throw new TransparentSendError('signed-transaction-mismatch');
  }
  for (let index = 0; index < expectedInputs.length; index += 1) {
    const expected = expectedInputs[index]!;
    const actual = signed.getInput(index) as Record<string, unknown>;
    if (
      expected.index !== actual.index ||
      (expected.sequence ?? btc.DEFAULT_SEQUENCE) !== actual.sequence ||
      !txidCandidates(expected.txid).some((txid) =>
        txidCandidates(actual.txid).includes(txid),
      )
    ) {
      throw new TransparentSendError('signed-transaction-mismatch');
    }
  }
  for (let index = 0; index < expectedOutputs.length; index += 1) {
    const expected = expectedOutputs[index]!;
    const actual = signed.getOutput(index) as Record<string, unknown>;
    if (
      BigInt(String(expected.amount)) !== BigInt(String(actual.amount)) ||
      outputScriptHex(expected) !== outputScriptHex(actual)
    ) {
      throw new TransparentSendError('signed-transaction-mismatch');
    }
  }
};

const sessionSignersFor = (
  snapshot: TransparentWalletSnapshot,
  sources: readonly PreparedSpendableInput[],
): HdSigner[] | SingleKeySigner[] => {
  const signers = sources.map(({ signer }) => signer);
  if (snapshot.sourceKind === 'single-private-key') {
    if (signers.every((signer) => !('path' in signer))) {
      return signers as SingleKeySigner[];
    }
  } else if (signers.every((signer) => 'path' in signer)) {
    return signers as HdSigner[];
  }
  throw new TransparentSendError('signing-material-unavailable');
};

const signTransactionTemplate = async ({
  sessionId,
  snapshot,
  transaction,
  sources,
  signPsbt,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  transaction: btc.Transaction;
  sources: readonly PreparedSpendableInput[];
  signPsbt: TransparentPsbtSigner;
}) => {
  const expectedInputs = Array.from(
    { length: transaction.inputsLength },
    (_, index) => transaction.getInput(index) as Record<string, unknown>,
  );
  const expectedOutputs = Array.from(
    { length: transaction.outputsLength },
    (_, index) => transaction.getOutput(index) as Record<string, unknown>,
  );
  try {
    const signed = await signPsbt(
      sessionId,
      bytesToBase64(transaction.toPSBT(0)),
      sessionSignersFor(snapshot, sources),
    );
    const signedTransaction = btc.Transaction.fromPSBT(
      base64ToBytes(signed.psbtBase64),
    );
    assertSignedTemplateMatches(
      expectedInputs,
      expectedOutputs,
      signedTransaction,
    );
    signedTransaction.finalize();
    return signedTransaction;
  } catch (caught) {
    if (caught instanceof TransparentSendError) throw caught;
    throw new TransparentSendError('signature-invalid', caught);
  }
};

const buildTransparentTx = async ({
  sessionId,
  snapshot,
  outputs,
  signPsbt,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
  changeAddress,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  outputs: { address: string; amount: bigint }[];
  signPsbt: TransparentPsbtSigner;
  feePerVbyte?: bigint;
  changeAddress?: string;
}): Promise<PreparedTransparentTx> => {
  if (sessionId.trim() === '') {
    throw new TransparentSendError('signing-material-unavailable');
  }
  const { spendable } = prepareSpendableInputs(snapshot);
  const selected = selectSpend({
    spendable,
    outputs,
    feePerVbyte,
    changeAddress: resolveChangeAddress(snapshot, changeAddress),
  });
  if (!selected?.tx) throw new TransparentSendError('insufficient-funds');
  const sources = selectedSpendables(
    selected.inputs as Record<string, unknown>[],
    spendable,
  );
  let signedTransaction: btc.Transaction;
  try {
    signedTransaction = await signTransactionTemplate({
      sessionId,
      snapshot,
      transaction: selected.tx,
      sources,
      signPsbt,
    });
  } catch (caught) {
    if (caught instanceof TransparentSendError) throw caught;
    throw new TransparentSendError('signature-invalid', caught);
  }
  if (signedTransaction.hex.length / 2 > 100_000) {
    throw new TransparentSendError('transaction-too-large');
  }

  const ownedAddressByScript = new Map(
    snapshot.addresses.map((owner) => [
      owner.scriptHex.toLowerCase(),
      owner.address,
    ]),
  );
  const walletOutputs = (selected.outputs as Record<string, unknown>[]).flatMap(
    (output, vout) => {
      const address = ownedAddressByScript.get(outputScriptHex(output));
      const amount = BigInt(String(output.amount));
      if (!address || amount > BigInt(Number.MAX_SAFE_INTEGER)) return [];
      return [{ vout, valueSats: Number(amount), address }];
    },
  );

  return {
    txid: signedTransaction.id,
    hex: signedTransaction.hex,
    feeSats: Number(selected.tx.fee || selected.fee),
    inputCount: selected.inputs.length,
    outputCount: selected.outputs.length,
    changeUsed: selected.change,
    walletInputs: sources.map(({ signer, valueSats, address }) => ({
      txid: signer.txid,
      vout: signer.vout,
      valueSats,
      address,
    })),
    walletOutputs,
  };
};

export const buildTransparentMultiSend = async ({
  sessionId,
  snapshot,
  outputs,
  signPsbt,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
  changeAddress,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  outputs: TransparentSendOutput[];
  signPsbt: TransparentPsbtSigner;
  feePerVbyte?: bigint;
  changeAddress?: string;
}): Promise<PreparedTransparentSend> => {
  const recipients = normalizeSendOutputs(outputs);
  const transaction = await buildTransparentTx({
    sessionId,
    snapshot,
    outputs: recipients.map(({ address, amountSats }) => ({
      address,
      amount: amountSats,
    })),
    signPsbt,
    feePerVbyte,
    changeAddress,
  });
  return { ...transaction, recipients };
};

export const buildTransparentSend = ({
  sessionId,
  snapshot,
  toAddress,
  amountSats,
  signPsbt,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
  changeAddress,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  toAddress: string;
  amountSats: bigint;
  signPsbt: TransparentPsbtSigner;
  feePerVbyte?: bigint;
  changeAddress?: string;
}): Promise<PreparedTransparentSend> =>
  buildTransparentMultiSend({
    sessionId,
    snapshot,
    outputs: [{ address: toAddress, amountSats }],
    signPsbt,
    feePerVbyte,
    changeAddress,
  });

const RBF_INPUT_VBYTES: Record<ScannedAddress['scriptType'], number> = {
  p2pkh: 148,
  'p2sh-p2wpkh': 91,
  p2wpkh: 68,
  p2tr: 58,
};
const RBF_OUTPUT_VBYTES: Record<ScannedAddress['scriptType'], number> = {
  p2pkh: 34,
  'p2sh-p2wpkh': 32,
  p2wpkh: 31,
  p2tr: 43,
};

const validateRbfOriginal = (
  snapshot: TransparentWalletSnapshot,
  original: PreparedTransparentTx,
  returnAddress: string,
) => {
  let transaction: btc.Transaction;
  try {
    transaction = btc.Transaction.fromRaw(hexToBytes(original.hex));
  } catch (caught) {
    throw new TransparentSendError('rbf-original-mismatch', caught);
  }
  if (transaction.id !== original.txid.toLowerCase()) {
    throw new TransparentSendError('rbf-original-mismatch');
  }
  if (transaction.inputsLength !== original.walletInputs.length) {
    throw new TransparentSendError('rbf-original-mismatch');
  }
  const inputByOutpoint = new Map(
    original.walletInputs.map((input) => [
      `${input.txid.toLowerCase()}:${input.vout}`,
      input,
    ]),
  );
  const transactionInputs = Array.from(
    { length: transaction.inputsLength },
    (_, index) => transaction.getInput(index) as Record<string, unknown>,
  );
  if (
    transactionInputs.some(
      (input) =>
        typeof input.sequence !== 'number' || input.sequence >= 0xffff_fffe,
    )
  ) {
    throw new TransparentSendError('rbf-unavailable');
  }
  const orderedWalletInputs = transactionInputs.map((input) => {
    if (!Number.isSafeInteger(input.index)) {
      throw new TransparentSendError('rbf-original-mismatch');
    }
    const match = txidCandidates(input.txid)
      .map((txid) => inputByOutpoint.get(`${txid}:${String(input.index)}`))
      .find((candidate) => candidate !== undefined);
    if (!match) throw new TransparentSendError('rbf-original-mismatch');
    return match;
  });
  if (new Set(orderedWalletInputs).size !== original.walletInputs.length) {
    throw new TransparentSendError('rbf-original-mismatch');
  }

  const originalInputSats = orderedWalletInputs.reduce(
    (total, input) => total + BigInt(input.valueSats),
    BigInt(0),
  );
  const originalOutputSats = Array.from(
    { length: transaction.outputsLength },
    (_, index) => BigInt(String(transaction.getOutput(index).amount)),
  ).reduce((total, amount) => total + amount, BigInt(0));
  if (
    originalInputSats - originalOutputSats !== BigInt(original.feeSats) ||
    original.feeSats <= 0
  ) {
    throw new TransparentSendError('rbf-original-mismatch');
  }

  const originalOutpoints = new Set(
    orderedWalletInputs.map(
      (input) => `${input.txid.toLowerCase()}:${input.vout}`,
    ),
  );
  const selectedSnapshot = {
    ...snapshot,
    utxos: snapshot.utxos.filter((utxo) =>
      originalOutpoints.has(`${utxo.txid.toLowerCase()}:${utxo.vout}`),
    ),
  };
  if (selectedSnapshot.utxos.length !== orderedWalletInputs.length) {
    throw new TransparentSendError('rbf-original-mismatch');
  }
  const { spendable } = prepareSpendableInputs(selectedSnapshot);
  const preparedByOutpoint = new Map(
    spendable.map((source) => [
      `${source.signer.txid.toLowerCase()}:${source.signer.vout}`,
      source,
    ]),
  );
  const sources = orderedWalletInputs.map((input) => {
    const source = preparedByOutpoint.get(
      `${input.txid.toLowerCase()}:${input.vout}`,
    );
    if (
      !source ||
      source.valueSats !== input.valueSats ||
      source.address !== input.address
    ) {
      throw new TransparentSendError('rbf-original-mismatch');
    }
    return source;
  });
  const resolvedReturnAddress = resolveChangeAddress(snapshot, returnAddress);
  const returnOwner = snapshot.addresses.find(
    (owner) => owner.address === resolvedReturnAddress,
  );
  if (!returnOwner) throw new TransparentSendError('change-address-not-owned');
  return {
    transaction,
    sources,
    returnAddress: resolvedReturnAddress,
    returnOwner,
    inputSats: originalInputSats,
  };
};

export const estimateTransparentRbfCancellation = ({
  snapshot,
  original,
  returnAddress,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
}: {
  snapshot: TransparentWalletSnapshot;
  original: PreparedTransparentTx;
  returnAddress: string;
  feePerVbyte?: bigint;
}): TransparentRbfCancellationQuote => {
  validateFeeRate(feePerVbyte);
  const context = validateRbfOriginal(snapshot, original, returnAddress);
  const originalRate = BigInt(
    Math.ceil(original.feeSats / context.transaction.vsize),
  );
  const replacementRate = [feePerVbyte, originalRate + BigInt(1)].reduce(
    (highest, candidate) => (candidate > highest ? candidate : highest),
  );
  const inputVbytes = context.sources.reduce((total, source) => {
    const owner = snapshot.addresses.find(
      (candidate) => candidate.address === source.address,
    );
    if (!owner) throw new TransparentSendError('rbf-original-mismatch');
    return total + RBF_INPUT_VBYTES[owner.scriptType];
  }, 0);
  const estimatedVbytes =
    11 +
    inputVbytes +
    RBF_OUTPUT_VBYTES[context.returnOwner.scriptType] +
    Math.max(4, context.sources.length);
  const replacementFee = [
    replacementRate * BigInt(estimatedVbytes),
    BigInt(original.feeSats) +
      RBF_MINIMUM_ABSOLUTE_INCREASE_PER_VBYTE * BigInt(estimatedVbytes),
  ].reduce((highest, candidate) => (candidate > highest ? candidate : highest));
  const outputSats = context.inputSats - replacementFee;
  if (
    replacementFee > BigInt(Number.MAX_SAFE_INTEGER) ||
    outputSats > BigInt(Number.MAX_SAFE_INTEGER) ||
    outputSats < DUST_LIMIT_SATS
  ) {
    throw new TransparentSendError('rbf-insufficient-funds');
  }
  return {
    replacesTxid: original.txid,
    returnAddress: context.returnAddress,
    originalFeeSats: original.feeSats,
    feeSats: Number(replacementFee),
    outputSats: Number(outputSats),
    estimatedVbytes,
    feePerVbyte: replacementRate,
  };
};

export const buildTransparentRbfCancellation = async ({
  sessionId,
  snapshot,
  original,
  returnAddress,
  signPsbt,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  original: PreparedTransparentTx;
  returnAddress: string;
  signPsbt: TransparentPsbtSigner;
  feePerVbyte?: bigint;
}): Promise<PreparedTransparentRbfCancellation> => {
  if (sessionId.trim() === '') {
    throw new TransparentSendError('signing-material-unavailable');
  }
  const context = validateRbfOriginal(snapshot, original, returnAddress);
  const quote = estimateTransparentRbfCancellation({
    snapshot,
    original,
    returnAddress,
    feePerVbyte,
  });
  const transaction = new btc.Transaction();
  for (const source of context.sources) {
    transaction.addInput({
      ...cloneInput(source.input),
      sequence: RBF_SEQUENCE,
    } as Parameters<typeof transaction.addInput>[0]);
  }
  transaction.addOutputAddress(
    quote.returnAddress,
    BigInt(quote.outputSats),
    NITO_SIGNER_NETWORK,
  );
  const signedTransaction = await signTransactionTemplate({
    sessionId,
    snapshot,
    transaction,
    sources: context.sources,
    signPsbt,
  });
  if (
    signedTransaction.hex.length / 2 > 100_000 ||
    signedTransaction.vsize > quote.estimatedVbytes ||
    BigInt(quote.feeSats) <
      quote.feePerVbyte * BigInt(signedTransaction.vsize) ||
    BigInt(quote.feeSats) <
      BigInt(original.feeSats) +
        RBF_MINIMUM_ABSOLUTE_INCREASE_PER_VBYTE *
          BigInt(signedTransaction.vsize)
  ) {
    throw new TransparentSendError('rbf-replacement-fee');
  }
  return {
    replacesTxid: original.txid,
    txid: signedTransaction.id,
    hex: signedTransaction.hex,
    feeSats: quote.feeSats,
    inputCount: context.sources.length,
    outputCount: 1,
    changeUsed: false,
    walletInputs: context.sources.map(({ signer, valueSats, address }) => ({
      txid: signer.txid,
      vout: signer.vout,
      valueSats,
      address,
    })),
    walletOutputs: [
      {
        vout: 0,
        valueSats: quote.outputSats,
        address: quote.returnAddress,
      },
    ],
  };
};

const CONSOLIDATION_MIN_UTXOS = 21;
const CONSOLIDATION_TARGET_OUTPUTS = 9;
const CONSOLIDATION_MIN_SATS_PER_OUTPUT = BigInt(5_000);
const MAX_STANDARD_CONSOLIDATION_VBYTES = 90_000;
const CONSOLIDATION_TX_OVERHEAD_VBYTES = 11;
const CONSOLIDATION_OUTPUT_VBYTES = 31;
const CONSOLIDATION_INPUT_VBYTES: Record<string, number> = {
  p2pkh: 148,
  'p2sh-p2wpkh': 91,
  p2wpkh: 68,
  p2tr: 58,
};
const CONSOLIDATION_OUTPUT_STEPS = [CONSOLIDATION_TARGET_OUTPUTS, 4, 2, 1];

const calculateMaxEqualSplit = ({
  snapshot,
  toAddress,
  outputCount,
  feePerVbyte,
}: {
  snapshot: TransparentWalletSnapshot;
  toAddress: string;
  outputCount: number;
  feePerVbyte: bigint;
}) => {
  const { spendable, totalSats } = prepareSpendableInputs(snapshot);
  const count = BigInt(outputCount);
  let low = DUST_LIMIT_SATS;
  let high = totalSats / count;
  let best:
    | {
        perOutput: bigint;
        feeSats: number;
        inputCount: number;
        outputCount: number;
        changeUsed: boolean;
      }
    | undefined;

  while (low <= high) {
    const perOutput = (low + high) / BigInt(2);
    const outputs = Array.from({ length: outputCount }, () => ({
      address: toAddress,
      amount: perOutput,
    }));
    const selected = selectSpend({
      spendable,
      outputs,
      feePerVbyte,
      changeAddress: toAddress,
    });
    if (selected?.tx) {
      best = {
        perOutput,
        feeSats: Number(selected.tx.fee || selected.fee),
        inputCount: selected.inputs.length,
        outputCount: selected.outputs.length,
        changeUsed: selected.change,
      };
      low = perOutput + BigInt(1);
    } else {
      high = perOutput - BigInt(1);
    }
  }
  return best;
};

export const planTransparentConsolidation = ({
  snapshot,
  toAddress,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
}: {
  snapshot: TransparentWalletSnapshot;
  toAddress: string;
  feePerVbyte?: bigint;
}): TransparentConsolidationPlan => {
  validateFeeRate(feePerVbyte);
  const resolvedAddress = resolveChangeAddress(snapshot, toAddress);
  const confirmedUtxos = snapshot.utxos
    .filter(isTransparentUtxoSpendable)
    .sort((left, right) => left.valueSats - right.valueSats);
  if (confirmedUtxos.length < CONSOLIDATION_MIN_UTXOS) {
    throw new TransparentSendError('consolidation-not-enough-utxos');
  }

  const scriptTypes = new Map(
    snapshot.addresses.map((address) => [address.address, address.scriptType]),
  );
  const outputsBaseVbytes =
    CONSOLIDATION_TX_OVERHEAD_VBYTES +
    CONSOLIDATION_TARGET_OUTPUTS * CONSOLIDATION_OUTPUT_VBYTES;
  const batches: (typeof confirmedUtxos)[] = [];
  let batch: typeof confirmedUtxos = [];
  let estimatedVbytes = outputsBaseVbytes;
  for (const utxo of confirmedUtxos) {
    const inputVbytes =
      CONSOLIDATION_INPUT_VBYTES[scriptTypes.get(utxo.address) ?? 'p2wpkh'] ??
      148;
    if (
      batch.length > 0 &&
      estimatedVbytes + inputVbytes > MAX_STANDARD_CONSOLIDATION_VBYTES
    ) {
      batches.push(batch);
      batch = [];
      estimatedVbytes = outputsBaseVbytes;
    }
    batch.push(utxo);
    estimatedVbytes += inputVbytes;
  }
  if (batch.length > 0) batches.push(batch);
  const usefulBatches = batches.filter((candidate) => candidate.length >= 2);
  if (usefulBatches.length === 0) {
    throw new TransparentSendError('consolidation-unavailable');
  }

  const transactions = usefulBatches.map((utxos) => {
    const batchSnapshot = { ...snapshot, utxos };
    for (const target of CONSOLIDATION_OUTPUT_STEPS) {
      const outputCount = Math.min(target, utxos.length);
      if (outputCount < 1) continue;
      const split = calculateMaxEqualSplit({
        snapshot: batchSnapshot,
        toAddress: resolvedAddress,
        outputCount,
        feePerVbyte,
      });
      if (
        !split ||
        split.perOutput < CONSOLIDATION_MIN_SATS_PER_OUTPUT ||
        split.inputCount !== utxos.length ||
        split.changeUsed ||
        split.outputCount !== outputCount
      ) {
        continue;
      }
      return {
        outpoints: utxos.map(({ txid, vout }) => ({ txid, vout })),
        outputs: Array.from({ length: outputCount }, () => ({
          address: resolvedAddress,
          amountSats: split.perOutput,
        })),
        feeSats: split.feeSats,
        inputCount: split.inputCount,
        outputCount: split.outputCount,
      };
    }
    throw new TransparentSendError('consolidation-unavailable');
  });

  return {
    transactions,
    inputCount: transactions.reduce(
      (total, transaction) => total + transaction.inputCount,
      0,
    ),
    outputCount: transactions.reduce(
      (total, transaction) => total + transaction.outputCount,
      0,
    ),
    totalFeeSats: transactions.reduce(
      (total, transaction) => total + transaction.feeSats,
      0,
    ),
  };
};

export const buildTransparentConsolidation = async ({
  sessionId,
  snapshot,
  toAddress,
  signPsbt,
  feePerVbyte = DEFAULT_FEE_PER_VBYTE,
}: {
  sessionId: string;
  snapshot: TransparentWalletSnapshot;
  toAddress: string;
  signPsbt: TransparentPsbtSigner;
  feePerVbyte?: bigint;
}): Promise<PreparedTransparentConsolidation> => {
  const plan = planTransparentConsolidation({
    snapshot,
    toAddress,
    feePerVbyte,
  });
  const utxoByOutpoint = new Map(
    snapshot.utxos.map((utxo) => [`${utxo.txid}:${utxo.vout}`, utxo]),
  );
  const transactions: PreparedTransparentTx[] = [];
  for (const planned of plan.transactions) {
    const utxos = planned.outpoints.map(({ txid, vout }) => {
      const utxo = utxoByOutpoint.get(`${txid}:${vout}`);
      if (!utxo) throw new TransparentSendError('consolidation-unavailable');
      return utxo;
    });
    const transaction = await buildTransparentTx({
      sessionId,
      snapshot: { ...snapshot, utxos },
      outputs: planned.outputs.map(({ address, amountSats }) => ({
        address,
        amount: amountSats,
      })),
      signPsbt,
      feePerVbyte,
      changeAddress: toAddress,
    });
    if (
      transaction.inputCount !== planned.inputCount ||
      transaction.outputCount !== planned.outputCount ||
      transaction.feeSats !== planned.feeSats ||
      transaction.changeUsed
    ) {
      throw new TransparentSendError('signed-transaction-mismatch');
    }
    if (transaction.hex.length / 2 > 100_000) {
      throw new TransparentSendError('consolidation-too-large');
    }
    transactions.push(transaction);
  }
  return {
    transactions,
    inputCount: plan.inputCount,
    outputCount: plan.outputCount,
    totalFeeSats: plan.totalFeeSats,
  };
};
