import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { detectBrowserLanguage, WALLET_LANGUAGES } from './i18n';
import {
  TRANSLATED_SEND_ERROR_CODES,
  translateNetworkError,
  translateWalletError,
} from './i18nError';
import { MESSAGES, translateCatalogMessage } from './i18nMessages';

const placeholders = (message: string) =>
  [...message.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)]
    .map((match) => match[1])
    .sort();

describe('wallet languages', () => {
  it('offers the nine supported interface languages', () => {
    expect(WALLET_LANGUAGES.map(({ code }) => code)).toEqual([
      'en',
      'zh',
      'de',
      'es',
      'fr',
      'ja',
      'tr',
      'pt',
      'ru',
    ]);
  });

  it('selects the first supported browser language and falls back to English', () => {
    expect(detectBrowserLanguage(['fr-FR', 'en-US'])).toBe('fr');
    expect(detectBrowserLanguage(['nl-NL', 'pt-BR'])).toBe('pt');
    expect(detectBrowserLanguage(['nl-NL'])).toBe('en');
  });

  it('keeps every locale synchronously available for instant switching', () => {
    expect(WALLET_LANGUAGES.every(({ code }) => Boolean(MESSAGES[code]))).toBe(
      true,
    );
  });

  it('keeps wallet synchronization independent from translation changes', () => {
    const provider = readFileSync(
      resolve(process.cwd(), 'src/i18n.tsx'),
      'utf8',
    );
    const dashboard = readFileSync(
      resolve(process.cwd(), 'app/wallet-dashboard.tsx'),
      'utf8',
    );
    expect(provider).toContain(
      'translateCatalogMessage(language, key, variables)',
    );
    expect(dashboard).toContain('const translatorRef = useRef(t);');
    expect(dashboard).toContain('}, [deriveAddresses, summary]);');
    expect(dashboard).not.toContain('}, [deriveAddresses, summary, t]);');
  });

  it('contains the same complete key and placeholder set in every language', () => {
    const languages = WALLET_LANGUAGES.map(({ code }) => code);
    const referenceKeys = Object.keys(MESSAGES.en).sort();

    for (const language of languages) {
      expect(Object.keys(MESSAGES[language]).sort()).toEqual(referenceKeys);
      for (const key of referenceKeys) {
        const translation = MESSAGES[language][key as keyof typeof MESSAGES.en];
        expect(translation.trim(), `${language}:${key}`).not.toBe('');
        expect(placeholders(translation), `${language}:${key}`).toEqual(
          placeholders(MESSAGES.en[key as keyof typeof MESSAGES.en]),
        );
      }
    }
  });

  it('localizes every send code and never exposes an unknown raw error', () => {
    for (const { code: language } of WALLET_LANGUAGES) {
      const t = (key: keyof typeof MESSAGES.en) =>
        translateCatalogMessage(language, key);
      for (const code of TRANSLATED_SEND_ERROR_CODES) {
        const localized = translateWalletError({ code }, t);
        expect(localized.length, `${language}:${code}`).toBeGreaterThan(0);
        expect(localized).not.toContain(code);
      }
      const sentinel = 'RAW_SERVER_ERROR_MUST_NOT_LEAK';
      expect(translateWalletError(new Error(sentinel), t)).not.toContain(
        sentinel,
      );
      expect(translateNetworkError('NETWORK_SYNC_FAILED', t)).not.toContain(
        'NETWORK_SYNC_FAILED',
      );
    }
  });

  it('keeps visible JSX and accessibility labels behind the translation layer', () => {
    const files = [
      'app/page.tsx',
      'app/wallet-access-workspace.tsx',
      'app/wallet-dashboard.tsx',
      'app/crypto-core-status.tsx',
      'components/recovery-phrase-copy.tsx',
      'components/wallet-language-select.tsx',
    ];
    const allowedBrandText = new Set(['NITO', 'Web Wallet']);

    for (const file of files) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const rawVisibleText: string[] = [];
      const rawAccessibilityLabels: string[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) {
          const text = node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
          if (text && !allowedBrandText.has(text)) rawVisibleText.push(text);
        }
        if (
          ts.isJsxAttribute(node) &&
          ['aria-label', 'placeholder', 'title'].includes(
            node.name.getText(sourceFile),
          ) &&
          node.initializer &&
          ts.isStringLiteral(node.initializer)
        ) {
          rawAccessibilityLabels.push(node.initializer.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      expect(rawVisibleText, file).toEqual([]);
      expect(rawAccessibilityLabels, file).toEqual([]);
      expect(source, file).not.toMatch(/(?:caught|error)\.message/u);
      expect(source, file).not.toContain('errorMessage');
    }
  });

  it('exposes the translated official repository as a secure external link', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/page.tsx'), 'utf8');

    expect(source).toContain("t('footer.officialRepository')");
    expect(source).toContain(
      'href="https://github.com/NitoNetwork/nito-web-wallet"',
    );
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
  });

  it('keeps translated source tabs inside narrow mobile grid columns', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/wallet-access-workspace.tsx'),
      'utf8',
    );

    expect(source).toContain('group/source flex min-h-16 min-w-0');
    expect(source).toContain('<span className="min-w-0 break-words">');
  });

  it('keeps information tooltips inside the visible viewport', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/info-tip.tsx'),
      'utf8',
    );

    expect(source).toContain('document.documentElement.clientWidth');
    expect(source).toContain('TOOLTIP_VIEWPORT_MARGIN');
    expect(source).toContain('className={`fixed z-50');
    expect(source).not.toContain('right-[-2rem]');
  });

  it('gives every icon-only narrow-screen tab an accessible name', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/wallet-dashboard.tsx'),
      'utf8',
    );

    expect(source).toContain('aria-label={label}');
  });

  it('does not keep orphaned translations outside the locale files', () => {
    const sourceFiles = [
      'app/page.tsx',
      'app/wallet-access-workspace.tsx',
      'app/wallet-dashboard.tsx',
      'app/crypto-core-status.tsx',
      'components/recovery-phrase-copy.tsx',
      'components/wallet-language-select.tsx',
      'src/i18nError.ts',
    ];
    const source = sourceFiles
      .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
      .join('\n');
    const orphaned = Object.keys(MESSAGES.en).filter(
      (key) => !source.includes(`'${key}'`) && !source.includes(`"${key}"`),
    );

    expect(orphaned).toEqual([]);
  });
});
