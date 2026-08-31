'use client';

import { Check, ChevronDown, Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { WALLET_LANGUAGES, useI18n } from '@/src/i18n';

type WalletLanguageSelectProps = {
  id: string;
};

export function WalletLanguageSelect({ id }: WalletLanguageSelectProps) {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeLanguage =
    WALLET_LANGUAGES.find(({ code }) => code === language) ??
    WALLET_LANGUAGES[0];
  const listboxId = `${id}-listbox`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const languagePanel = open ? (
    <div
      id={listboxId}
      role="menu"
      aria-label={t('settings.languageLabel')}
      className="absolute top-full right-0 z-[80] mt-2 max-h-[min(22rem,calc(100vh-6rem))] w-48 overflow-y-auto rounded-2xl border border-sky-200/15 bg-[#07111f] p-1.5"
    >
      {WALLET_LANGUAGES.map(({ code, label }) => {
        const selected = code === language;
        return (
          <button
            key={code}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold outline-none transition-colors duration-150 ${selected ? 'bg-sky-400/18 text-sky-100' : 'text-slate-300 hover:bg-white/[0.065] hover:text-white focus-visible:bg-sky-300/12 focus-visible:text-sky-100'}`}
            onClick={() => {
              setLanguage(code);
              setOpen(false);
            }}
          >
            <span>{label}</span>
            {selected ? (
              <Check className="size-4 text-sky-300" aria-hidden="true" />
            ) : null}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('settings.languageLabel')}
        className="group/language flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-sky-200/[0.12] bg-[#081321] px-2.5 text-xs font-bold text-slate-300 outline-none transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-300/25 hover:bg-[#0b1a2d] hover:text-sky-100 focus-visible:border-sky-300/40 focus-visible:ring-4 focus-visible:ring-sky-300/10 sm:px-3"
        onClick={() => setOpen((current) => !current)}
      >
        <Languages
          className="size-4 text-sky-300 transition-transform duration-200 group-hover/language:rotate-6"
          aria-hidden="true"
        />
        <span className="sm:hidden" aria-hidden="true">
          {language.toUpperCase()}
        </span>
        <span className="hidden sm:inline" aria-hidden="true">
          {activeLanguage.label}
        </span>
        <ChevronDown
          className={`size-3 text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {languagePanel}
    </div>
  );
}
