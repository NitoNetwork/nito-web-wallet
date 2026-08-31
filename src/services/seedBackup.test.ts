import { describe, expect, it } from 'vitest';

import {
  createSeedBackupWordIndexes,
  numberSeedBackupWords,
  SEED_BACKUP_CHALLENGE_COUNT,
} from './seedBackup';

const mnemonic24 = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual';

describe('seed backup challenge', () => {
  it('keeps every displayed position and word together in the numbered backup grid', () => {
    const numberedWords = numberSeedBackupWords(mnemonic24);

    expect(numberedWords).toHaveLength(24);
    expect(numberedWords[0]).toBe('1. abandon');
    expect(numberedWords[23]).toBe('24. actual');
  });

  it.each([12, 24] as const)(
    'asks three distinct positions without receiving the %i-word phrase',
    (wordCount) => {
      const indexes = createSeedBackupWordIndexes(wordCount, 'attempt-a');

      expect(indexes).toHaveLength(SEED_BACKUP_CHALLENGE_COUNT);
      expect(new Set(indexes).size).toBe(SEED_BACKUP_CHALLENGE_COUNT);
      for (const index of indexes) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(wordCount);
      }
    },
  );

  it('regenerates positions for a different backup attempt', () => {
    expect(createSeedBackupWordIndexes(24, 'attempt-a')).not.toEqual(
      createSeedBackupWordIndexes(24, 'attempt-b'),
    );
  });
});
