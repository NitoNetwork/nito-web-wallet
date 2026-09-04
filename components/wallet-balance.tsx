'use client';

import { useLayoutEffect, useRef } from 'react';
import { fitBalanceFontSize } from '@/src/ui/fitBalance';
import { formatNitoAmount } from '@/src/ui/formatNito';

export function WalletBalance({ satoshis }: { satoshis: number | bigint }) {
  const amount = formatNitoAmount(satoshis);
  const containerRef = useRef<HTMLParagraphElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const amountRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const line = lineRef.current;
    const value = amountRef.current;
    if (!container || !line || !value) return;
    let frame = 0;
    let disposed = false;

    const fit = () => {
      if (disposed || container.clientWidth <= 0) return;
      // Start from the responsive CSS size so short balances grow back normally.
      value.style.fontSize = '1em';
      const amountWidth = value.getBoundingClientRect().width;
      const fontSize = fitBalanceFontSize({
        availableWidth: container.clientWidth,
        amountWidth,
        decorationWidth: line.getBoundingClientRect().width - amountWidth,
        preferredFontSize: Number.parseFloat(getComputedStyle(value).fontSize),
      });
      value.style.fontSize = `${fontSize}px`;
    };

    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };

    fit();
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(container);
    // Language changes and font substitution can resize text without resizing
    // its container. The max-content line settles after the fitted size is set.
    observer.observe(line);
    window.addEventListener('resize', scheduleFit);
    document.fonts.addEventListener('loadingdone', scheduleFit);
    void document.fonts.ready.then(() => {
      if (!disposed) scheduleFit();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      document.fonts.removeEventListener('loadingdone', scheduleFit);
    };
  }, [amount]);

  return (
    <p
      ref={containerRef}
      className="mt-4 w-full min-w-0 text-center font-mono text-4xl font-black sm:text-6xl"
    >
      <span
        ref={lineRef}
        className="inline-flex w-max items-baseline whitespace-nowrap"
      >
        <span
          ref={amountRef}
          className="bg-gradient-to-b from-white to-slate-300 bg-clip-text tracking-[-0.045em] text-transparent"
        >
          {amount}
        </span>{' '}
        <span className="ml-2 shrink-0 text-base text-slate-500">NITO</span>
      </span>
    </p>
  );
}
