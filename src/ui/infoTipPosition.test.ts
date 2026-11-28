import { describe, expect, it } from 'vitest';

import { positionInfoTip } from './infoTipPosition';

const desktop = { left: 0, top: 0, width: 1440, height: 900 };
const anchor = { left: 420, top: 210, width: 32, height: 32 };
const popup = { width: 320, height: 94 };

describe('question-mark help placement', () => {
  it('opens eight pixels below the clicked button on desktop', () => {
    expect(positionInfoTip(anchor, popup, desktop, false)).toMatchObject({
      left: 276,
      top: 250,
    });
  });

  it('flips above a button near the bottom and keeps the text on screen at either edge', () => {
    expect(
      positionInfoTip({ ...anchor, left: 5, top: 842 }, popup, desktop, false),
    ).toMatchObject({ left: 16, top: 740 });
    expect(
      positionInfoTip({ ...anchor, left: 1400 }, popup, desktop, false).left,
    ).toBe(1104);
  });

  it('keeps tall help on the side with more room and limits its scrolling area', () => {
    expect(
      positionInfoTip(
        { ...anchor, top: 460 },
        { ...popup, height: 1000 },
        desktop,
        false,
      ),
    ).toMatchObject({ top: 16, maxHeight: 436 });
  });

  it('centers phone help within the visible viewport even when zoomed or panned', () => {
    const phone = { left: 45, top: 100, width: 320, height: 480 };
    expect(positionInfoTip(anchor, popup, phone, true)).toEqual({
      left: 61,
      top: 293,
      maxHeight: 448,
    });
    expect(
      positionInfoTip(anchor, { ...popup, height: 700 }, phone, true),
    ).toEqual({ left: 61, top: 116, maxHeight: 448 });
  });
});
