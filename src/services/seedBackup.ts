export const SEED_BACKUP_CHALLENGE_COUNT = 3;

export const numberSeedBackupWords = (mnemonic: string): readonly string[] => (
  mnemonic
    .trim()
    .split(/\s+/u)
    .map((word, index) => `${index + 1}. ${word}`)
);

const stableHash = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * Chooses verification positions without accepting or retaining the mnemonic.
 * The actual answers are checked inside the cryptographic Worker.
 */
export const createSeedBackupWordIndexes = (
  wordCount: 12 | 24,
  attemptToken = crypto.randomUUID(),
): readonly number[] => {
  let state = stableHash(`${attemptToken}:indexes:${wordCount}`);
  const indexes = new Set<number>();

  while (indexes.size < SEED_BACKUP_CHALLENGE_COUNT) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    indexes.add(state % wordCount);
  }

  return [...indexes];
};
