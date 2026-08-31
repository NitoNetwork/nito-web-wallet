const groupFrenchDigits = (digits: string) => {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join('\u202f');
};

const BIGINT_ZERO = BigInt(0);
const SATOSHIS_PER_NITO = BigInt(100_000_000);

export const formatNitoAmount = (
  satoshis: number | bigint,
  {
    minimumFractionDigits = 0,
    maximumFractionDigits = 8,
  }: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  } = {},
) => {
  if (
    minimumFractionDigits < 0 ||
    maximumFractionDigits > 8 ||
    minimumFractionDigits > maximumFractionDigits
  ) {
    throw new Error('Invalid NITO fraction digit range.');
  }
  const normalized =
    typeof satoshis === 'bigint' ? satoshis : BigInt(Math.trunc(satoshis));
  const negative = normalized < BIGINT_ZERO;
  const absolute = negative ? -normalized : normalized;
  const whole = groupFrenchDigits((absolute / SATOSHIS_PER_NITO).toString());
  const allFraction = (absolute % SATOSHIS_PER_NITO).toString().padStart(8, '0');
  let fraction = allFraction.slice(0, maximumFractionDigits);
  while (fraction.length > minimumFractionDigits && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative ? '−' : ''}${whole}${fraction ? `,${fraction}` : ''}`;
};
