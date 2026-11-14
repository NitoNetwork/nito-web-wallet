import { describe, expect, it } from 'vitest';

import type { Translator } from '../i18n';
import {
  walletHomeBalancePresentation,
  walletNetworkStatusLabel,
} from './walletHomeSummary';

const presentation = (
  overrides: Partial<Parameters<typeof walletHomeBalancePresentation>[0]> = {},
) =>
  walletHomeBalancePresentation({
    unconfirmedSats: 0,
    immatureCoinbaseSats: 0,
    immatureCoinbaseBlocksRemaining: 0,
    ...overrides,
  });

describe('wallet home balance presentation', () => {
  it('keeps only the spendable metric when no conditional balance exists', () => {
    expect(presentation()).toMatchObject({
      showPending: false,
      showImmature: false,
    });
  });

  it('shows pending and immature balances independently', () => {
    expect(presentation({ unconfirmedSats: 1 })).toMatchObject({
      showPending: true,
      showImmature: false,
    });
    expect(
      presentation({
        immatureCoinbaseSats: 50_000_000,
        immatureCoinbaseBlocksRemaining: 17,
      }),
    ).toMatchObject({
      showPending: false,
      showImmature: true,
    });
    expect(
      presentation({
        unconfirmedSats: 1,
        immatureCoinbaseSats: 50_000_000,
        immatureCoinbaseBlocksRemaining: 17,
      }),
    ).toMatchObject({
      showPending: true,
      showImmature: true,
    });
  });

  it('reports the closest immature reward at the exact 101-confirmation boundary', () => {
    expect(
      presentation({
        immatureCoinbaseSats: 50_000_000,
        immatureCoinbaseBlocksRemaining: 17,
      }),
    ).toMatchObject({
      immatureConfirmations: 84,
      immatureBlocksRemaining: 17,
      requiredConfirmations: 101,
    });
    expect(
      presentation({
        immatureCoinbaseSats: 50_000_000,
        immatureCoinbaseBlocksRemaining: 1,
      }),
    ).toMatchObject({
      immatureConfirmations: 100,
      immatureBlocksRemaining: 1,
      requiredConfirmations: 101,
    });
  });

  it('bounds malformed maturity input without displaying an impossible progress', () => {
    expect(
      presentation({
        immatureCoinbaseSats: 1,
        immatureCoinbaseBlocksRemaining: 999,
      }),
    ).toMatchObject({
      immatureConfirmations: 0,
      immatureBlocksRemaining: 101,
    });
    expect(
      presentation({
        immatureCoinbaseSats: 1,
        immatureCoinbaseBlocksRemaining: -5,
      }),
    ).toMatchObject({
      immatureConfirmations: 101,
      immatureBlocksRemaining: 0,
    });
  });
});

describe('wallet network status label', () => {
  const translate: Translator = (_key, variables) =>
    `${variables?.status} · Block ${variables?.height}`;

  it('never displays a false block zero while the chain height is unknown', () => {
    expect(
      walletNetworkStatusLabel({
        status: 'Connecting',
        blockHeight: 0,
        language: 'en',
        t: translate,
      }),
    ).toBe('Connecting');
  });

  it('formats a known height for the selected interface locale', () => {
    expect(
      walletNetworkStatusLabel({
        status: 'Synchronisé',
        blockHeight: 1_005_074,
        language: 'fr',
        t: translate,
      }),
    ).toBe('Synchronisé · Block 1 005 074');
  });
});
