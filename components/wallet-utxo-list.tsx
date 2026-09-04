'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/info-tip';
import { useI18n } from '@/src/i18n';
import { HD_ACCOUNT_TEMPLATES } from '@/src/domain/wallet-policy';
import type { ElectrumUtxo } from '@/src/network/electrum';
import type { WalletAddress } from '@/src/wallet/transparentScan';
import { nitoTransactionExplorerUrl } from '@/src/network/explorer';
import { COINBASE_MATURITY_CONFIRMATIONS } from '@/src/wallet/coinbaseMaturity';
import { formatNitoAmount } from '@/src/ui/formatNito';
import { sortedUtxos, utxoConfirmations, utxoPage } from '@/src/ui/utxoList';

export function WalletUtxoList({
  utxos,
  addresses,
  blockHeight,
}: {
  utxos: readonly ElectrumUtxo[];
  addresses: readonly Pick<WalletAddress, 'address' | 'scriptType'>[];
  blockHeight: number;
}) {
  const { language, t } = useI18n();
  const [requestedPage, setPage] = useState(1);
  const ordered = useMemo(() => sortedUtxos(utxos), [utxos]);
  const addressTypes = useMemo(
    () =>
      new Map(
        addresses.map(({ address, scriptType }) => [
          address,
          HD_ACCOUNT_TEMPLATES.find(
            (template) => template.scriptType === scriptType,
          )?.label,
        ]),
      ),
    [addresses],
  );
  const { page, pageCount, rows } = utxoPage(ordered, requestedPage);
  if (requestedPage !== page) setPage(page);
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }),
    [language],
  );

  return (
    <Card className="glass-panel overflow-visible bg-transparent py-0">
      <CardContent className="p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <CardTitle className="text-base text-white">
            {t('utxos.title')}
          </CardTitle>
          <InfoTip label={t('utxos.about')}>{t('utxos.help')}</InfoTip>
          <span className="ml-auto text-sm tabular-nums text-slate-400">
            {utxos.length}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">{t('utxos.empty')}</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {rows.map((utxo) => {
              const confirmations = utxoConfirmations(utxo, blockHeight);
              const immature =
                utxo.isCoinbase === true &&
                confirmations > 0 &&
                confirmations < COINBASE_MATURITY_CONFIRMATIONS;
              const timestamp =
                utxo.height > 0 ? utxo.blockTime : utxo.firstSeenAt;
              return (
                <li
                  key={`${utxo.txid}:${utxo.vout}`}
                  className="space-y-2 py-4 first:pt-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-base font-semibold text-slate-100">
                      {formatNitoAmount(utxo.valueSats)} NITO
                    </span>
                    <span
                      className={`text-sm ${confirmations === 0 || immature ? 'text-amber-200' : 'text-emerald-200'}`}
                    >
                      {t(
                        confirmations === 0
                          ? 'utxos.pending'
                          : immature
                            ? 'utxos.immature'
                            : 'utxos.spendable',
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap justify-between gap-x-4 gap-y-2 text-sm text-slate-400">
                    <span>
                      {timestamp ? (
                        <>
                          {t(
                            utxo.height > 0
                              ? 'utxos.blockDate'
                              : 'utxos.firstSeen',
                          )}{' '}
                          <time
                            dateTime={new Date(timestamp * 1_000).toISOString()}
                          >
                            {dateFormat.format(timestamp * 1_000)}
                          </time>
                        </>
                      ) : (
                        t('utxos.dateUnavailable')
                      )}
                    </span>
                    <span className="tabular-nums">
                      {t('utxos.confirmations', { count: confirmations })}
                      {immature
                        ? ` · ${t('utxos.remaining', { count: Math.max(0, COINBASE_MATURITY_CONFIRMATIONS - confirmations) })}`
                        : ''}
                    </span>
                  </div>
                  <div className="space-y-1.5 rounded-xl border border-white/[0.06] px-3 py-2">
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                      <span>{t('utxos.address')}</span>
                      <span className="rounded-md bg-sky-300/[0.08] px-2 py-0.5 font-semibold text-sky-200">
                        {addressTypes.get(utxo.address) ??
                          t('utxos.unknownType')}
                      </span>
                    </div>
                    <p className="select-all break-all font-mono text-xs leading-5 text-slate-200">
                      {utxo.address}
                    </p>
                  </div>
                  <a
                    href={nitoTransactionExplorerUrl(utxo.txid)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-8 max-w-full items-center gap-2 break-all font-mono text-sm text-sky-300 underline-offset-4 hover:underline"
                    aria-label={t('utxos.open', {
                      txid: utxo.txid,
                      index: utxo.vout,
                    })}
                  >
                    {`${utxo.txid.slice(0, 12)}…${utxo.txid.slice(-8)}:${utxo.vout}`}
                    <ExternalLink
                      aria-hidden="true"
                      className="size-3 shrink-0"
                    />
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {pageCount > 1 ? (
          <nav
            aria-label={t('utxos.pagination')}
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4"
          >
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={page === 1}
              aria-label={t('utxos.previous')}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <form
              className="flex flex-wrap items-center justify-center gap-2 text-sm"
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get('page');
                setPage(utxoPage(ordered, Number(value)).page);
              }}
            >
              <label htmlFor="utxo-page" className="text-slate-400">
                {t('utxos.page')}
              </label>
              <input
                key={page}
                id="utxo-page"
                name="page"
                type="number"
                inputMode="numeric"
                min={1}
                max={pageCount}
                step={1}
                defaultValue={page}
                className="min-h-10 w-16 rounded-xl border border-white/15 bg-slate-950 px-2 text-center text-slate-100 focus-visible:outline-2 focus-visible:outline-sky-300"
              />
              <span className="text-slate-400">{`/ ${pageCount}`}</span>
              <Button type="submit" size="sm" variant="outline">
                {t('utxos.go')}
              </Button>
            </form>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={page === pageCount}
              aria-label={t('utxos.next')}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </nav>
        ) : null}
      </CardContent>
    </Card>
  );
}
