import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { ja } from './locales/ja';
import { pt } from './locales/pt';
import { ru } from './locales/ru';
import { tr } from './locales/tr';
import { zh } from './locales/zh';

export const MESSAGES = { en, zh, de, es, fr, ja, tr, pt, ru } as const;

export type { TranslationKey } from './locales/en';

export function translateCatalogMessage(
  language: keyof typeof MESSAGES,
  key: keyof typeof en,
  variables: Record<string, string | number> = {},
): string {
  let text: string = MESSAGES[language][key];
  for (const [name, replacement] of Object.entries(variables)) {
    text = text.replaceAll(`{${name}}`, String(replacement));
  }
  return text;
}
