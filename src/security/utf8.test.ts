import { describe, expect, it } from 'vitest';

import { decodeUtf8 } from './utf8';

describe('decodeUtf8', () => {
  it('decodes ASCII and multibyte Unicode without TextDecoder', () => {
    const bytes = Uint8Array.from([
      0x4e, 0x69, 0x74, 0x6f, 0x20,
      0xc3, 0xa9, 0x20,
      0xe2, 0x82, 0xac, 0x20,
      0xf0, 0x9f, 0x94, 0x90,
    ]);

    expect(decodeUtf8(bytes)).toBe('Nito é € 🔐');
  });

  it('rejects truncated, overlong, surrogate, and out-of-range sequences', () => {
    expect(() => decodeUtf8(Uint8Array.from([0xc2]))).toThrow('Invalid UTF-8 data.');
    expect(() => decodeUtf8(Uint8Array.from([0xe0, 0x80, 0x80]))).toThrow('Invalid UTF-8 data.');
    expect(() => decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toThrow('Invalid UTF-8 data.');
    expect(() => decodeUtf8(Uint8Array.from([0xf4, 0x90, 0x80, 0x80]))).toThrow(
      'Invalid UTF-8 data.',
    );
  });
});
