import { COINBASE_MATURITY_CONFIRMATIONS } from '../wallet/coinbaseMaturity';
import type { LanguageCode, Translator } from '../i18n';

type WalletHomeBalanceInput = {
  unconfirmedSats: number;
  immatureCoinbaseSats: number;
  immatureCoinbaseBlocksRemaining: number;
};

export type WalletHomeBalancePresentation = {
  showPending: boolean;
  showImmature: boolean;
  immatureConfirmations: number;
  immatureBlocksRemaining: number;
  requiredConfirmations: number;
};

export const walletNetworkStatusLabel = ({
  status,
  blockHeight,
  language,
  t,
}: {
  status: string;
  blockHeight: number;
  language: LanguageCode;
  t: Translator;
}): string => {
  if (blockHeight <= 0) return status;
  return t('wallet.statusAtBlock', {
    status,
    height: new Intl.NumberFormat(language).format(blockHeight),
  });
};

const boundedBlocksRemaining = (blocksRemaining: number): number =>
  Math.min(
    COINBASE_MATURITY_CONFIRMATIONS,
    Math.max(0, Math.trunc(blocksRemaining)),
  );

export const walletHomeBalancePresentation = ({
  unconfirmedSats,
  immatureCoinbaseSats,
  immatureCoinbaseBlocksRemaining,
}: WalletHomeBalanceInput): WalletHomeBalancePresentation => {
  const blocksRemaining = boundedBlocksRemaining(
    immatureCoinbaseBlocksRemaining,
  );

  return {
    showPending: unconfirmedSats > 0,
    showImmature: immatureCoinbaseSats > 0,
    immatureConfirmations: COINBASE_MATURITY_CONFIRMATIONS - blocksRemaining,
    immatureBlocksRemaining: blocksRemaining,
    requiredConfirmations: COINBASE_MATURITY_CONFIRMATIONS,
  };
};
