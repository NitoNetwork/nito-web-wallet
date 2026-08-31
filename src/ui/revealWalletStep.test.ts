import { describe, expect, it, vi } from 'vitest';

import { revealWalletStep } from './revealWalletStep';

const revealableElement = () => {
  const scrollIntoView = vi.fn();
  const focus = vi.fn();
  return {
    element: { scrollIntoView, focus } as unknown as HTMLElement,
    focus,
    scrollIntoView,
  };
};

describe('revealWalletStep', () => {
  it('smoothly reveals and focuses the next wallet action', () => {
    const target = revealableElement();

    revealWalletStep(target.element, false);

    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('disables smooth motion when the user requests reduced motion', () => {
    const target = revealableElement();

    revealWalletStep(target.element, true);

    expect(target.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'auto' }),
    );
  });

  it('does nothing when the target is not mounted', () => {
    expect(() => revealWalletStep(null, true)).not.toThrow();
  });
});
