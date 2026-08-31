'use client';

import { useEffect } from 'react';

import {
  beginTransientViewportReset,
  MOBILE_VIEWPORT_CONTENT,
  shouldResetPinchZoom,
} from '@/src/ui/mobileViewport';

export function MobileViewportController() {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;

    const visualViewport = window.visualViewport;
    let pinchObserved = false;
    let resetTimer: number | undefined;
    let cancelActiveReset: (() => void) | undefined;
    meta.content = MOBILE_VIEWPORT_CONTENT;

    const noteVisualScale = () => {
      if ((visualViewport?.scale ?? 1) > 1.01) pinchObserved = true;
    };
    const noteTouchStart = (event: TouchEvent) => {
      if (event.touches.length >= 2) pinchObserved = true;
    };
    const noteGestureStart = () => {
      pinchObserved = true;
    };
    const finishPinch = () => {
      if (!pinchObserved) return;
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        const scale = visualViewport?.scale;
        if (!shouldResetPinchZoom(pinchObserved, scale)) {
          pinchObserved = false;
          return;
        }
        pinchObserved = false;
        cancelActiveReset?.();
        cancelActiveReset = beginTransientViewportReset(
          meta,
          () => window.visualViewport?.scale ?? 1,
          window.requestAnimationFrame.bind(window),
        );
      }, 0);
    };
    const noteTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) finishPinch();
    };

    document.addEventListener('touchstart', noteTouchStart, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchend', noteTouchEnd, {
      capture: true,
      passive: true,
    });
    document.addEventListener('touchcancel', finishPinch, {
      capture: true,
      passive: true,
    });
    window.addEventListener('gesturestart', noteGestureStart, { passive: true });
    window.addEventListener('gestureend', finishPinch, { passive: true });
    visualViewport?.addEventListener('resize', noteVisualScale, { passive: true });

    return () => {
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      cancelActiveReset?.();
      meta.content = MOBILE_VIEWPORT_CONTENT;
      document.removeEventListener('touchstart', noteTouchStart, true);
      document.removeEventListener('touchend', noteTouchEnd, true);
      document.removeEventListener('touchcancel', finishPinch, true);
      window.removeEventListener('gesturestart', noteGestureStart);
      window.removeEventListener('gestureend', finishPinch);
      visualViewport?.removeEventListener('resize', noteVisualScale);
    };
  }, []);

  return null;
}
