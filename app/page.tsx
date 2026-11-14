'use client';

import Image from 'next/image';
import { ExternalLink } from 'lucide-react';
import type { CSSProperties } from 'react';

import { WalletLanguageSelect } from '@/components/wallet-language-select';
import packageManifest from '@/package.json';
import { LanguageProvider, useI18n } from '@/src/i18n';
import { WalletAccessWorkspace } from './wallet-access-workspace';

const WALLET_VERSION = packageManifest.version;
const WALLET_VERSION_LABEL = `v${WALLET_VERSION}`;
const WALLET_RELEASE_URL = `https://github.com/NitoNetwork/nito-web-wallet/releases/tag/v${WALLET_VERSION}`;

function NitoBrand() {
  return (
    <div className="group/brand flex min-w-0 items-center gap-3 sm:gap-4">
      <Image
        alt="Nito"
        className="aurora-brand-logo size-12 shrink-0 object-contain transition-transform duration-500 group-hover/brand:-translate-y-0.5 group-hover/brand:scale-105 motion-reduce:transition-none sm:size-15"
        height={60}
        src="/nito-256.png"
        width={60}
      />
      <div className="min-w-0 sm:flex sm:items-baseline sm:gap-3">
        <p className="truncate text-[15px] font-black leading-none tracking-[0.2em] text-white sm:text-xl">
          NITO
        </p>
        <p className="mt-1.5 hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 min-[390px]:block sm:mt-0 sm:text-sm">
          Web Wallet
        </p>
      </div>
    </div>
  );
}

function WalletPage() {
  const { t } = useI18n();
  const walletCanvasStyle = {
    '--wallet-background-wide':
      'url("/nito-wallet-horizon-wide.png")',
    '--wallet-background-portrait': 'url("/nito-wallet-horizon.png")',
  } as CSSProperties;

  return (
    <main
      className="wallet-canvas flex min-h-dvh flex-col text-foreground"
      style={walletCanvasStyle}
    >
      <header className="aurora-header top-0 z-50 border-b">
        <div className="mx-auto flex h-20 max-w-[1500px] items-center justify-between gap-3 px-4 sm:h-22 sm:px-6 lg:px-8">
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

      <footer className="aurora-footer mt-auto border-t px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-center gap-x-2">
          <a
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-center text-sm font-semibold text-slate-400 transition-colors hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            href="https://github.com/NitoNetwork/nito-web-wallet"
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{t('footer.officialRepository')}</span>
            <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
          </a>
          <span aria-hidden="true" className="text-slate-700">
            {'·'}
          </span>
          <a
            aria-label={WALLET_VERSION_LABEL}
            className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-sm font-semibold text-slate-500 transition-colors hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            href={WALLET_RELEASE_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            {WALLET_VERSION_LABEL}
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
