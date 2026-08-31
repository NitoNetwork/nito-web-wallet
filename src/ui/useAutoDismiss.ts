'use client';

import { type Dispatch, type SetStateAction, useEffect } from 'react';

export const SUCCESS_NOTICE_DURATION_MS = 10_000;

export function useAutoDismiss<T>(
  value: T | undefined,
  setValue: Dispatch<SetStateAction<T | undefined>>,
  durationMs = SUCCESS_NOTICE_DURATION_MS,
): void {
  useEffect(() => {
    if (value === undefined) return;
    const timer = setTimeout(() => setValue(undefined), durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, setValue, value]);
}
