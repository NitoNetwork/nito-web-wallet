import { describe, expect, it } from 'vitest';

import {
  MANUAL_SYNC_COOLDOWN_MS,
  manualSyncAvailableAt,
  manualSyncSecondsRemaining,
} from './manualSyncPolicy';

describe('manual wallet synchronization policy', () => {
  it('allows at most one manual full scan every sixty seconds', () => {
    const startedAt = 1_000_000;
    const availableAt = manualSyncAvailableAt(startedAt);

    expect(availableAt).toBe(startedAt + MANUAL_SYNC_COOLDOWN_MS);
    expect(manualSyncSecondsRemaining(availableAt, startedAt)).toBe(60);
    expect(manualSyncSecondsRemaining(availableAt, startedAt + 1)).toBe(60);
    expect(manualSyncSecondsRemaining(availableAt, startedAt + 59_001)).toBe(1);
    expect(manualSyncSecondsRemaining(availableAt, availableAt)).toBe(0);
    expect(manualSyncSecondsRemaining(availableAt, availableAt + 10_000)).toBe(
      0,
    );
  });

  it('rounds partial seconds up for an honest live countdown', () => {
    expect(manualSyncSecondsRemaining(10_001, 10_000)).toBe(1);
    expect(manualSyncSecondsRemaining(10_999, 10_000)).toBe(1);
    expect(manualSyncSecondsRemaining(11_001, 10_000)).toBe(2);
  });
});
