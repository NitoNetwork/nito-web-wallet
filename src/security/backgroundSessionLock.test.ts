import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchBackgroundSession } from './backgroundSessionLock';
import { BACKGROUND_LOCK_SECOND_OPTIONS } from './sessionPolicy';
import type { BackgroundLockSeconds } from './sessionPolicy';

class TestPage extends EventTarget {
  visibilityState = 'visible';
  focused = true;
  hasFocus() {
    return this.focused;
  }
}

function setup(
  delaySeconds: BackgroundLockSeconds = 30,
  trackWindowFocus = true,
  lockWhenDisabled = false,
) {
  const page = new TestPage();
  const windowEvents = new EventTarget();
  const onLock = vi.fn();
  const stop = watchBackgroundSession({
    page,
    windowEvents,
    delaySeconds,
    trackWindowFocus,
    lockWhenDisabled,
    onLock,
  });
  const focus = (focused: boolean) => {
    page.focused = focused;
    windowEvents.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  };
  const visible = (visible: boolean) => {
    page.visibilityState = visible ? 'visible' : 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
  };
  return { page, windowEvents, onLock, stop, focus, visible };
}

describe('background session lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const enabledDelays = BACKGROUND_LOCK_SECOND_OPTIONS.filter(
    (seconds): seconds is Exclude<BackgroundLockSeconds, 0> => seconds > 0,
  );

  it.each(enabledDelays)(
    'applies the configured %i-second delay when leaving seed backup',
    (seconds) => {
      const session = setup(seconds);
      session.focus(false);
      if (seconds > 0) {
        vi.advanceTimersByTime(seconds * 1_000 - 1);
        expect(session.onLock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
      }
      expect(session.onLock).toHaveBeenCalledTimes(1);
      session.stop();
    },
  );

  it('keeps an ordinary session open when background locking is disabled', () => {
    const session = setup(0, true);
    session.focus(false);
    session.visible(false);
    vi.advanceTimersByTime(120_000);
    session.visible(true);
    session.focus(true);
    expect(session.onLock).not.toHaveBeenCalled();
    session.stop();
  });

  it('keeps sensitive seed backup stricter when background locking is disabled', () => {
    const blurred = setup(0, true, true);
    blurred.focus(false);
    expect(blurred.onLock).toHaveBeenCalledTimes(1);
    blurred.stop();

    const hidden = setup(0, true, true);
    hidden.visible(false);
    expect(hidden.onLock).toHaveBeenCalledTimes(1);
    hidden.stop();
  });

  it('preserves creation on return before expiry and gives the next absence its own delay', () => {
    const session = setup();
    session.focus(false);
    vi.advanceTimersByTime(20_000);
    session.focus(true);
    vi.advanceTimersByTime(60_000);
    expect(session.onLock).not.toHaveBeenCalled();
    session.focus(false);
    vi.advanceTimersByTime(29_999);
    expect(session.onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('does not restart the delay when blur is followed by hiding the tab', () => {
    const session = setup();
    session.focus(false);
    vi.advanceTimersByTime(10_000);
    session.visible(false);
    vi.advanceTimersByTime(20_000);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.focus(true);
    session.visible(true);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('keeps counting while the tab is visible but another window still has focus', () => {
    const session = setup();
    session.focus(false);
    session.visible(false);
    vi.advanceTimersByTime(10_000);
    session.visible(true);
    vi.advanceTimersByTime(20_000);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('does not cancel the delay on a focus event while the tab is still hidden', () => {
    const session = setup();
    session.visible(false);
    session.focus(true);
    vi.advanceTimersByTime(30_000);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('locks on return after expiry even if the browser suspended the timer', () => {
    const session = setup();
    session.focus(false);
    vi.setSystemTime(Date.now() + 30_000);
    session.focus(true);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('retains the visibility-based delay for an already open wallet', () => {
    const session = setup(20, false);
    session.focus(false);
    vi.advanceTimersByTime(30_000);
    expect(session.onLock).not.toHaveBeenCalled();
    session.visible(false);
    vi.advanceTimersByTime(19_999);
    expect(session.onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('still destroys secrets immediately when navigating away or closing the page', () => {
    const session = setup(0);
    session.windowEvents.dispatchEvent(new Event('pagehide'));
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('destroys a session restored from the page cache', () => {
    const session = setup(0);
    const event = Object.assign(new Event('pageshow'), { persisted: true });
    session.windowEvents.dispatchEvent(event);
    expect(session.onLock).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('removes timers and event listeners on cleanup', () => {
    const session = setup();
    session.focus(false);
    session.stop();
    vi.advanceTimersByTime(60_000);
    session.visible(false);
    session.windowEvents.dispatchEvent(new Event('pagehide'));
    expect(session.onLock).not.toHaveBeenCalled();
  });
});
