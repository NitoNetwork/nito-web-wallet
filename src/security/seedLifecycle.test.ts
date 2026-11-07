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
const dashboardSource = readFileSync(
  resolve(process.cwd(), 'app/wallet-dashboard.tsx'),
  'utf8',
);
const protocolSource = readFileSync(
  resolve(process.cwd(), 'src/crypto/workerProtocol.ts'),
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

  it('reports recovery-phrase display as a sensitive background state', () => {
    expect(dashboardSource).toContain(
      'onSensitiveRevealChange(Boolean(revealedMnemonic))',
    );
    expect(dashboardSource).toContain(
      '() => () => onSensitiveRevealChange(false)',
    );
    expect(accessSource).toContain('lockWhenDisabled: isSensitiveSession');
  });

  it('keeps email and imported wallet authority in encrypted Worker vaults', () => {
    expect(workerSource).toContain('createPasswordSecretVault(');
    expect(workerSource).toContain('createRandomSecretVault(');
    expect(workerSource).not.toMatch(
      /source: 'email-credentials';\s+mnemonic:/u,
    );
    expect(workerSource).not.toMatch(
      /source: 'single-private-key';\s+privateKey:/u,
    );
  });

  it('keeps the optional BIP39 passphrase inside the ephemeral Worker vault only', () => {
    const pendingCreationType = accessSource.slice(
      accessSource.indexOf('type PendingCreation'),
      accessSource.indexOf('function formField'),
    );
    const sessionSummaryType = protocolSource.slice(
      protocolSource.indexOf('export type WalletSessionSummary'),
      protocolSource.indexOf('export type CryptoWorkerCapabilities'),
    );
    expect(pendingCreationType).toContain('usesBip39Passphrase: boolean');
    expect(pendingCreationType).not.toMatch(/\bbip39Passphrase:\s*string/u);
    expect(sessionSummaryType).not.toContain('bip39Passphrase');
    expect(workerSource).toContain('encodeBip39SessionSecret(');
    expect(workerSource).toContain('decodeBip39SessionSecret(');
    expect(workerSource).toContain('wipeBip39SessionSecret(secret)');
    expect(workerSource).toContain('bip39-session:v2');
    expect(workerSource).not.toMatch(/source: 'bip39-hd';\s+bip39Passphrase:/u);
  });

  it('reads passphrases from uncontrolled fields and clears them across every exit path', () => {
    expect(accessSource).toContain(
      'formField<HTMLInputElement>(\n      form,\n      BIP39_PASSPHRASE_FIELD',
    );
    expect(accessSource).not.toMatch(
      /useState(?:<[^>]+>)?\([^)]*bip39Passphrase/iu,
    );
    expect(accessSource).toContain(
      "window.addEventListener('pagehide', clearBip39PassphraseFields)",
    );
    expect(accessSource).toContain(
      "document.addEventListener('visibilitychange', clearWhenHidden)",
    );
    expect(accessSource).toContain(
      'clearBip39PassphraseFields();\n                        setBip39Mode(mode);',
    );
    expect(accessSource).toContain('if (!event.currentTarget.open)');
    expect(accessSource).toContain("t('backup.bip39PassphraseSaved')");
    expect(accessSource).toContain(
      'const creationRequest = clientRef.current.request(',
    );
    expect(accessSource).toContain(
      'const importRequest = clientRef.current.request(',
    );
  });

  it('never returns a BIP39 passphrase from the Worker', () => {
    const revealCase = workerSource.slice(
      workerSource.indexOf("case 'revealMnemonic'"),
      workerSource.indexOf('function wipeCommandSecrets'),
    );
    expect(revealCase).toContain(
      'return { mnemonic: secret.mnemonic, wordCount: session.wordCount };',
    );
    expect(revealCase).not.toMatch(/return\s*\{[^}]*bip39Passphrase/iu);
  });
});
