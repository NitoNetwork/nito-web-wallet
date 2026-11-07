'use client';

import {
  forwardRef,
  type ComponentPropsWithoutRef,
  useCallback,
  useEffect,
  useRef,
} from 'react';

import { useI18n, type Translator } from '@/src/i18n';

type ConstraintValidationState = Pick<
  ValidityState,
  | 'badInput'
  | 'patternMismatch'
  | 'rangeOverflow'
  | 'rangeUnderflow'
  | 'stepMismatch'
  | 'tooLong'
  | 'tooShort'
  | 'typeMismatch'
  | 'valid'
  | 'valueMissing'
>;

type ConstraintValidationDetails = {
  inputType?: string;
  max?: string;
  maxLength?: number;
  min?: string;
  minLength?: number;
};

type ConstraintControl =
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement;
type FormInputCapture = NonNullable<
  ComponentPropsWithoutRef<'form'>['onInputCapture']
>;
type FormInvalidCapture = NonNullable<
  ComponentPropsWithoutRef<'form'>['onInvalidCapture']
>;

export function localizedConstraintMessage(
  validity: ConstraintValidationState,
  details: ConstraintValidationDetails,
  t: Translator,
): string {
  if (validity.valid) return '';
  if (validity.valueMissing) return t('validation.required');
  if (validity.typeMismatch && details.inputType === 'email')
    return t('validation.email');
  if (validity.tooShort)
    return t('validation.tooShort', { min: details.minLength ?? 0 });
  if (validity.tooLong)
    return t('validation.tooLong', { max: details.maxLength ?? 0 });
  if (validity.rangeUnderflow)
    return t('validation.rangeUnderflow', { min: details.min ?? '' });
  if (validity.rangeOverflow)
    return t('validation.rangeOverflow', { max: details.max ?? '' });
  if (validity.badInput || validity.stepMismatch) return t('validation.number');
  return t('validation.invalid');
}

function isConstraintControl(target: EventTarget): target is ConstraintControl {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

function validationDetails(
  control: ConstraintControl,
): ConstraintValidationDetails {
  if (control instanceof HTMLSelectElement) return {};
  return {
    inputType: control instanceof HTMLInputElement ? control.type : 'textarea',
    max: control instanceof HTMLInputElement ? control.max : undefined,
    maxLength: control.maxLength,
    min: control instanceof HTMLInputElement ? control.min : undefined,
    minLength: control.minLength,
  };
}

export const LocalizedForm = forwardRef<
  HTMLFormElement,
  ComponentPropsWithoutRef<'form'>
>(function LocalizedForm({ onInputCapture, onInvalidCapture, ...props }, ref) {
  const { t } = useI18n();
  const formRef = useRef<HTMLFormElement | null>(null);
  const attachForm = useCallback(
    (element: HTMLFormElement | null) => {
      formRef.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    for (const control of form.querySelectorAll('input, select, textarea')) {
      if (isConstraintControl(control)) control.setCustomValidity('');
    }
  });

  const clearLocalizedMessage: FormInputCapture = (event) => {
    const control = event.target;
    if (isConstraintControl(control)) control.setCustomValidity('');
    onInputCapture?.(event);
  };

  const localizeInvalidMessage: FormInvalidCapture = (event) => {
    const control = event.target;
    if (isConstraintControl(control)) {
      control.setCustomValidity('');
      const message = localizedConstraintMessage(
        control.validity,
        validationDetails(control),
        t,
      );
      if (message) control.setCustomValidity(message);
    }
    onInvalidCapture?.(event);
  };

  return (
    <form
      {...props}
      ref={attachForm}
      onInputCapture={clearLocalizedMessage}
      onInvalidCapture={localizeInvalidMessage}
    />
  );
});
