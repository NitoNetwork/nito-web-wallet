import {
  isAutoLockMinutes,
  isBackgroundLockSeconds,
  type AutoLockMinutes,
  type BackgroundLockSeconds,
} from './sessionPolicy';

export const LOCK_PREFERENCES_STORAGE_KEY = 'nito-wallet.lock-preferences.v1';

export type LockPreferences = {
  autoLockMinutes: AutoLockMinutes;
  backgroundLockSeconds: BackgroundLockSeconds;
};

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function parseLockPreferences(
  serialized: string | null,
): LockPreferences | undefined {
  if (serialized === null) return undefined;
  try {
    const candidate: unknown = JSON.parse(serialized);
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      !keys.includes('autoLockMinutes') ||
      !keys.includes('backgroundLockSeconds') ||
      typeof record.autoLockMinutes !== 'number' ||
      typeof record.backgroundLockSeconds !== 'number' ||
      !isAutoLockMinutes(record.autoLockMinutes) ||
      !isBackgroundLockSeconds(record.backgroundLockSeconds)
    ) {
      return undefined;
    }
    return {
      autoLockMinutes: record.autoLockMinutes,
      backgroundLockSeconds: record.backgroundLockSeconds,
    };
  } catch {
    return undefined;
  }
}

export function readLockPreferences(
  storage: PreferenceStorage,
): LockPreferences | undefined {
  try {
    return parseLockPreferences(storage.getItem(LOCK_PREFERENCES_STORAGE_KEY));
  } catch {
    return undefined;
  }
}

export function writeLockPreferences(
  storage: PreferenceStorage,
  preferences: LockPreferences,
): boolean {
  try {
    storage.setItem(
      LOCK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        autoLockMinutes: preferences.autoLockMinutes,
        backgroundLockSeconds: preferences.backgroundLockSeconds,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadBrowserLockPreferences(): LockPreferences | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return readLockPreferences(window.localStorage);
  } catch {
    return undefined;
  }
}

export function storeBrowserLockPreferences(preferences: LockPreferences) {
  if (typeof window === 'undefined') return false;
  try {
    return writeLockPreferences(window.localStorage, preferences);
  } catch {
    return false;
  }
}
