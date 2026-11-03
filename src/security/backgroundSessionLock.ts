import type { BackgroundLockSeconds } from './sessionPolicy';

/** Apply ordinary delays while keeping sensitive background exits strict. */
export function watchBackgroundSession({
  page,
  windowEvents,
  delaySeconds,
  trackWindowFocus,
  lockWhenDisabled = false,
  onLock,
}: {
  page: EventTarget & { visibilityState: string; hasFocus(): boolean };
  windowEvents: EventTarget;
  delaySeconds: BackgroundLockSeconds;
  trackWindowFocus: boolean;
  lockWhenDisabled?: boolean;
  onLock: () => void;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  let locked = false;
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const lock = () => {
    if (locked) return;
    locked = true;
    clearTimer();
    onLock();
  };
  const update = () => {
    if (locked) return;
    // Check elapsed wall time too: browsers may suspend background timers.
    if (deadline !== undefined && Date.now() >= deadline) {
      lock();
      return;
    }
    const background =
      page.visibilityState === 'hidden' ||
      (trackWindowFocus && !page.hasFocus());
    if (background) {
      if (delaySeconds === 0) {
        deadline = undefined;
        clearTimer();
        if (lockWhenDisabled) lock();
        return;
      }
      // Blur and visibilitychange belong to the same absence; never extend it.
      if (deadline !== undefined) return;
      deadline = Date.now() + delaySeconds * 1_000;
      timer = setTimeout(lock, delaySeconds * 1_000);
      return;
    }
    deadline = undefined;
    clearTimer();
  };
  const restoreFromPageCache = (event: Event) => {
    if ((event as PageTransitionEvent).persisted) lock();
  };

  page.addEventListener('visibilitychange', update);
  windowEvents.addEventListener('pagehide', lock);
  windowEvents.addEventListener('pageshow', restoreFromPageCache);
  if (trackWindowFocus) {
    windowEvents.addEventListener('blur', update);
    windowEvents.addEventListener('focus', update);
  }
  update();
  return () => {
    clearTimer();
    page.removeEventListener('visibilitychange', update);
    windowEvents.removeEventListener('pagehide', lock);
    windowEvents.removeEventListener('pageshow', restoreFromPageCache);
    windowEvents.removeEventListener('blur', update);
    windowEvents.removeEventListener('focus', update);
  };
}
