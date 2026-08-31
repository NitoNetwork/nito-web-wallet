import { describe, expect, it } from 'vitest';

import { scriptPubKeyForNitoAddress } from '../network/electrum';
import { parseNitoAmountToSats } from '../wallet/transparentSend';

const PUBLIC_ADDRESSES = [
  '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
  '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
  'nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02',
  'nito1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqrvfekz',
] as const;

const mutateOneCharacter = (value: string, index: number) => {
  const current = value[index]!;
  const replacement = current === 'q' ? 'p' : current === '1' ? '2' : 'q';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
};

const deterministicUnicodeInputs = () => {
  let state = 0x6e_69_74_6f;
  const values: string[] = [];
  for (let sample = 0; sample < 256; sample += 1) {
    let value = '';
    const length = (state % 48) + 1;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      value += String.fromCodePoint(Math.abs(state) % 0x10_ffff);
    }
    values.push(value);
  }
  return values;
};

describe('hostile public inputs', () => {
  it('rejects every single-character checksum mutation across all public families', () => {
    for (const address of PUBLIC_ADDRESSES) {
      expect(() => scriptPubKeyForNitoAddress(address)).not.toThrow();
      for (let index = 0; index < address.length; index += 1) {
        const mutated = mutateOneCharacter(address, index);
        expect(
          () => scriptPubKeyForNitoAddress(mutated),
          `${address} mutation at ${index}: ${mutated}`,
        ).toThrow();
      }
    }
  });

  it('rejects bounded deterministic Unicode and oversized amount payloads', () => {
    for (const hostile of deterministicUnicodeInputs()) {
      expect(() => parseNitoAmountToSats(hostile)).toThrow();
    }
    for (const length of [33, 1_024, 100_000]) {
      expect(() => parseNitoAmountToSats('9'.repeat(length))).toThrow(
        expect.objectContaining({ code: 'invalid-amount-format' }),
      );
    }
  });
});
