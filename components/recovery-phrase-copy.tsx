'use client';

import { Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/src/i18n';
import { translateWalletError } from '@/src/i18nError';

type RecoveryPhraseCopyProps = {
  description?: ReactNode;
  mnemonic: string;
  secondaryAction?: ReactNode;
};

export function RecoveryPhraseCopy({
  description,
  mnemonic,
  secondaryAction,
}: RecoveryPhraseCopyProps) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();

  async function copyPhrase() {
    try {
      await navigator.clipboard.writeText(mnemonic);
      setArmed(false);
      setCopied(true);
      setError(undefined);
    } catch (caught: unknown) {
      setCopied(false);
      setError(translateWalletError(caught, t, 'copy'));
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {description ? (
          <p className="max-w-xl text-xs leading-5 text-amber-100/65">
            {description}
          </p>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setArmed(true);
              setCopied(false);
              setError(undefined);
            }}
          >
            <Copy data-icon="inline-start" />
            {t('backup.copyPhrase')}
          </Button>
          {secondaryAction}
        </div>
      </div>
      {armed ? (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-red-300/20 bg-red-300/[0.055] p-3.5"
        >
          <p className="text-xs font-semibold leading-5 text-red-100">
            {t('backup.clipboardWarning')}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setArmed(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={() => void copyPhrase()}>
              <Copy data-icon="inline-start" />
              {t('backup.confirmCopy')}
            </Button>
          </div>
        </div>
      ) : null}
      {copied ? (
        <output className="mt-3 block text-xs font-semibold leading-5 text-amber-100">
          {t('backup.copied')}
        </output>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-red-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
