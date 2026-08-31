import { describe, expect, it } from 'vitest';

import {
  beginTransientViewportReset,
  MOBILE_VIEWPORT_CONTENT,
  RESET_VIEWPORT_CONTENT,
  shouldResetPinchZoom,
} from './mobileViewport';

describe('mobile viewport policy', () => {
  it('resets only a pinch-observed visual zoom', () => {
    expect(shouldResetPinchZoom(false, 2)).toBe(false);
    expect(shouldResetPinchZoom(true, undefined)).toBe(false);
    expect(shouldResetPinchZoom(true, 1)).toBe(false);
    expect(shouldResetPinchZoom(true, 1.5)).toBe(true);
  });

  it('temporarily clamps the viewport and restores future pinch gestures', () => {
    const meta = { content: MOBILE_VIEWPORT_CONTENT };
    const frames: FrameRequestCallback[] = [];
    let scale = 2;
    const cancel = beginTransientViewportReset(
      meta,
      () => scale,
      (callback) => frames.push(callback),
    );

    expect(meta.content).toBe(RESET_VIEWPORT_CONTENT);
    frames.shift()?.(0);
    expect(meta.content).toBe(RESET_VIEWPORT_CONTENT);

    scale = 1;
    frames.shift()?.(16);
    expect(meta.content).toBe(MOBILE_VIEWPORT_CONTENT);

    cancel();
    expect(meta.content).toBe(MOBILE_VIEWPORT_CONTENT);
  });
});
