type BalanceMeasurements = {
  availableWidth: number;
  amountWidth: number;
  decorationWidth: number;
  preferredFontSize: number;
};

export function fitBalanceFontSize({
  availableWidth,
  amountWidth,
  decorationWidth,
  preferredFontSize,
}: BalanceMeasurements): number {
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(amountWidth) ||
    !Number.isFinite(decorationWidth) ||
    !Number.isFinite(preferredFontSize) ||
    availableWidth <= 0 ||
    amountWidth <= 0 ||
    decorationWidth < 0 ||
    preferredFontSize <= 0
  ) {
    return preferredFontSize;
  }

  // Keep the currency label at its normal size and leave a subpixel safety gap.
  const widthForAmount = Math.max(0, availableWidth - decorationWidth - 1);
  return Math.max(
    1,
    Math.min(
      preferredFontSize,
      (preferredFontSize * widthForAmount) / amountWidth,
    ),
  );
}
