'use client';

import Image from 'next/image';
import { ExternalLink } from 'lucide-react';

import { WalletLanguageSelect } from '@/components/wallet-language-select';
import { LanguageProvider, useI18n } from '@/src/i18n';
import { WalletAccessWorkspace } from './wallet-access-workspace';

function NitoBrand() {
  return (
    <div className="group/brand flex items-center gap-3">
      <Image
        alt="Nito"
        className="size-11 rounded-2xl border border-sky-200/[0.12] bg-[#030916] object-contain p-2 transition-transform duration-300 group-hover/brand:-rotate-3 group-hover/brand:scale-105 motion-reduce:transition-none"
        height={40}
        priority
        src="/nito-logo.svg"
        width={40}
      />
      <div>
        <p className="text-[15px] font-black leading-none tracking-[0.2em] text-white">
          NITO
        </p>
        <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Web Wallet
        </p>
      </div>
    </div>
  );
}

function WalletPage() {
  const { t } = useI18n();

  return (
    <main className="wallet-canvas flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-sky-200/[0.08] bg-[#020712]/96">
        <div className="mx-auto flex h-18 max-w-6xl items-center justify-between px-4 sm:px-6">
          <NitoBrand />
          <div className="flex items-center gap-2">
            <WalletLanguageSelect id="header-wallet-language" />
            <div
              className="flex items-center gap-2 rounded-full border border-emerald-300/10 bg-emerald-300/[0.045] px-2 py-1.5 text-[11px] font-bold text-emerald-100/80 sm:px-3"
              title={t('app.ready')}
            >
              <span className="size-2 rounded-full bg-emerald-400" />
              <span className="hidden sm:inline">{t('app.ready')}</span>
            </div>
          </div>
        </div>
      </header>

      <WalletAccessWorkspace />

      <footer className="mt-auto border-t border-sky-200/[0.08] px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-6xl justify-center">
          <a
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-center text-sm font-semibold text-slate-400 transition-colors hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            href="https://github.com/NitoNetwork/nito-web-wallet"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{t('footer.officialRepository')}</span>
            <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
          </a>
        </div>
      </footer>
    </main>
  );
}

export default function Home() {
  return (
    <LanguageProvider>
      <WalletPage />
    </LanguageProvider>
  );
}
