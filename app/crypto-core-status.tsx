'use client';

import { CircleAlert, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { CryptoWorkerClient } from '@/src/crypto/cryptoWorkerClient';
import { useI18n } from '@/src/i18n';

type CryptoCoreState = 'checking' | 'ready' | 'unavailable';

export function CryptoCoreStatus() {
  const { t } = useI18n();
  const [state, setState] = useState<CryptoCoreState>('checking');

  useEffect(() => {
    const client = new CryptoWorkerClient();
    let mounted = true;
    void client
      .request({ type: 'health' })
      .then((capabilities) => {
        if (
          mounted &&
          capabilities.abiVersion === 1 &&
          capabilities.transparentOnly &&
          capabilities.maxDerivationIndex === 9_999
        ) {
          setState('ready');
        }
      })
      .catch(() => {
        if (mounted) setState('unavailable');
      })
      .finally(() => client.dispose());
    return () => {
      mounted = false;
      client.dispose();
    };
  }, []);

  if (state === 'ready') {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300/25 bg-emerald-300/8 text-emerald-200"
      >
        <ShieldCheck data-icon="inline-start" />
        {t('core.ready')}
      </Badge>
    );
  }
  if (state === 'unavailable') {
    return (
      <Badge variant="outline" className="border-red-300/25 bg-red-300/8 text-red-200">
        <CircleAlert data-icon="inline-start" />
        {t('core.unavailable')}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-sky-300/25 bg-sky-300/8 text-sky-100">
      <LoaderCircle className="animate-spin" data-icon="inline-start" />
      {t('core.checking')}
    </Badge>
  );
}
