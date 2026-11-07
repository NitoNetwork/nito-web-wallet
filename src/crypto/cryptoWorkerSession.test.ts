import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CryptoWorkerCommand, CryptoWorkerResponse } from './workerProtocol';

const wasm = vi.hoisted(() => ({
  invocations: [] as Array<{ operation: string; input: Record<string, unknown> }>,
  invoke: vi.fn(),
}));

vi.mock('./wasmAbi', async () => {
  const actual = await vi.importActual<typeof import('./wasmAbi')>('./wasmAbi');
  return {
    ...actual,
    instantiateNitoWasmCrypto: vi.fn(async () => ({ invoke: wasm.invoke })),
  };
});

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const GENERATED_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

type WorkerMessageListener = (event: MessageEvent<unknown>) => void;

function derivedAddress(
  request: { path: string; scriptType: string },
  identity: string,
) {
  return {
    ...request,
    address: `${identity}:${request.path}`,
    publicKeyHex: '02'.padEnd(66, '1'),
    scriptHex: '0014'.padEnd(44, '2'),
  };
}

describe('crypto Worker BIP39 passphrase session', () => {
  let messageListener: WorkerMessageListener;
  let responseResolvers: Map<
    string,
    (response: CryptoWorkerResponse) => void
  >;
  let sequence: number;

  beforeEach(async () => {
    vi.resetModules();
    wasm.invocations.length = 0;
    wasm.invoke.mockReset();
    wasm.invoke.mockImplementation(
      (operation: string, input: Record<string, unknown>) => {
        wasm.invocations.push({ operation, input: structuredClone(input) });
        if (operation === 'generateMnemonic') {
          return { mnemonic: GENERATED_MNEMONIC };
        }
        if (operation === 'deriveAddresses') {
          const mnemonic =
            typeof input.mnemonic === 'string' ? input.mnemonic : '';
          const bip39Passphrase =
            typeof input.bip39Passphrase === 'string'
              ? input.bip39Passphrase
              : '';
          const identity = `wallet-${mnemonic.length}-${bip39Passphrase.length}`;
          return (
            input.requests as Array<{ path: string; scriptType: string }>
          ).map((request) => derivedAddress(request, identity));
        }
        if (operation === 'signPsbt') {
          return { psbtBase64: 'signed' };
        }
        if (operation === 'inspectPrivateKey') {
          return {
            format: 'hex',
            compressed: true,
            addresses: [
              {
                scriptType: 'p2wpkh',
                address: 'nito1qprivate',
                publicKeyHex: '02'.padEnd(66, '3'),
                scriptHex: '0014'.padEnd(44, '4'),
                publicKeyCompressed: true,
              },
            ],
          };
        }
        if (operation === 'signPsbtWithPrivateKey') {
          return { psbtBase64: 'single-key-signed' };
        }
        throw new Error(`Unexpected WASM operation: ${operation}`);
      },
    );

    responseResolvers = new Map();
    sequence = 0;
    vi.stubGlobal('location', { origin: 'https://wallet.nito.network' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0]))),
    );
    vi.stubGlobal(
      'addEventListener',
      vi.fn((type: string, listener: WorkerMessageListener) => {
        if (type === 'message') messageListener = listener;
      }),
    );
    vi.stubGlobal(
      'postMessage',
      vi.fn((response: CryptoWorkerResponse) => {
        const cloned = structuredClone(response);
        responseResolvers.get(cloned.id)?.(cloned);
        responseResolvers.delete(cloned.id);
      }),
    );
    vi.stubGlobal('close', vi.fn());

    await import('./crypto.worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function request(command: CryptoWorkerCommand): Promise<CryptoWorkerResponse> {
    const id = `request-${sequence++}`;
    const response = new Promise<CryptoWorkerResponse>((resolve) => {
      responseResolvers.set(id, resolve);
    });
    messageListener({ data: { id, command } } as MessageEvent<unknown>);
    return response;
  }

  it('binds the normalized secret to the session without exposing it', async () => {
    const imported = await request({
      type: 'importMnemonic',
      mnemonic: MNEMONIC,
      bip39Passphrase: '\u00e9 Secret ',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error(imported.error.message);
    const importedSummary = imported.result as { sessionId: string };
    expect(JSON.stringify(imported.result)).not.toContain('Secret');
    expect(JSON.stringify(imported.result)).not.toContain(MNEMONIC);

    const initialDerivation = wasm.invocations.find(
      ({ operation }) => operation === 'deriveAddresses',
    );
    expect(initialDerivation?.input.bip39Passphrase).toBe('e\u0301 Secret ');

    const derived = await request({
      type: 'deriveAddresses',
      sessionId: importedSummary.sessionId,
      requests: [{ path: "m/86'/0'/0'/1/7", scriptType: 'p2tr' }],
    });
    expect(derived.ok).toBe(true);
    const derivation = wasm.invocations.at(-1);
    expect(derivation).toMatchObject({
      operation: 'deriveAddresses',
      input: { mnemonic: MNEMONIC, bip39Passphrase: 'e\u0301 Secret ' },
    });

    const signed = await request({
      type: 'signPsbt',
      sessionId: importedSummary.sessionId,
      psbtBase64: 'unsigned',
      signers: [
        {
          txid: '00'.repeat(32),
          vout: 0,
          path: "m/86'/0'/0'/1/7",
          scriptType: 'p2tr',
        },
      ],
    });
    expect(signed).toMatchObject({
      ok: true,
      result: { psbtBase64: 'signed' },
    });
    expect(wasm.invocations.at(-1)?.input.bip39Passphrase).toBe(
      'e\u0301 Secret ',
    );

    const revealed = await request({
      type: 'revealMnemonic',
      sessionId: importedSummary.sessionId,
    });
    expect(revealed).toMatchObject({
      ok: true,
      result: { mnemonic: MNEMONIC, wordCount: 12 },
    });
    expect(JSON.stringify(revealed)).not.toContain('Secret');

    const replacement = await request({
      type: 'importMnemonic',
      mnemonic: MNEMONIC,
      bip39Passphrase: 'replacement',
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error(replacement.error.message);
    const replacementSessionId = (replacement.result as { sessionId: string })
      .sessionId;

    await expect(
      request({
        type: 'deriveAddresses',
        sessionId: importedSummary.sessionId,
        requests: [{ path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' }],
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'SESSION_LOCKED' },
    });

    await request({
      type: 'deriveAddresses',
      sessionId: replacementSessionId,
      requests: [{ path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' }],
    });
    expect(wasm.invocations.at(-1)?.input.bip39Passphrase).toBe(
      'replacement',
    );

    const created = await request({
      type: 'createMnemonic',
      wordCount: 12,
      bip39Passphrase: 'created-secret',
    });
    expect(created).toMatchObject({
      ok: true,
      result: { mnemonic: GENERATED_MNEMONIC, source: 'bip39-hd' },
    });
    expect(JSON.stringify(created)).not.toContain('created-secret');
  });

  it('keeps email and single-key sessions outside the BIP39 passphrase contract', async () => {
    const email = await request({
      type: 'importEmailCredentials',
      email: 'alice@example.com',
      password: 'email password',
    });
    expect(email.ok).toBe(true);
    if (!email.ok) throw new Error(email.error.message);
    const emailSessionId = (email.result as { sessionId: string }).sessionId;
    const emailPrimaryDerivation = wasm.invocations.find(
      ({ operation }) => operation === 'deriveAddresses',
    );
    expect(emailPrimaryDerivation?.input).not.toHaveProperty(
      'bip39Passphrase',
    );

    await request({
      type: 'deriveAddresses',
      sessionId: emailSessionId,
      requests: [{ path: "m/84'/0'/0'/0/1", scriptType: 'p2wpkh' }],
    });
    expect(wasm.invocations.at(-1)?.input).not.toHaveProperty(
      'bip39Passphrase',
    );

    await request({
      type: 'signPsbt',
      sessionId: emailSessionId,
      psbtBase64: 'email-unsigned',
      signers: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          path: "m/84'/0'/0'/0/1",
          scriptType: 'p2wpkh',
        },
      ],
    });
    expect(wasm.invocations.at(-1)).toMatchObject({ operation: 'signPsbt' });
    expect(wasm.invocations.at(-1)?.input).not.toHaveProperty(
      'bip39Passphrase',
    );

    const singleKey = await request({
      type: 'importPrivateKey',
      privateKey: '1'.repeat(64),
    });
    expect(singleKey.ok).toBe(true);
    if (!singleKey.ok) throw new Error(singleKey.error.message);
    const singleKeySessionId = (singleKey.result as { sessionId: string })
      .sessionId;
    await request({
      type: 'signPsbt',
      sessionId: singleKeySessionId,
      psbtBase64: 'single-key-unsigned',
      signers: [
        {
          txid: '22'.repeat(32),
          vout: 0,
          scriptType: 'p2wpkh',
          publicKeyCompressed: true,
        },
      ],
    });
    expect(wasm.invocations.at(-1)).toMatchObject({
      operation: 'signPsbtWithPrivateKey',
    });
    expect(wasm.invocations.at(-1)?.input).not.toHaveProperty(
      'bip39Passphrase',
    );
  });
});
