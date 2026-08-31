import type { ElectrumUtxo } from '../network/electrum';
import { mapWithConcurrency } from '../services/concurrency';

export const COINBASE_MATURITY_CONFIRMATIONS = 101;
const COINBASE_CLASSIFICATION_CONCURRENCY = 6;

const readCompactSize = (
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null => {
  if (offset >= bytes.length) return null;
  const prefix = bytes[offset]!;
  if (prefix < 0xfd) return { value: prefix, nextOffset: offset + 1 };
  if (prefix === 0xfd) {
    if (offset + 2 >= bytes.length) return null;
    return {
      value: bytes[offset + 1]! | (bytes[offset + 2]! << 8),
      nextOffset: offset + 3,
    };
  }
  return null;
};

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const isCoinbaseTransactionHex = (transactionHex: string): boolean => {
  const bytes = hexToBytes(transactionHex);
  if (!bytes || bytes.length < 42) return false;

  let offset = 4;
  if (bytes[offset] === 0x00 && bytes[offset + 1] !== 0x00) offset += 2;

  const inputCount = readCompactSize(bytes, offset);
  if (!inputCount || inputCount.value !== 1) return false;
  offset = inputCount.nextOffset;
  if (offset + 36 > bytes.length) return false;

  for (let index = 0; index < 32; index += 1) {
    if (bytes[offset + index] !== 0x00) return false;
  }
  return (
    bytes[offset + 32] === 0xff &&
    bytes[offset + 33] === 0xff &&
    bytes[offset + 34] === 0xff &&
    bytes[offset + 35] === 0xff
  );
};

export const isTransparentUtxoSpendable = (utxo: ElectrumUtxo): boolean => {
  if (utxo.confirmations <= 0) return false;
  if (utxo.confirmations >= COINBASE_MATURITY_CONFIRMATIONS) return true;
  return utxo.isCoinbase === false;
};

export const isImmatureCoinbaseUtxo = (utxo: ElectrumUtxo): boolean =>
  utxo.isCoinbase === true &&
  utxo.confirmations > 0 &&
  utxo.confirmations < COINBASE_MATURITY_CONFIRMATIONS;

export const getImmatureCoinbaseSummary = (utxos: ElectrumUtxo[]) => {
  const immature = utxos.filter(isImmatureCoinbaseUtxo);
  return {
    amountSats: immature.reduce((total, utxo) => total + utxo.valueSats, 0),
    blocksRemaining:
      immature.length === 0
        ? 0
        : Math.min(
            ...immature.map(
              (utxo) => COINBASE_MATURITY_CONFIRMATIONS - utxo.confirmations,
            ),
          ),
  };
};

export const annotateCoinbaseMaturity = async (
  utxos: ElectrumUtxo[],
  previousUtxos: ElectrumUtxo[],
  loadTransactionHex: (txid: string) => Promise<string>,
): Promise<ElectrumUtxo[]> => {
  const previousByOutpoint = new Map(
    previousUtxos.map(
      (utxo) => [`${utxo.txid}:${utxo.vout}`, utxo.isCoinbase] as const,
    ),
  );

  return mapWithConcurrency(
    utxos,
    COINBASE_CLASSIFICATION_CONCURRENCY,
    async (utxo) => {
      const known = previousByOutpoint.get(`${utxo.txid}:${utxo.vout}`);
      if (known !== undefined) return { ...utxo, isCoinbase: known };
      if (utxo.confirmations <= 0) return { ...utxo, isCoinbase: false };
      if (utxo.confirmations >= COINBASE_MATURITY_CONFIRMATIONS) return utxo;
      const transactionHex = await loadTransactionHex(utxo.txid);
      return { ...utxo, isCoinbase: isCoinbaseTransactionHex(transactionHex) };
    },
  );
};
