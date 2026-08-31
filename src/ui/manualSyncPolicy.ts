export const MANUAL_SYNC_COOLDOWN_MS = 60_000;

export const manualSyncAvailableAt = (startedAt: number): number =>
  startedAt + MANUAL_SYNC_COOLDOWN_MS;

export const manualSyncSecondsRemaining = (
  availableAt: number,
  now: number = Date.now(),
): number => Math.max(0, Math.ceil((availableAt - now) / 1_000));
