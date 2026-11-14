import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const styles = readFileSync(resolve('app/globals.css'), 'utf8');
const page = readFileSync(resolve('app/page.tsx'), 'utf8');
const dashboard = readFileSync(resolve('app/wallet-dashboard.tsx'), 'utf8');
const portraitPath = resolve('public/nito-wallet-horizon.png');
const landscapePath = resolve('public/nito-wallet-horizon-wide.png');

const readPngSize = (path: string) => {
  const png = readFileSync(path);
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
};

describe('wallet visual foundation', () => {
  it('keeps the mobile wallet artwork byte-identical on narrow screens', () => {
    const portrait = readFileSync(portraitPath);
    expect(createHash('sha256').update(portrait).digest('hex')).toBe(
      'c90672e5d4ece7c2c2c0f49a048d05a96a2f213499d8dfecdec4d3a268f3e74e',
    );
    expect(readPngSize(portraitPath)).toEqual({ width: 852, height: 1846 });
    expect(page).toContain('\'url("/nito-wallet-horizon.png")\'');
    expect(styles).toContain(
      'background-image: var(--wallet-background-portrait)',
    );
  });

  it('uses a dedicated panoramic companion without stretching the portrait', () => {
    expect(readPngSize(landscapePath)).toEqual({ width: 1672, height: 941 });
    expect(page).toContain(
      '\'url("/nito-wallet-horizon-wide.png")\'',
    );
    expect(styles).toContain(
      'background-image: var(--wallet-background-wide)',
    );
    expect(styles).toContain('background-size: 100% auto');
    expect(styles).not.toContain('.wallet-canvas::before');
    expect(styles).not.toContain('.wallet-canvas::after');
    expect(styles).not.toContain('.aurora-hero-horizon');
    expect(dashboard).not.toContain('aurora-hero-horizon');
  });

  it('restores the synchronization spin with a reduced-motion fallback', () => {
    expect(styles).toContain('@keyframes nito-scan-spin');
    expect(styles).toContain('animation: nito-scan-spin 2.8s linear infinite');
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.aurora-scan-logo,[\s\S]*animation: none !important/u,
    );
  });
});
