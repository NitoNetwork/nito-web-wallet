'use client';

import { CircleHelp } from 'lucide-react';
import {
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { INFO_TIP_MARGIN, positionInfoTip } from '@/src/ui/infoTipPosition';

type InfoTipProps = {
  children: ReactNode;
  label: string;
};

const PHONE_LAYOUT =
  '(max-width: 767px), (pointer: coarse) and (orientation: landscape) and (max-height: 500px)';

export function InfoTip({ children, label }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const popup = popupRef.current;
    if (!open || !button || !popup) return;
    const screen = window.visualViewport;
    const phone = window.matchMedia(PHONE_LAYOUT);

    function update() {
      if (!button || !popup) return;
      const viewport = {
        left: screen?.offsetLeft ?? 0,
        top: screen?.offsetTop ?? 0,
        width: screen?.width ?? document.documentElement.clientWidth,
        height: screen?.height ?? document.documentElement.clientHeight,
      };
      const anchor = button.getBoundingClientRect();
      if (
        !phone.matches &&
        (anchor.bottom <= viewport.top ||
          anchor.top >= viewport.top + viewport.height ||
          anchor.right <= viewport.left ||
          anchor.left >= viewport.left + viewport.width)
      ) {
        setOpen(false);
        return;
      }

      popup.style.maxWidth = `${Math.max(0, viewport.width - 2 * INFO_TIP_MARGIN)}px`;
      // Measure all the text even when the previous placement needed a scrollbar.
      const size = {
        width: popup.getBoundingClientRect().width,
        height: popup.scrollHeight + popup.offsetHeight - popup.clientHeight,
      };
      const position = positionInfoTip(anchor, size, viewport, phone.matches);
      popup.style.maxHeight = `${position.maxHeight}px`;
      popup.style.left = `${position.left}px`;
      popup.style.top = `${position.top}px`;
    }

    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !button.contains(event.target) &&
        !popup.contains(event.target)
      )
        setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(button);
    observer.observe(popup);
    observer.observe(document.body);
    phone.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    screen?.addEventListener('resize', update);
    screen?.addEventListener('scroll', update);
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      observer.disconnect();
      phone.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      screen?.removeEventListener('resize', update);
      screen?.removeEventListener('scroll', update);
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={label}
        className="grid size-8 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.035] text-slate-500 outline-none transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-300/30 hover:bg-sky-300/10 hover:text-sky-200 focus-visible:border-sky-300/50 focus-visible:ring-4 focus-visible:ring-sky-300/10"
        onClick={() => setOpen((current) => !current)}
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <span
            id={id}
            ref={popupRef}
            role="tooltip"
            className="fixed z-50 w-72 p-3 text-xs text-slate-300 transition-opacity motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 overflow-y-auto rounded-2xl border border-sky-200/15 bg-[#07111f] text-left font-medium leading-5 shadow-xl"
          >
            {children}
          </span>,
          document.body,
        )}
    </>
  );
}
