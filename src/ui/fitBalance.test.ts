import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WalletBalance } from '../../components/wallet-balance';
import { fitBalanceFontSize } from './fitBalance';
import { formatNitoAmount } from './formatNito';

describe('responsive total balance', () => {
  it('keeps the preferred size when the complete amount and currency fit', () => {
    expect(
      fitBalanceFontSize({
        availableWidth: 600,
        amountWidth: 100,
        decorationWidth: 48,
        preferredFontSize: 60,
      }),
    ).toBe(60);
  });

  it.each([232, 264, 302, 335, 600, 900])(
    'fits long amounts into %i pixels without reducing the currency label',
    (availableWidth) => {
      const fontSize = fitBalanceFontSize({
        availableWidth,
        amountWidth: 950,
        decorationWidth: 48,
        preferredFontSize: 60,
      });
      expect(fontSize).toBeGreaterThan(0);
      expect(fontSize).toBeLessThanOrEqual(60);
      expect((950 * fontSize) / 60 + 48).toBeLessThan(availableWidth);
    },
  );

  it('grows back when space increases or the balance becomes shorter', () => {
    const measure = {
      amountWidth: 520,
      decorationWidth: 48,
      preferredFontSize: 36,
    };
    expect(
      fitBalanceFontSize({ ...measure, availableWidth: 264 }),
    ).toBeLessThan(36);
    expect(fitBalanceFontSize({ ...measure, availableWidth: 900 })).toBe(36);
    expect(
      fitBalanceFontSize({ ...measure, availableWidth: 264, amountWidth: 100 }),
    ).toBe(36);
  });

  it('ignores measurements from hidden or unmeasurable containers', () => {
    const measure = {
      availableWidth: 300,
      amountWidth: 500,
      decorationWidth: 48,
      preferredFontSize: 36,
    };
    for (const patch of [
      { availableWidth: 0 },
      { amountWidth: 0 },
      { availableWidth: NaN },
      { decorationWidth: -1 },
    ]) {
      expect(fitBalanceFontSize({ ...measure, ...patch })).toBe(36);
    }
  });

  it.each(['0', '1', '856072002013999', '9007199254740991'].map(BigInt))(
    'renders every digit of %s satoshis and the currency as real text',
    (satoshis) => {
      const markup = renderToStaticMarkup(
        createElement(WalletBalance, { satoshis }),
      );
      expect(markup).toContain(formatNitoAmount(satoshis));
      expect(markup).toContain('NITO');
      expect(markup).toContain('whitespace-nowrap');
      expect(markup).not.toMatch(/truncate|text-ellipsis|line-clamp|scale\(/);
    },
  );
});
