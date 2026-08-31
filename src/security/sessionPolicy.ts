export const AUTO_LOCK_MINUTE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const BACKGROUND_LOCK_SECOND_OPTIONS = [
  0, 10, 20, 30, 40, 50, 60,
] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_MINUTE_OPTIONS)[number];
export type BackgroundLockSeconds =
  (typeof BACKGROUND_LOCK_SECOND_OPTIONS)[number];

export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 5;
export const DEFAULT_BACKGROUND_LOCK_SECONDS: BackgroundLockSeconds = 30;

export function isAutoLockMinutes(value: number): value is AutoLockMinutes {
  return AUTO_LOCK_MINUTE_OPTIONS.includes(value as AutoLockMinutes);
}

export function isBackgroundLockSeconds(
  value: number,
): value is BackgroundLockSeconds {
  return BACKGROUND_LOCK_SECOND_OPTIONS.includes(
    value as BackgroundLockSeconds,
  );
}
