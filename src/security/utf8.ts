const invalidUtf8 = (): never => {
  throw new Error('Invalid UTF-8 data.');
};

const continuation = (bytes: Uint8Array, index: number): number => {
  const value = bytes[index];
  if (value === undefined || (value & 0xc0) !== 0x80) {
    return invalidUtf8();
  }
  return value & 0x3f;
};

export const decodeUtf8 = (bytes: Uint8Array): string => {
  let output = '';

  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? invalidUtf8();

    if (first <= 0x7f) {
      output += String.fromCodePoint(first);
      index += 1;
      continue;
    }

    if (first >= 0xc2 && first <= 0xdf) {
      const codePoint = ((first & 0x1f) << 6) | continuation(bytes, index + 1);
      output += String.fromCodePoint(codePoint);
      index += 2;
      continue;
    }

    if (first >= 0xe0 && first <= 0xef) {
      const second = continuation(bytes, index + 1);
      const third = continuation(bytes, index + 2);
      if ((first === 0xe0 && second < 0x20) || (first === 0xed && second >= 0x20)) {
        invalidUtf8();
      }
      output += String.fromCodePoint(((first & 0x0f) << 12) | (second << 6) | third);
      index += 3;
      continue;
    }

    if (first >= 0xf0 && first <= 0xf4) {
      const second = continuation(bytes, index + 1);
      const third = continuation(bytes, index + 2);
      const fourth = continuation(bytes, index + 3);
      if ((first === 0xf0 && second < 0x10) || (first === 0xf4 && second >= 0x10)) {
        invalidUtf8();
      }
      output += String.fromCodePoint(
        ((first & 0x07) << 18) | (second << 12) | (third << 6) | fourth,
      );
      index += 4;
      continue;
    }

    invalidUtf8();
  }

  return output;
};
