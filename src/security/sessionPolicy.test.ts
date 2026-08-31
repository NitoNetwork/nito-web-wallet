import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTO_LOCK_MINUTE_OPTIONS,
  BACKGROUND_LOCK_SECOND_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
  DEFAULT_BACKGROUND_LOCK_SECONDS,
  isAutoLockMinutes,
  isBackgroundLockSeconds,
} from './sessionPolicy';

const accessSource = readFileSync(
  resolve(process.cwd(), 'app/wallet-access-workspace.tsx'),
  'utf8',
);

describe('wallet session lock policy', () => {
  it('offers only whole-minute inactivity locks from 1 through 10 minutes', () => {
    expect(AUTO_LOCK_MINUTE_OPTIONS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(DEFAULT_AUTO_LOCK_MINUTES).toBe(5);
    expect(isAutoLockMinutes(1)).toBe(true);
    expect(isAutoLockMinutes(10)).toBe(true);
    expect(isAutoLockMinutes(0)).toBe(false);
    expect(isAutoLockMinutes(11)).toBe(false);
    expect(isAutoLockMinutes(1.5)).toBe(false);
  });

  it('offers tab locks from immediate through 60 seconds', () => {
    expect(BACKGROUND_LOCK_SECOND_OPTIONS).toEqual([
      0, 10, 20, 30, 40, 50, 60,
    ]);
    expect(DEFAULT_BACKGROUND_LOCK_SECONDS).toBe(30);
    expect(isBackgroundLockSeconds(0)).toBe(true);
    expect(isBackgroundLockSeconds(60)).toBe(true);
    expect(isBackgroundLockSeconds(5)).toBe(false);
    expect(isBackgroundLockSeconds(61)).toBe(false);
  });

  it('applies the selected tab delay while keeping seed creation stricter', () => {
    expect(accessSource).toContain('if (pendingCreation) {');
    expect(accessSource).toMatch(
      /if \(backgroundLockSeconds === 0\) \{\r?\n\s+destroySensitivePage\(\);/u,
    );
    expect(accessSource).toContain('backgroundLockSeconds * 1_000');
    expect(accessSource).toContain(
      "if (pendingCreation) window.addEventListener('blur', blurPendingBackup)",
    );
    expect(accessSource).toContain(
      "window.addEventListener('pagehide', destroySensitivePage)",
    );
  });

  it('cannot render a wallet after its in-memory session has been destroyed', () => {
    expect(accessSource).toContain(
      'if (activeWallet && sessionActive)',
    );
    expect(accessSource).toContain('setSessionActive(false)');
  });
});
