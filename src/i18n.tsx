'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import { translateCatalogMessage, type TranslationKey } from './i18nMessages';

export const WALLET_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'ja', label: '日本語' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
] as const;

export type LanguageCode = (typeof WALLET_LANGUAGES)[number]['code'];
export type { TranslationKey } from './i18nMessages';
export type TranslationVariables = Record<string, string | number>;
export type Translator = (
  key: TranslationKey,
  variables?: TranslationVariables,
) => string;

export function detectBrowserLanguage(
  languages: readonly string[] = [],
): LanguageCode {
  for (const locale of languages) {
    const primary = locale.toLowerCase().split('-')[0];
    if (WALLET_LANGUAGES.some(({ code }) => code === primary))
      return primary as LanguageCode;
  }
  return 'en';
}

type I18nContextValue = {
  language: LanguageCode;
  setLanguage: (language: LanguageCode) => void;
  t: Translator;
};

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

const subscribeToBrowserLanguage = (listener: () => void) => {
  window.addEventListener('languagechange', listener);
  return () => window.removeEventListener('languagechange', listener);
};

const browserLanguageSnapshot = () =>
  detectBrowserLanguage(
    navigator.languages.length ? navigator.languages : [navigator.language],
  );

const serverLanguageSnapshot = (): LanguageCode => 'en';

export function LanguageProvider({ children }: { children: ReactNode }) {
  const browserLanguage = useSyncExternalStore(
    subscribeToBrowserLanguage,
    browserLanguageSnapshot,
    serverLanguageSnapshot,
  );
  const [manualLanguage, setManualLanguage] = useState<LanguageCode>();
  const language = manualLanguage ?? browserLanguage;

  const selectLanguage = useCallback(
    (nextLanguage: LanguageCode) => setManualLanguage(nextLanguage),
    [],
  );
  const translate = useCallback<Translator>(
    (key, variables) => translateCatalogMessage(language, key, variables),
    [language],
  );

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage: selectLanguage,
      t: translate,
    }),
    [language, selectLanguage, translate],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside LanguageProvider.');
  return value;
}
