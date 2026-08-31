import { NitoCryptoError } from './wasmAbi';
// oxlint-disable-next-line import/default -- Vite exposes a Worker constructor for ?worker imports.
import CryptoWorkerConstructor from './crypto.worker?worker';
import {
  isCryptoWorkerResponse,
  type CryptoWorkerCommand,
  type CryptoWorkerResultByCommand,
  type CryptoWorkerResponse,
} from './workerProtocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

type CommandOfType<T extends CryptoWorkerCommand['type']> = Extract<
  CryptoWorkerCommand,
  { type: T }
>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
};

export type WorkerLike = Pick<
  Worker,
  'addEventListener' | 'postMessage' | 'removeEventListener' | 'terminate'
>;

export class CryptoWorkerClient {
  private worker: WorkerLike | undefined;

  private readonly pending = new Map<string, PendingRequest>();

  private readonly handleMessage = (event: MessageEvent<unknown>) => {
    if (!isCryptoWorkerResponse(event.data)) return;
    const response: CryptoWorkerResponse = event.data;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(new NitoCryptoError(response.error.code, response.error.message));
    }
  };

  private readonly handleWorkerFailure = (event: Event) => {
    const detail =
      event instanceof ErrorEvent && event.message
        ? ` ${event.message}${event.filename ? ` (${event.filename}:${event.lineno})` : ''}`
        : ` Event: ${event.type}.`;
    this.rejectAll(
      new NitoCryptoError(
        'CRYPTO_WORKER_TERMINATED',
        `The cryptographic worker stopped unexpectedly.${detail}`,
      ),
    );
    this.destroyWorker();
  };

  constructor(
    private readonly createWorker: () => WorkerLike = () =>
      new CryptoWorkerConstructor({
        name: 'nito-wallet-crypto',
      }),
    private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async request<T extends CryptoWorkerCommand['type']>(
    command: CommandOfType<T>,
  ): Promise<CryptoWorkerResultByCommand[T]> {
    const worker = this.ensureWorker();
    const id = crypto.randomUUID();
    return new Promise<CryptoWorkerResultByCommand[T]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new NitoCryptoError('CRYPTO_WORKER_TIMEOUT', 'Cryptographic operation timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as CryptoWorkerResultByCommand[T]),
        reject,
        timeout,
      });
      worker.postMessage({ id, command });
    });
  }

  dispose(): void {
    this.rejectAll(new NitoCryptoError('CRYPTO_WORKER_TERMINATED', 'The cryptographic worker closed.'));
    this.destroyWorker();
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener('message', this.handleMessage);
    worker.addEventListener('error', this.handleWorkerFailure);
    worker.addEventListener('messageerror', this.handleWorkerFailure);
    this.worker = worker;
    return worker;
  }

  private destroyWorker(): void {
    if (!this.worker) return;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerFailure);
    this.worker.removeEventListener('messageerror', this.handleWorkerFailure);
    this.worker.terminate();
    this.worker = undefined;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
