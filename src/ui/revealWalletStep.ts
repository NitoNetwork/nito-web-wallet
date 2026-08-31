export function revealWalletStep(
  element: HTMLElement | null,
  reducedMotion?: boolean,
) {
  if (!element) return;

  const shouldReduceMotion =
    reducedMotion ??
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    behavior: shouldReduceMotion ? 'auto' : 'smooth',
    block: 'center',
    inline: 'nearest',
  });
  element.focus({ preventScroll: true });
}
