import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const accessSource = readFileSync(
  resolve(process.cwd(), 'app/wallet-access-workspace.tsx'),
  'utf8',
);
const workerSource = readFileSync(
  resolve(process.cwd(), 'src/crypto/crypto.worker.ts'),
  'utf8',
);

describe('credential persistence policy', () => {
  it('never restores email credentials from wallet-managed browser storage', () => {
    expect(accessSource).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
  });

  it('opens browser-managed filling only after deliberate field interaction', () => {
    expect(accessSource).toContain("const EMAIL_FIELD = 'username';");
    expect(accessSource).toContain("const PASSWORD_FIELD = 'password';");
    expect(accessSource).toContain("emailCredentialsEnabled ? 'on' : 'off'");
    expect(accessSource).toContain(
      "emailCredentialsEnabled ? 'username' : 'off'",
    );
    expect(accessSource).toContain(
      "emailCredentialsEnabled ? 'current-password' : 'off'",
    );
    expect(accessSource).toContain('readOnly={!emailCredentialsEnabled}');
    expect(accessSource).toContain(
      'onPointerDown={enableEmailCredentialFields}',
    );
    expect(accessSource).toContain('onFocus={enableEmailCredentialFields}');
    expect(accessSource).toContain('setEmailCredentialsEnabled(false)');
    expect(accessSource).not.toContain('data-1p-ignore="true"');
    expect(accessSource).not.toContain('data-lpignore="true"');
    expect(accessSource).toContain(
      "window.addEventListener('pagehide', clearEmailCredentialFields)",
    );
  });

  it('never persists or logs a BIP39 passphrase outside the Worker session', () => {
    for (const source of [accessSource, workerSource]) {
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
      expect(source).not.toMatch(/console\.(?:log|info|warn|error)/u);
    }
    expect(accessSource).toContain('autoComplete="off"');
    expect(accessSource).toContain('autoCapitalize="none"');
    expect(accessSource).toContain('autoCorrect="off"');
    expect(accessSource).toContain('spellCheck={false}');
  });
});
