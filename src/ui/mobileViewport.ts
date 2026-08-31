export const MOBILE_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover';

export const RESET_VIEWPORT_CONTENT =
  'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

const RESET_SCALE_THRESHOLD = 1.01;
const MAX_RESET_FRAMES = 12;

type ViewportMeta = Pick<HTMLMetaElement, 'content'>;
type FrameScheduler = (callback: FrameRequestCallback) => number;

export function shouldResetPinchZoom(
  pinchObserved: boolean,
  scale: number | undefined,
): boolean {
  return pinchObserved && scale !== undefined && scale > RESET_SCALE_THRESHOLD;
}

export function beginTransientViewportReset(
  meta: ViewportMeta,
  getScale: () => number,
  scheduleFrame: FrameScheduler,
): () => void {
  let cancelled = false;
  let frameCount = 0;
  meta.content = RESET_VIEWPORT_CONTENT;

  const restorePinchZoom = () => {
    if (cancelled) return;
    frameCount += 1;
    if (getScale() <= RESET_SCALE_THRESHOLD || frameCount >= MAX_RESET_FRAMES) {
      meta.content = MOBILE_VIEWPORT_CONTENT;
      return;
    }
    scheduleFrame(restorePinchZoom);
  };

  scheduleFrame(restorePinchZoom);
  return () => {
    cancelled = true;
    meta.content = MOBILE_VIEWPORT_CONTENT;
  };
}
