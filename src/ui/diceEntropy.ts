import { sha256 } from '@noble/hashes/sha2.js';

export const PHYSICAL_DICE_RESULT_COUNT = 100;
export const PHYSICAL_DICE_RESULTS_PER_SERIES = 5;
export const PHYSICAL_DICE_SERIES_COUNT = (
  PHYSICAL_DICE_RESULT_COUNT / PHYSICAL_DICE_RESULTS_PER_SERIES
);
export const DICE_ENTROPY_DIGEST_LENGTH = 32;

const PHYSICAL_DICE_DOMAIN = new TextEncoder().encode('nito-wallet/physical-dice/v1');
const RESULT_COUNT_BYTES = 2;

const assertDieValue = (value: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new Error('A physical die result must be an integer from 1 to 6.');
  }
};

const assertCompleteResults = (results: Uint8Array): void => {
  if (results.length !== PHYSICAL_DICE_RESULT_COUNT) {
    throw new Error(`Physical dice entropy requires exactly ${PHYSICAL_DICE_RESULT_COUNT} results.`);
  }
  results.forEach(assertDieValue);
};

export const hashPhysicalDiceResults = (results: Uint8Array): Uint8Array => {
  assertCompleteResults(results);
  const encoded = new Uint8Array(
    PHYSICAL_DICE_DOMAIN.length + RESULT_COUNT_BYTES + PHYSICAL_DICE_RESULT_COUNT,
  );
  try {
    encoded.set(PHYSICAL_DICE_DOMAIN);
    const countOffset = PHYSICAL_DICE_DOMAIN.length;
    const view = new DataView(encoded.buffer);
    view.setUint16(countOffset, PHYSICAL_DICE_RESULT_COUNT, false);
    encoded.set(results, countOffset + RESULT_COUNT_BYTES);
    return sha256(encoded);
  } finally {
    encoded.fill(0);
  }
};

const bytesToBase64 = (bytes: Uint8Array): string => (
  btoa(String.fromCharCode(...bytes))
);

export class PhysicalDiceEntropySession {
  private readonly results = new Uint8Array(PHYSICAL_DICE_RESULT_COUNT);

  private resultCount = 0;

  get count(): number {
    return this.resultCount;
  }

  get complete(): boolean {
    return this.resultCount === PHYSICAL_DICE_RESULT_COUNT;
  }

  append(value: number): void {
    assertDieValue(value);
    if (this.complete) {
      throw new Error('Physical dice entropy is already complete.');
    }
    this.results[this.resultCount] = value;
    this.resultCount += 1;
  }

  undo(): boolean {
    if (this.resultCount === 0) return false;
    this.resultCount -= 1;
    this.results[this.resultCount] = 0;
    return true;
  }

  valueAt(index: number): number | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.resultCount) return null;
    return this.results[index] ?? null;
  }

  entropyDigestBase64(): string {
    if (!this.complete) {
      throw new Error(`Physical dice entropy requires exactly ${PHYSICAL_DICE_RESULT_COUNT} results.`);
    }
    const digest = hashPhysicalDiceResults(this.results);
    try {
      return bytesToBase64(digest);
    } finally {
      digest.fill(0);
    }
  }

  clear(): void {
    this.results.fill(0);
    this.resultCount = 0;
  }
}
