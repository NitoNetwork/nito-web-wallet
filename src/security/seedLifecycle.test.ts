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

describe('seed lifecycle policy', () => {
  it('makes generated-phrase verification one-way and Worker-validated', () => {
    expect(accessSource).toContain("type: 'verifyMnemonicBackup'");
    expect(accessSource).not.toContain("t('backup.backToPhrase')");
    expect(accessSource).toContain('const { mnemonic, ...summary } = created;');
    expect(accessSource).toContain("created.mnemonic = '';");
    expect(accessSource).toContain('summary: pendingCreation.summary');
    expect(accessSource).toContain('wordIndexes: pendingCreation.wordIndexes');
  });

  it('destroys creation sessions when the page or window is left', () => {
    expect(accessSource).toContain('if (!activeWallet && !pendingCreation) return;');
    expect(accessSource).toContain("window.addEventListener('pagehide', destroySensitivePage)");
    expect(accessSource).toContain("window.addEventListener('pageshow', restoreFromPageCache)");
    expect(accessSource).toContain("window.addEventListener('blur', blurPendingBackup)");
  });

  it('keeps email and imported wallet authority in encrypted Worker vaults', () => {
    expect(workerSource).toContain('createPasswordSecretVault(');
    expect(workerSource).toContain('createRandomSecretVault(');
    expect(workerSource).not.toMatch(/source: 'email-credentials';\s+mnemonic:/u);
    expect(workerSource).not.toMatch(/source: 'single-private-key';\s+privateKey:/u);
  });
});
