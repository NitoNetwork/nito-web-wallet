const MAX_WASM_STRING_BYTES = 16 * 1024 * 1024;
const WEB_CRYPTO_RANDOM_CHUNK_BYTES = 65_536;

type WasmCryptoExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  nito_wallet_crypto_alloc(length: number): number;
  nito_wallet_crypto_free(pointer: number): void;
  nito_wallet_crypto_free_bytes(pointer: number, length: number): void;
  nito_wallet_crypto_invoke(operation: number, request: number): number;
};

type CryptoEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string } };

export type WasmEntropySource = (bytes: Uint8Array) => void;

export class NitoCryptoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NitoCryptoError';
  }
}

function isWasmCryptoExports(value: WebAssembly.Exports): value is WasmCryptoExports {
  const candidate = value as Partial<WasmCryptoExports>;
  return (
    candidate.memory instanceof WebAssembly.Memory &&
    typeof candidate.nito_wallet_crypto_alloc === 'function' &&
    typeof candidate.nito_wallet_crypto_free === 'function' &&
    typeof candidate.nito_wallet_crypto_free_bytes === 'function' &&
    typeof candidate.nito_wallet_crypto_invoke === 'function'
  );
}

function fillWithWebCrypto(bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.length; offset += WEB_CRYPTO_RANDOM_CHUNK_BYTES) {
    crypto.getRandomValues(
      bytes.subarray(offset, Math.min(offset + WEB_CRYPTO_RANDOM_CHUNK_BYTES, bytes.length)),
    );
  }
}

function readNullTerminatedUtf8(memory: WebAssembly.Memory, pointer: number): string {
  if (!Number.isSafeInteger(pointer) || pointer <= 0) {
    throw new NitoCryptoError('INVALID_WASM_RESPONSE', 'The WASM core returned an invalid pointer.');
  }
  const bytes = new Uint8Array(memory.buffer);
  const upperBound = Math.min(bytes.length, pointer + MAX_WASM_STRING_BYTES);
  let end = pointer;
  while (end < upperBound && bytes[end] !== 0) end += 1;
  if (end === upperBound) {
    throw new NitoCryptoError(
      'INVALID_WASM_RESPONSE',
      'The WASM core returned an unterminated or oversized response.',
    );
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pointer, end));
}

export class NitoWasmCrypto {
  constructor(private readonly exports: WasmCryptoExports) {}

  invoke<T>(operation: string, request: unknown): T {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(operation)) {
      throw new NitoCryptoError('INVALID_OPERATION', 'Invalid cryptographic operation name.');
    }

    const encoder = new TextEncoder();
    const operationBytes = encoder.encode(`${operation}\0`);
    const requestBytes = encoder.encode(`${JSON.stringify(request)}\0`);
    if (requestBytes.length > MAX_WASM_STRING_BYTES) {
      requestBytes.fill(0);
      throw new NitoCryptoError('REQUEST_TOO_LARGE', 'Cryptographic request exceeds size policy.');
    }

    const operationPointer = this.exports.nito_wallet_crypto_alloc(operationBytes.length);
    const requestPointer = this.exports.nito_wallet_crypto_alloc(requestBytes.length);
    if (!operationPointer || !requestPointer) {
      if (operationPointer) {
        this.exports.nito_wallet_crypto_free_bytes(operationPointer, operationBytes.length);
      }
      if (requestPointer) {
        this.exports.nito_wallet_crypto_free_bytes(requestPointer, requestBytes.length);
      }
      operationBytes.fill(0);
      requestBytes.fill(0);
      throw new NitoCryptoError('WASM_ALLOCATION_FAILED', 'The WASM core could not allocate memory.');
    }

    let responsePointer = 0;
    try {
      const memory = new Uint8Array(this.exports.memory.buffer);
      memory.set(operationBytes, operationPointer);
      memory.set(requestBytes, requestPointer);
      responsePointer = this.exports.nito_wallet_crypto_invoke(operationPointer, requestPointer);
      const rawResponse = readNullTerminatedUtf8(this.exports.memory, responsePointer);
      const envelope = JSON.parse(rawResponse) as CryptoEnvelope<T>;
      if (!envelope.ok) {
        throw new NitoCryptoError(envelope.error.code, envelope.error.message);
      }
      return envelope.result;
    } finally {
      const currentMemory = new Uint8Array(this.exports.memory.buffer);
      currentMemory.fill(0, operationPointer, operationPointer + operationBytes.length);
      currentMemory.fill(0, requestPointer, requestPointer + requestBytes.length);
      operationBytes.fill(0);
      requestBytes.fill(0);
      this.exports.nito_wallet_crypto_free_bytes(operationPointer, operationBytes.length);
      this.exports.nito_wallet_crypto_free_bytes(requestPointer, requestBytes.length);
      if (responsePointer) this.exports.nito_wallet_crypto_free(responsePointer);
    }
  }
}

export async function instantiateNitoWasmCrypto(
  source: BufferSource,
  entropySource: WasmEntropySource = fillWithWebCrypto,
): Promise<NitoWasmCrypto> {
  const state: { exports?: WasmCryptoExports } = {};
  const imports = {
    nito_crypto: {
      fill_random(pointer: number, length: number): number {
        if (!state.exports || pointer < 0 || length <= 0) return 1;
        try {
          const end = pointer + length;
          const memory = new Uint8Array(state.exports.memory.buffer);
          if (!Number.isSafeInteger(end) || end > memory.length) return 1;
          const target = memory.subarray(pointer, end);
          for (let offset = 0; offset < target.length; offset += WEB_CRYPTO_RANDOM_CHUNK_BYTES) {
            entropySource(
              target.subarray(
                offset,
                Math.min(offset + WEB_CRYPTO_RANDOM_CHUNK_BYTES, target.length),
              ),
            );
          }
          return 0;
        } catch {
          new Uint8Array(state.exports.memory.buffer).fill(0, pointer, pointer + length);
          return 1;
        }
      },
    },
  } satisfies WebAssembly.Imports;

  const wasmModule = await WebAssembly.compile(source);
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  if (!isWasmCryptoExports(instance.exports)) {
    throw new NitoCryptoError(
      'INVALID_WASM_MODULE',
      'The WASM module does not expose the expected Nito crypto ABI.',
    );
  }
  state.exports = instance.exports;
  return new NitoWasmCrypto(instance.exports);
}
