import { describe, expect, it } from 'vitest';

import { localizedConstraintMessage } from '@/components/localized-form';
import type { Translator } from './i18n';
import { MESSAGES, translateCatalogMessage } from './i18nMessages';

type TestValidity = Parameters<typeof localizedConstraintMessage>[0];

const validity = (overrides: Partial<TestValidity>): TestValidity => ({
  badInput: false,
  patternMismatch: false,
  rangeOverflow: false,
  rangeUnderflow: false,
  stepMismatch: false,
  tooLong: false,
  tooShort: false,
  typeMismatch: false,
  valid: false,
  valueMissing: false,
  ...overrides,
});

const english: Translator = (key, variables) =>
  translateCatalogMessage('en', key, variables);

describe('localized constraint validation', () => {
  it('selects a translated message for every browser constraint in use', () => {
    expect(
      localizedConstraintMessage(validity({ valueMissing: true }), {}, english),
    ).toBe(MESSAGES.en['validation.required']);
    expect(
      localizedConstraintMessage(
        validity({ typeMismatch: true }),
        { inputType: 'email' },
        english,
      ),
    ).toBe(MESSAGES.en['validation.email']);
    expect(
      localizedConstraintMessage(
        validity({ tooShort: true }),
        { minLength: 8 },
        english,
      ),
    ).toBe('Use at least 8 characters.');
    expect(
      localizedConstraintMessage(
        validity({ tooLong: true }),
        { maxLength: 64 },
        english,
      ),
    ).toBe('Use no more than 64 characters.');
    expect(
      localizedConstraintMessage(
        validity({ rangeUnderflow: true }),
        { min: '1' },
        english,
      ),
    ).toBe('Enter a value of at least 1.');
    expect(
      localizedConstraintMessage(
        validity({ rangeOverflow: true }),
        { max: '9999' },
        english,
      ),
    ).toBe('Enter a value no greater than 9999.');
    expect(
      localizedConstraintMessage(validity({ badInput: true }), {}, english),
    ).toBe(MESSAGES.en['validation.number']);
    expect(
      localizedConstraintMessage(validity({ stepMismatch: true }), {}, english),
    ).toBe(MESSAGES.en['validation.number']);
    expect(
      localizedConstraintMessage(
        validity({ patternMismatch: true }),
        {},
        english,
      ),
    ).toBe(MESSAGES.en['validation.invalid']);
    expect(
      localizedConstraintMessage(validity({ valid: true }), {}, english),
    ).toBe('');
  });

  it('uses the selected wallet language rather than the browser language', () => {
    for (const language of Object.keys(MESSAGES) as (keyof typeof MESSAGES)[]) {
      const t: Translator = (key, variables) =>
        translateCatalogMessage(language, key, variables);
      expect(
        localizedConstraintMessage(validity({ valueMissing: true }), {}, t),
      ).toBe(MESSAGES[language]['validation.required']);
      expect(
        localizedConstraintMessage(
          validity({ rangeOverflow: true }),
          { max: '10000' },
          t,
        ),
      ).toBe(
        MESSAGES[language]['validation.rangeOverflow'].replace(
          '{max}',
          '10000',
        ),
      );
    }
  });
});
