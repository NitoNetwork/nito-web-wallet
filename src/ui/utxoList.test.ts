import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { LanguageProvider } from '../i18n';
import { WalletUtxoList } from '../../components/wallet-utxo-list';
import { HD_ACCOUNT_TEMPLATES } from '../domain/wallet-policy';
import type { ElectrumUtxo } from '../network/electrum';
import { sortedUtxos, utxoConfirmations, utxoPage } from './utxoList';

const utxo = (index: number): ElectrumUtxo => ({
  txid: index.toString(16).padStart(64, '0'),
  vout: 0,
  valueSats: 100_000,
  address: '',
  height: 100 + index,
  confirmations: 1,
  blockTime: 1_780_000_000 + index,
});

describe('UTXO list', () => {
  it('places the snapshot list only in its dedicated view, between Send and Settings', () => {
    const source = readFileSync(resolve('app/wallet-dashboard.tsx'), 'utf8');
    const tree = ts.createSourceFile(
      'dashboard.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const listViews: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(tree) === 'WalletUtxoList'
      ) {
        expect(node.getText(tree)).toContain('utxos={snapshot.utxos}');
        expect(node.getText(tree)).toContain('addresses={snapshot.addresses}');
        expect(node.getText(tree)).toContain(
          'blockHeight={network?.blockHeight ?? 0}',
        );
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isConditionalExpression(parent))
          parent = parent.parent;
        expect(parent).toBeDefined();
        if (parent && ts.isConditionalExpression(parent))
          listViews.push(parent.condition.getText(tree));
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    expect(listViews).toEqual(["activeView === 'utxos'"]);
    const navigation = source.slice(
      source.indexOf('const navigation = ['),
      source.indexOf('async function revealRecoveryPhrase'),
    );
    expect(
      [...navigation.matchAll(/key: '([^']+)'/gu)].map((match) => match[1]),
    ).toEqual(['home', 'receive', 'send', 'utxos', 'settings']);
    expect(navigation).toContain("label: t('nav.utxos')");
  });

  it('sorts pending first, then dates newest first, with stable outpoint ties', () => {
    const outputs = [
      utxo(1),
      utxo(2),
      { ...utxo(3), height: 0, firstSeenAt: 1_780_000_030 },
    ];
    expect(sortedUtxos(outputs).map((item) => item.txid)).toEqual([
      utxo(3).txid,
      utxo(2).txid,
      utxo(1).txid,
    ]);
    expect(outputs[0].txid).toBe(utxo(1).txid);
    expect(
      sortedUtxos([{ ...utxo(1), vout: 2 }, utxo(1)]).map((item) => item.vout),
    ).toEqual([0, 2]);
  });

  it('limits pages to five, allows direct access, and clamps after spending/removal', () => {
    const outputs = Array.from({ length: 12 }, (_, index) => utxo(index));
    expect(utxoPage(outputs, 1).rows).toHaveLength(5);
    expect(utxoPage(outputs, 2).rows[0]).toEqual(utxo(5));
    expect(utxoPage(outputs, 3).rows).toHaveLength(2);
    expect(utxoPage(outputs.slice(0, 6), 3)).toMatchObject({
      page: 2,
      pageCount: 2,
    });
    expect(utxoPage([], 9)).toEqual({ page: 1, pageCount: 1, rows: [] });
    expect(utxoPage(outputs, NaN).page).toBe(1);
  });

  it('updates confirmations from the existing block subscription without a new UTXO query', () => {
    expect(utxoConfirmations(utxo(0), 199)).toBe(100);
    expect(utxoConfirmations(utxo(0), 200)).toBe(101);
    expect(utxoConfirmations(utxo(0), 99)).toBe(0);
    expect(utxoConfirmations({ ...utxo(0), height: 0 }, 200)).toBe(0);
  });

  it('renders five rows with unique explorer links, maturity status and page navigation', () => {
    const outputs = Array.from({ length: 7 }, (_, index) => ({
      ...utxo(index),
      isCoinbase: true,
    }));
    const html = renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(WalletUtxoList, {
          utxos: outputs,
          addresses: [],
          blockHeight: 110,
        }),
      ),
    );
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('Immature reward');
    expect(html).toContain('blocks until maturity');
    expect(html).toContain('UTXO pages');
    expect(html).toContain('https://mempool-explorer.nito.network/tx/');
    expect(html).toContain('<time dateTime=');
  });

  it('shows each full owning address with the family from its synchronized metadata', () => {
    const addresses = HD_ACCOUNT_TEMPLATES.map(({ key, scriptType }) => ({
      address: `test-address-${key}`,
      scriptType,
    }));
    const outputs = addresses.map(({ address }, index) => ({
      ...utxo(index),
      address,
    }));
    const html = renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(WalletUtxoList, {
          utxos: outputs,
          addresses,
          blockHeight: 110,
        }),
      ),
    );
    const rows = html.match(/<li\b[\s\S]*?<\/li>/gu) ?? [];
    expect(rows).toHaveLength(addresses.length);
    for (const [index, { address }] of addresses.entries()) {
      const row = rows.find((content) => content.includes(address));
      expect(row).toContain(`>${HD_ACCOUNT_TEMPLATES[index].label}</span>`);
    }
    expect(html).not.toContain('Unknown type');
    expect(html).not.toContain('nested SegWit');
  });

  it('does not guess the address family when synchronized metadata is missing', () => {
    const html = renderToStaticMarkup(
      createElement(
        LanguageProvider,
        null,
        createElement(WalletUtxoList, {
          utxos: [{ ...utxo(1), address: 'unknown-address' }],
          addresses: [],
          blockHeight: 110,
        }),
      ),
    );
    expect(html).toContain('unknown-address');
    expect(html).toContain('Unknown type');
  });
});
