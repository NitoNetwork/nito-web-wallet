import {
  deriveEmailCredentialMnemonic,
  normalizeEmail,
  normalizeEmailPassword,
} from '../compat/email-credentials';
import { HD_ACCOUNT_TEMPLATES, deriveHdPath } from '../domain/wallet-policy';
import {
  createPasswordSecretVault,
  createRandomSecretVault,
  decryptPasswordSecretVault,
  decryptSecretVault,
  destroySecretVault,
  type SecretVault,
} from './secretVault';
import { NitoCryptoError, NitoWasmCrypto, instantiateNitoWasmCrypto } from './wasmAbi';
import type {
  CryptoWorkerCapabilities,
  CryptoWorkerCommand,
  CryptoWorkerRequest,
  CryptoWorkerResponse,
  DerivedAddress,
  PrivateKeyInfo,
  WalletSessionSummary,
} from './workerProtocol';

type CryptoWorkerScope = {
  readonly location: Location;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: CryptoWorkerResponse): void;
  close(): void;
};

type ActiveSession =
  | {
      id: string;
      source: 'bip39-hd';
      secretVault: SecretVault;
      wordCount: 12 | 24;
      createdAt: string;
      primaryAddresses: DerivedAddress[];
    }
  | {
      id: string;
      source: 'email-credentials';
      secretVault: SecretVault;
      wordCount: 12 | 24;
      email: string;
      createdAt: string;
      primaryAddresses: DerivedAddress[];
    }
  | {
      id: string;
      source: 'single-private-key';
      secretVault: SecretVault;
      compressed: boolean;
      createdAt: string;
      primaryAddresses: PrivateKeyInfo['addresses'];
    };

const workerScope = globalThis as unknown as CryptoWorkerScope;
const WASM_URL = new URL('/wasm/nito_wallet_crypto_web.wasm', workerScope.location.origin);
const CAPABILITIES: CryptoWorkerCapabilities = {
  abiVersion: 1,
  transparentOnly: true,
  sources: ['bip39-hd', 'single-private-key', 'email-credentials'],
  scriptTypes: ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'],
  maxDerivationIndex: 9_999,
};

let cryptoPromise: Promise<NitoWasmCrypto> | undefined;
let activeSession: ActiveSession | undefined;

const BIP39_VAULT_CONTEXT = 'nito-wallet-web:bip39-session:v1';
const PRIVATE_KEY_VAULT_CONTEXT = 'nito-wallet-web:private-key-session:v1';
const emailVaultContext = (email: string) =>
  `nito-wallet-web:email-session:v1:${email}`;

async function loadCrypto(): Promise<NitoWasmCrypto> {
  cryptoPromise ??= (async () => {
    const response = await fetch(WASM_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok) {
      throw new NitoCryptoError(
        'WASM_LOAD_FAILED',
        `The cryptographic core could not be loaded (${response.status}).`,
      );
    }
    const bytes = await response.arrayBuffer();
    return instantiateNitoWasmCrypto(bytes);
  })();
  return cryptoPromise;
}

function clearSession(): void {
  if (!activeSession) return;
  destroySecretVault(activeSession.secretVault);
  if ('email' in activeSession) activeSession.email = '';
  activeSession = undefined;
}

function assertSession(sessionId: string): ActiveSession {
  if (!activeSession || activeSession.id !== sessionId) {
    throw new NitoCryptoError('SESSION_LOCKED', 'The wallet session is locked or expired.');
  }
  return activeSession;
}

function normalizeMnemonic(input: string): { mnemonic: string; wordCount: 12 | 24 } {
  const mnemonic = input.trim().toLowerCase().split(/\s+/u).join(' ');
  const count = mnemonic ? mnemonic.split(' ').length : 0;
  if (count !== 12 && count !== 24) {
    throw new NitoCryptoError('INVALID_MNEMONIC', 'A BIP39 phrase must contain 12 or 24 words.');
  }
  return { mnemonic, wordCount: count };
}

function primaryHdRequests() {
  return HD_ACCOUNT_TEMPLATES.map((account) => ({
    path: deriveHdPath(account, 'external', 0),
    scriptType: account.scriptType,
  }));
}

async function openHdSession(
  mnemonicInput: string,
  source: 'bip39-hd' | 'email-credentials',
  createdAt = new Date().toISOString(),
  email?: string,
  emailPassword?: string,
): Promise<WalletSessionSummary> {
  const crypto = await loadCrypto();
  const { mnemonic, wordCount } = normalizeMnemonic(mnemonicInput);
  const primaryAddresses = crypto.invoke<DerivedAddress[]>('deriveAddresses', {
    mnemonic,
    requests: primaryHdRequests(),
  });
  clearSession();
  const id = cryptoRandomId();
  if (source === 'email-credentials') {
    if (!email || emailPassword === undefined) {
      throw new NitoCryptoError('EMAIL_REQUIRED', 'Wallet email is unavailable.');
    }
    const normalizedEmail = normalizeEmail(email);
    const secretVault = await createPasswordSecretVault(
      mnemonic,
      normalizeEmailPassword(emailPassword),
      normalizedEmail,
      emailVaultContext(normalizedEmail),
    );
    activeSession = {
      id,
      source,
      secretVault,
      wordCount,
      email: normalizedEmail,
      createdAt,
      primaryAddresses,
    };
  } else {
    const secretVault = await createRandomSecretVault(mnemonic, BIP39_VAULT_CONTEXT);
    activeSession = {
      id,
      source,
      secretVault,
      wordCount,
      createdAt,
      primaryAddresses,
    };
  }
  return { sessionId: id, source, hd: true, wordCount, primaryAddresses };
}

async function openPrivateKeySession(
  privateKey: string,
  createdAt = new Date().toISOString(),
): Promise<WalletSessionSummary> {
  const crypto = await loadCrypto();
  const info = crypto.invoke<PrivateKeyInfo>('inspectPrivateKey', { privateKey });
  clearSession();
  const id = cryptoRandomId();
  const secretVault = await createRandomSecretVault(privateKey, PRIVATE_KEY_VAULT_CONTEXT);
  activeSession = {
    id,
    source: 'single-private-key',
    secretVault,
    compressed: info.compressed,
    createdAt,
    primaryAddresses: info.addresses,
  };
  return {
    sessionId: id,
    source: 'single-private-key',
    hd: false,
    compressed: info.compressed,
    primaryAddresses: info.addresses,
  };
}

function cryptoRandomId(): string {
  if (typeof crypto.randomUUID !== 'function') {
    throw new NitoCryptoError('ENTROPY_UNAVAILABLE', 'Secure session identifiers are unavailable.');
  }
  return crypto.randomUUID();
}

async function execute(command: CryptoWorkerCommand): Promise<unknown> {
  const crypto = await loadCrypto();
  switch (command.type) {
    case 'health':
      return CAPABILITIES;
    case 'createMnemonic': {
      const generated = crypto.invoke<{ mnemonic: string }>('generateMnemonic', {
        wordCount: command.wordCount,
        ...(command.diceEntropyBase64
          ? { additionalEntropyBase64: command.diceEntropyBase64 }
          : {}),
      });
      const summary = await openHdSession(generated.mnemonic, 'bip39-hd');
      return { ...summary, mnemonic: generated.mnemonic };
    }
    case 'importMnemonic':
      return openHdSession(command.mnemonic, 'bip39-hd');
    case 'importEmailCredentials': {
      const mnemonic = await deriveEmailCredentialMnemonic(command.email, command.password);
      return openHdSession(
        mnemonic,
        'email-credentials',
        new Date().toISOString(),
        command.email,
        command.password,
      );
    }
    case 'importPrivateKey': {
      return openPrivateKeySession(command.privateKey);
    }
    case 'verifyMnemonicBackup': {
      const session = assertSession(command.sessionId);
      if (session.source !== 'bip39-hd') {
        throw new NitoCryptoError(
          'MNEMONIC_BACKUP_UNAVAILABLE',
          'Backup verification is unavailable for this wallet source.',
        );
      }
      if (
        command.answers.length !== 3 ||
        new Set(command.answers.map(({ wordIndex }) => wordIndex)).size !== 3 ||
        command.answers.some(
          ({ wordIndex, word }) =>
            !Number.isSafeInteger(wordIndex) ||
            wordIndex < 0 ||
            wordIndex >= session.wordCount ||
            word.trim() === '',
        )
      ) {
        throw new NitoCryptoError(
          'INVALID_BACKUP_VERIFICATION',
          'Backup verification answers are incomplete or invalid.',
        );
      }
      let mnemonic = await decryptSecretVault(session.secretVault);
      try {
        const words = mnemonic.split(' ');
        const valid = command.answers.every(
          ({ wordIndex, word }) => words[wordIndex] === word.trim().toLowerCase(),
        );
        return { valid };
      } finally {
        mnemonic = '';
      }
    }
    case 'deriveAddresses': {
      const session = assertSession(command.sessionId);
      if (session.source === 'single-private-key') {
        throw new NitoCryptoError(
          'NOT_HD_WALLET',
          'A single private key has no deterministic derivation branches.',
        );
      }
      let mnemonic = await decryptSecretVault(session.secretVault);
      try {
        return crypto.invoke<DerivedAddress[]>('deriveAddresses', {
          mnemonic,
          requests: command.requests,
        });
      } finally {
        mnemonic = '';
      }
    }
    case 'signPsbt': {
      const session = assertSession(command.sessionId);
      let secret = await decryptSecretVault(session.secretVault);
      try {
        if (session.source !== 'single-private-key') {
          return crypto.invoke('signPsbt', {
            mnemonic: secret,
            psbtBase64: command.psbtBase64,
            signers: command.signers,
          });
        }
        return crypto.invoke('signPsbtWithPrivateKey', {
          privateKey: secret,
          psbtBase64: command.psbtBase64,
          signers: command.signers,
        });
      } finally {
        secret = '';
      }
    }
    case 'revealMnemonic': {
      const session = assertSession(command.sessionId);
      if (session.source === 'single-private-key') {
        throw new NitoCryptoError(
          'MNEMONIC_UNAVAILABLE',
          'This wallet session has no recovery phrase available for reveal.',
        );
      }
      if (session.source === 'email-credentials') {
        if (!command.password) {
          throw new NitoCryptoError(
            'EMAIL_REAUTHENTICATION_FAILED',
            'Incorrect password.',
          );
        }
        try {
          const mnemonic = await decryptPasswordSecretVault(
            session.secretVault,
            normalizeEmailPassword(command.password),
            session.email,
          );
          return { mnemonic, wordCount: session.wordCount };
        } catch {
          throw new NitoCryptoError(
            'EMAIL_REAUTHENTICATION_FAILED',
            'Incorrect password.',
          );
        }
      }
      const mnemonic = await decryptSecretVault(session.secretVault);
      return { mnemonic, wordCount: session.wordCount };
    }
  }
}

function wipeCommandSecrets(command: CryptoWorkerCommand): void {
  switch (command.type) {
    case 'importMnemonic':
      command.mnemonic = '';
      break;
    case 'importPrivateKey':
      command.privateKey = '';
      break;
    case 'importEmailCredentials':
      command.email = '';
      command.password = '';
      break;
    case 'createMnemonic':
      command.diceEntropyBase64 = undefined;
      break;
    case 'signPsbt':
      command.psbtBase64 = '';
      break;
    case 'revealMnemonic':
      command.password = '';
      break;
    case 'verifyMnemonicBackup':
      for (const answer of command.answers) answer.word = '';
      command.answers.length = 0;
      break;
    default:
      break;
  }
}

function wipeResultSecrets(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const candidate = result as { mnemonic?: unknown };
  if (typeof candidate.mnemonic === 'string') candidate.mnemonic = '';
}

workerScope.addEventListener('message', (event) => {
  const request = event.data as Partial<CryptoWorkerRequest>;
  if (!request || typeof request.id !== 'string' || !request.command) return;
  const command = request.command;
  void execute(command)
    .then((result) => {
      workerScope.postMessage({ id: request.id!, ok: true, result });
      wipeResultSecrets(result);
    })
    .catch((error: unknown) => {
      const code = error instanceof NitoCryptoError ? error.code : 'CRYPTO_WORKER_ERROR';
      const message = error instanceof Error ? error.message : 'Cryptographic operation failed.';
      workerScope.postMessage({ id: request.id!, ok: false, error: { code, message } });
    })
    .finally(() => wipeCommandSecrets(command));
});
