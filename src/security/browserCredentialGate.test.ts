import { describe, expect, it, vi } from 'vitest';

import {
  clearAndDisableBrowserCredentialFields,
  enableBrowserCredentialFields,
} from './browserCredentialGate';

const field = () => ({
  autocomplete: 'username',
  defaultValue: 'saved',
  readOnly: false,
  removeAttribute: vi.fn(),
  value: 'saved',
});

describe('browser credential gate', () => {
  it('starts empty and unavailable to automatic filling', () => {
    const form = { autocomplete: 'on', reset: vi.fn() };
    const email = field();
    const password = field();

    clearAndDisableBrowserCredentialFields(form, email, password);

    expect(form.reset).toHaveBeenCalledOnce();
    expect(form.autocomplete).toBe('off');
    for (const input of [email, password]) {
      expect(input.value).toBe('');
      expect(input.defaultValue).toBe('');
      expect(input.readOnly).toBe(true);
      expect(input.autocomplete).toBe('off');
      expect(input.removeAttribute).toHaveBeenCalledWith('value');
    }
  });

  it('enables both standard fields together after a deliberate gesture', () => {
    const form = { autocomplete: 'off', reset: vi.fn() };
    const email = field();
    const password = field();
    email.readOnly = true;
    password.readOnly = true;

    enableBrowserCredentialFields(form, email, password);

    expect(form.autocomplete).toBe('on');
    expect(email).toMatchObject({ readOnly: false, autocomplete: 'username' });
    expect(password).toMatchObject({
      readOnly: false,
      autocomplete: 'current-password',
    });
  });
});
