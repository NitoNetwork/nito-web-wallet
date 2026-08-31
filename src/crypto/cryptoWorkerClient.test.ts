import { describe, expect, it, vi } from 'vitest';

import { CryptoWorkerClient, type WorkerLike } from './cryptoWorkerClient';
import { NitoCryptoError } from './wasmAbi';

type Listener = (event: { data?: unknown }) => void;

class MockWorker {
  readonly messages: unknown[] = [];

  terminateCount = 0;

  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function asWorkerLike(worker: MockWorker): WorkerLike {
  return worker as unknown as WorkerLike;
}

describe('CryptoWorkerClient', () => {
  it('correlates successful responses without exposing transport details', async () => {
    const worker = new MockWorker();
    const client = new CryptoWorkerClient(() => asWorkerLike(worker));
    const resultPromise = client.request({ type: 'health' });
    const request = worker.messages[0] as { id: string };
    worker.emit('message', {
      id: request.id,
      ok: true,
      result: {
        abiVersion: 1,
        transparentOnly: true,
        sources: ['bip39-hd', 'single-private-key', 'email-credentials'],
        scriptTypes: ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'],
        maxDerivationIndex: 9_999,
      },
    });

    await expect(resultPromise).resolves.toMatchObject({ abiVersion: 1, transparentOnly: true });
    client.dispose();
  });

  it('turns structured worker failures into typed crypto errors', async () => {
    const worker = new MockWorker();
    const client = new CryptoWorkerClient(() => asWorkerLike(worker));
    const resultPromise = client.request({
      type: 'importPrivateKey',
      privateKey: 'invalid',
    });
    const request = worker.messages[0] as { id: string };
    worker.emit('message', {
      id: request.id,
      ok: false,
      error: { code: 'INVALID_PRIVATE_KEY', message: 'Invalid private key.' },
    });

    await expect(resultPromise).rejects.toMatchObject({
      name: 'NitoCryptoError',
      code: 'INVALID_PRIVATE_KEY',
    } satisfies Partial<NitoCryptoError>);
    client.dispose();
  });

  it('terminates the worker immediately when the session is disposed', () => {
    const worker = new MockWorker();
    const client = new CryptoWorkerClient(() => asWorkerLike(worker));
    void client.request({ type: 'health' }).catch(() => undefined);
    client.dispose();

    expect(worker.terminateCount).toBe(1);
  });

  it('fails closed when a worker request times out', async () => {
    vi.useFakeTimers();
    try {
      const worker = new MockWorker();
      const client = new CryptoWorkerClient(() => asWorkerLike(worker), 10);
      const resultPromise = client.request({ type: 'health' });
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: 'CRYPTO_WORKER_TIMEOUT',
      });
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
