import { describe, expect, it } from 'vitest';

import {
  DICE_ENTROPY_DIGEST_LENGTH,
  PHYSICAL_DICE_RESULT_COUNT,
  PhysicalDiceEntropySession,
  hashPhysicalDiceResults,
} from './diceEntropy';

const referenceResults = (): Uint8Array => Uint8Array.from(
  { length: PHYSICAL_DICE_RESULT_COUNT },
  (_, index) => (index % 6) + 1,
);

const bytesToHex = (bytes: Uint8Array): string => Array.from(
  bytes,
  (byte) => byte.toString(16).padStart(2, '0'),
).join('');

describe('physical dice entropy', () => {
  it('hashes the canonical ordered 100-result encoding to a stable vector', () => {
    const digest = hashPhysicalDiceResults(referenceResults());

    expect(digest).toHaveLength(DICE_ENTROPY_DIGEST_LENGTH);
    expect(bytesToHex(digest)).toBe(
      'c6d1977aa5752fd4b616c38fc4f4b4530e923f50be59fe8d8a29ace9a3bf870e',
    );
  });

  it('treats order as entropy and rejects malformed physical results', () => {
    const first = referenceResults();
    const reordered = referenceResults();
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];

    expect(hashPhysicalDiceResults(first)).not.toEqual(hashPhysicalDiceResults(reordered));
    expect(() => hashPhysicalDiceResults(first.slice(0, 99))).toThrow();
    expect(() => hashPhysicalDiceResults(new Uint8Array(101).fill(1))).toThrow();

    const zero = referenceResults();
    zero[30] = 0;
    expect(() => hashPhysicalDiceResults(zero)).toThrow();

    const seven = referenceResults();
    seven[30] = 7;
    expect(() => hashPhysicalDiceResults(seven)).toThrow();
  });

  it('accepts only values 1 to 6 and exactly 100 entries', () => {
    const session = new PhysicalDiceEntropySession();
    expect(() => session.append(0)).toThrow();
    expect(() => session.append(7)).toThrow();
    expect(() => session.append(1.5)).toThrow();
    expect(() => session.entropyDigestBase64()).toThrow();

    for (const value of referenceResults()) session.append(value);

    expect(session.complete).toBe(true);
    expect(session.count).toBe(PHYSICAL_DICE_RESULT_COUNT);
    expect(() => session.append(1)).toThrow();
    const decoded = Uint8Array.from(
      atob(session.entropyDigestBase64()),
      (value) => value.charCodeAt(0),
    );
    expect(decoded).toEqual(hashPhysicalDiceResults(referenceResults()));
  });

  it('supports correction and clears every retained result', () => {
    const session = new PhysicalDiceEntropySession();
    session.append(4);
    session.append(2);
    expect(session.valueAt(0)).toBe(4);
    expect(session.valueAt(1)).toBe(2);
    expect(session.undo()).toBe(true);
    expect(session.valueAt(1)).toBeNull();
    expect(session.count).toBe(1);

    session.clear();

    expect(session.count).toBe(0);
    expect(session.complete).toBe(false);
    expect(session.valueAt(0)).toBeNull();
    expect(session.undo()).toBe(false);
  });
});
