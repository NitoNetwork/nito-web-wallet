type CredentialField = {
  autocomplete: string;
  defaultValue: string;
  readOnly: boolean;
  removeAttribute(name: string): void;
  value: string;
};

type CredentialForm = {
  autocomplete: string;
  reset(): void;
};

export function clearAndDisableBrowserCredentialFields(
  form: CredentialForm,
  email: CredentialField,
  password: CredentialField,
) {
  form.reset();
  form.autocomplete = 'off';
  for (const field of [email, password]) {
    field.value = '';
    field.defaultValue = '';
    field.removeAttribute('value');
    field.readOnly = true;
    field.autocomplete = 'off';
  }
}

export function enableBrowserCredentialFields(
  form: CredentialForm,
  email: CredentialField,
  password: CredentialField,
) {
  form.autocomplete = 'on';
  email.readOnly = false;
  email.autocomplete = 'username';
  password.readOnly = false;
  password.autocomplete = 'current-password';
}
