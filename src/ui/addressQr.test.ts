import encodeQR, { Bitmap } from 'qr';
import decodeQR from 'qr/decode.js';
import { describe, expect, it } from 'vitest';

import { createAddressQr } from './addressQr';

const ADDRESS = 'nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02';

describe('address QR', () => {
  it('encodes the raw validated Nito address into a deterministic square path', () => {
    const first = createAddressQr(`  ${ADDRESS}  `);
    const second = createAddressQr(ADDRESS);

    expect(first).toEqual(second);
    expect(first.payload).toBe(ADDRESS);
    expect(first.size).toBeGreaterThanOrEqual(21 + 8);
    expect(first.path).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it('round-trips the exact payload through the independent decoder', () => {
    const matrix = encodeQR(ADDRESS, 'raw', {
      border: 4,
      ecc: 'quartile',
      encoding: 'byte',
    });
    const bitmap = new Bitmap(
      { height: matrix.length, width: matrix[0]?.length ?? 0 },
      matrix,
    );

    expect(decodeQR(bitmap.scale(8).toImage())).toBe(ADDRESS);
  });

  it('rejects non-Nito or private-address placeholders before encoding', () => {
    expect(() => createAddressQr('not-an-address')).toThrow();
    expect(() =>
      createAddressQr('nito1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'),
    ).toThrow('Private address unavailable');
  });
});
