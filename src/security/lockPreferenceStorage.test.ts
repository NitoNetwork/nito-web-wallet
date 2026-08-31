import { describe, expect, it, vi } from 'vitest';

import {
  LOCK_PREFERENCES_STORAGE_KEY,
  parseLockPreferences,
  readLockPreferences,
  writeLockPreferences,
} from './lockPreferenceStorage';

describe('lock preference storage', () => {
  it('accepts only the two validated lock settings', () => {
    expect(
      parseLockPreferences(
        JSON.stringify({ autoLockMinutes: 8, backgroundLockSeconds: 50 }),
      ),
    ).toEqual({ autoLockMinutes: 8, backgroundLockSeconds: 50 });

    for (const rejected of [
      null,
      'invalid-json',
      JSON.stringify({ autoLockMinutes: 0, backgroundLockSeconds: 30 }),
      JSON.stringify({ autoLockMinutes: 5, backgroundLockSeconds: 5 }),
      JSON.stringify({ autoLockMinutes: '5', backgroundLockSeconds: 30 }),
      JSON.stringify({
        autoLockMinutes: 5,
        backgroundLockSeconds: 30,
        email: 'must-not-be-stored@example.invalid',
      }),
    ]) {
      expect(parseLockPreferences(rejected)).toBeUndefined();
    }
  });

  it('writes exactly one versioned entry containing only the two settings', () => {
    const setItem = vi.fn();

    expect(
      writeLockPreferences(
        { getItem: vi.fn(), setItem },
        { autoLockMinutes: 10, backgroundLockSeconds: 60 },
      ),
    ).toBe(true);
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(
      LOCK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ autoLockMinutes: 10, backgroundLockSeconds: 60 }),
    );
  });

  it('fails closed when browser storage is unavailable or corrupted', () => {
    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
      setItem: vi.fn(() => {
        throw new Error('storage unavailable');
      }),
    };

    expect(readLockPreferences(unavailable)).toBeUndefined();
    expect(
      writeLockPreferences(unavailable, {
        autoLockMinutes: 5,
        backgroundLockSeconds: 30,
      }),
    ).toBe(false);
  });
});
