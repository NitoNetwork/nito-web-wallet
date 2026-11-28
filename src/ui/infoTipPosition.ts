export const INFO_TIP_MARGIN = 16;
const GAP = 8;

type Rect = { left: number; top: number; width: number; height: number };

export function positionInfoTip(
  anchor: Rect,
  popup: Pick<Rect, 'width' | 'height'>,
  viewport: Rect,
  centered: boolean,
) {
  const margin = INFO_TIP_MARGIN;
  const maxWidth = Math.max(0, viewport.width - 2 * margin);
  const maxHeight = Math.max(0, viewport.height - 2 * margin);
  const width = Math.min(popup.width, maxWidth);
  const height = Math.min(popup.height, maxHeight);

  if (centered) {
    return {
      left: viewport.left + (viewport.width - width) / 2,
      top: viewport.top + (viewport.height - height) / 2,
      maxHeight,
    };
  }

  const leftEdge = viewport.left + margin;
  const below = anchor.top + anchor.height + GAP;
  const above = anchor.top - GAP;
  const roomBelow = Math.max(
    0,
    viewport.top + viewport.height - margin - below,
  );
  const roomAbove = Math.max(0, above - viewport.top - margin);
  const useAbove = height > roomBelow && roomAbove > roomBelow;
  const idealLeft = anchor.left + (anchor.width - width) / 2;

  return {
    left: Math.max(leftEdge, Math.min(idealLeft, leftEdge + maxWidth - width)),
    top: useAbove ? above - Math.min(height, roomAbove) : below,
    maxHeight: useAbove ? roomAbove : roomBelow,
  };
}
