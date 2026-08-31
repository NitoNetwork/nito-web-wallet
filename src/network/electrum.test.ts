import { afterEach, describe, expect, it, vi } from 'vitest';
import { bech32, bech32m } from 'bech32';

import {
  addressToElectrumScripthash,
  ELECTRUM_MAX_MESSAGE_CHARACTERS,
  ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS,
  ElectrumInvalidResponseError,
  electrumScripthashFromScript,
  NitoElectrumClient,
  NITO_ELECTRUM_SERVERS,
  scriptPubKeyForNitoAddress,
} from './electrum';
import { NITO_ELECTRUM_WSS_ORIGINS } from './electrumServers';

const ADDRESS = 'nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02';
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('Nito Electrum helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the two audited public endpoints WSS-only', () => {
    expect(NITO_ELECTRUM_SERVERS).toEqual([
      { host: 'electrum1.nito.network', port: 50005, protocol: 'wss', priority: 1 },
      { host: 'electrum1.nitopool.fr', port: 50005, protocol: 'wss', priority: 2 },
    ]);
    expect(
      NITO_ELECTRUM_SERVERS.map(({ host, port }) => `wss://${host}:${port}`),
    ).toEqual(NITO_ELECTRUM_WSS_ORIGINS);
  });

  it('builds the P2WPKH script and reversed SHA-256 scripthash used by ElectrumX', () => {
    const script = scriptPubKeyForNitoAddress(ADDRESS);
    expect(toHex(script)).toBe('0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2');
    expect(electrumScripthashFromScript(script)).toBe(
      '6e4f16236139f15046b38f399a683fb2aa8edf5fd128b3e5db017fb0ac74078a',
    );
    expect(addressToElectrumScripthash(ADDRESS)).toBe(
      '6e4f16236139f15046b38f399a683fb2aa8edf5fd128b3e5db017fb0ac74078a',
    );
  });

  it('accepts only canonical public witness versions and program lengths', () => {
    const wrongP2wpkhLength = bech32.encode(
      'nito',
      [0, ...bech32.toWords(Uint8Array.from({ length: 32 }, () => 1))],
    );
    const wrongTaprootLength = bech32m.encode(
      'nito',
      [1, ...bech32.toWords(Uint8Array.from({ length: 20 }, () => 2))],
    );
    const wrongWitnessVersion = bech32m.encode(
      'nito',
      [2, ...bech32.toWords(Uint8Array.from({ length: 32 }, () => 3))],
    );

    expect(() => scriptPubKeyForNitoAddress(wrongP2wpkhLength)).toThrow(
      'Invalid public witness address',
    );
    expect(() => scriptPubKeyForNitoAddress(wrongTaprootLength)).toThrow(
      'Invalid public witness address',
    );
    expect(() => scriptPubKeyForNitoAddress(wrongWitnessVersion)).toThrow(
      'Private address unavailable',
    );
    expect(() =>
      scriptPubKeyForNitoAddress(`${ADDRESS.slice(0, 8).toUpperCase()}${ADDRESS.slice(8)}`),
    ).toThrow('mixed-case');
    expect(toHex(scriptPubKeyForNitoAddress(ADDRESS.toUpperCase()))).toBe(
      toHex(scriptPubKeyForNitoAddress(ADDRESS)),
    );
  });

  it('notifies advances, lower reorg heights and same-height header changes', () => {
    const client = new NitoElectrumClient();
    client.blockHeight = 100;
    const updates: [number, number][] = [];
    const unsubscribe = client.subscribeBlockHeight((height, previous) =>
      updates.push([height, previous]),
    );
    const handleMessage = (
      client as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(client);

    handleMessage(
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: 100, hex: 'aa' }] }),
    );
    handleMessage(
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: 101, hex: 'bb' }] }),
    );
    handleMessage(
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: 101, hex: 'cc' }] }),
    );
    handleMessage(
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: 99, hex: 'dd' }] }),
    );
    unsubscribe();

    expect(updates).toEqual([
      [101, 100],
      [101, 101],
      [99, 101],
    ]);
  });

  it('converts the next-block Electrum estimate from coin/kB to nitoshi/vByte', async () => {
    const client = new NitoElectrumClient();
    const requestSpy = vi
      .spyOn(client, 'request')
      .mockResolvedValueOnce(0.00002);

    await expect(client.estimateFeeRate(1)).resolves.toBe(BigInt(2));
    expect(requestSpy).toHaveBeenCalledWith('blockchain.estimatefee', [1]);

    requestSpy.mockResolvedValueOnce(-1);
    await expect(client.estimateFeeRate(1)).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );
  });

  it('rejects malformed financial RPC responses instead of inventing values', async () => {
    const client = new NitoElectrumClient();
    const requestSpy = vi
      .spyOn(client, 'request')
      .mockResolvedValue({ confirmed: '100', unconfirmed: 0 });

    await expect(client.getAddressBalance(ADDRESS)).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );

    requestSpy.mockResolvedValueOnce([
      { tx_hash: 'not-a-txid', tx_pos: 0, value: 1, height: 1 },
    ]);
    await expect(client.getAddressUtxos(ADDRESS)).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );

    requestSpy.mockResolvedValueOnce([
      { tx_hash: 'ab'.repeat(32), height: Number.NaN },
    ]);
    await expect(client.getAddressHistory(ADDRESS)).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );

    requestSpy.mockResolvedValueOnce('not-transaction-hex');
    await expect(client.getTransactionHex('ab'.repeat(32))).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );

    const handleMessage = (
      client as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(client);
    expect(() => handleMessage('null')).toThrow(ElectrumInvalidResponseError);
    expect(() =>
      handleMessage(
        JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{}] }),
      ),
    ).toThrow(ElectrumInvalidResponseError);
  });

  it('bounds hostile WebSocket messages, transaction payloads and subscription hashes', async () => {
    const client = new NitoElectrumClient();
    client.blockHeight = 321;
    const handleMessage = (
      client as unknown as { handleMessage(raw: string): void }
    ).handleMessage.bind(client);

    expect(() => handleMessage(' '.repeat(ELECTRUM_MAX_MESSAGE_CHARACTERS + 1))).toThrow(
      ElectrumInvalidResponseError,
    );
    expect(() =>
      handleMessage(JSON.stringify({ id: 1.5, result: null })),
    ).toThrow(ElectrumInvalidResponseError);
    expect(() =>
      handleMessage({
        toString: () => JSON.stringify({
          method: 'blockchain.scripthash.subscribe',
          params: ['ab'.repeat(32), 'not-a-status-hash'],
        }),
      }.toString()),
    ).toThrow(ElectrumInvalidResponseError);
    expect(() =>
      handleMessage(JSON.stringify({
        method: 'blockchain.scripthash.subscribe',
        params: ['not-a-scripthash', null],
      })),
    ).toThrow(ElectrumInvalidResponseError);
    for (const malformed of [
      '{}',
      JSON.stringify({ method: '', params: [] }),
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [null] }),
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: -1 }] }),
      JSON.stringify({ method: 'blockchain.headers.subscribe', params: [{ height: '321' }] }),
    ]) {
      try {
        handleMessage(malformed);
      } catch (error) {
        expect(error).toBeInstanceOf(ElectrumInvalidResponseError);
      }
      expect(client.blockHeight).toBe(321);
    }

    const requestSpy = vi.spyOn(client, 'request');
    requestSpy.mockResolvedValueOnce('00'.repeat(
      ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS / 2 + 1,
    ));
    await expect(client.getTransactionHex('ab'.repeat(32))).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );
    await expect(
      client.broadcastTransaction(
        '00'.repeat(ELECTRUM_MAX_TRANSACTION_HEX_CHARACTERS / 2 + 1),
      ),
    ).rejects.toThrow('invalid transaction payload');
  });

  it('uses the local txid and rejects a conflicting broadcast response', async () => {
    const client = new NitoElectrumClient();
    vi.spyOn(client, 'request').mockResolvedValue('ab'.repeat(32));

    await expect(client.broadcastTransaction('00', 'ab'.repeat(32))).resolves.toBe(
      'ab'.repeat(32),
    );
    await expect(client.broadcastTransaction('00', 'cd'.repeat(32))).rejects.toBeInstanceOf(
      ElectrumInvalidResponseError,
    );
  });

  it('shares one socket handshake across concurrent connect calls', async () => {
    class FakeWebSocket {
      static instances = 0;

      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;

      constructor(_url: string) {
        FakeWebSocket.instances += 1;
        queueMicrotask(() => this.onopen?.());
      }

      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string };
        const result =
          request.method === 'blockchain.headers.subscribe'
            ? { height: 123 }
            : ['Nito-ElectrumX', '1.4'];
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
        });
      }

      close() {
        this.onclose?.();
      }
    }

    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new NitoElectrumClient();
    await Promise.all([client.connect(), client.connect(), client.connect(), client.connect()]);

    expect(FakeWebSocket.instances).toBe(1);
    expect(client.connected).toBe(true);
    expect(client.blockHeight).toBe(123);
    client.disconnect();
  });

  it('rotates to the secondary server after a persistently failing primary read', async () => {
    class FailingPrimaryWebSocket {
      static urls: string[] = [];

      readonly url: string;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        FailingPrimaryWebSocket.urls.push(url);
        queueMicrotask(() => this.onopen?.());
      }

      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string };
        const primary = this.url.includes('primary.invalid');
        const response =
          request.method === 'server.version'
            ? { id: request.id, result: ['Nito-ElectrumX', '1.4'] }
            : request.method === 'blockchain.headers.subscribe'
              ? { id: request.id, result: { height: 123 } }
              : primary
                ? { id: request.id, error: { code: -32_000, message: 'primary read failed' } }
                : { id: request.id, result: ['secondary-result'] };
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
      }

      close() {
        this.onclose?.();
      }
    }

    vi.stubGlobal('WebSocket', FailingPrimaryWebSocket);
    const client = new NitoElectrumClient([
      { host: 'primary.invalid', port: 50005, protocol: 'wss', priority: 1 },
      { host: 'secondary.invalid', port: 50005, protocol: 'wss', priority: 2 },
    ]);
    await client.connect();

    await expect(client.request('wallet.read')).rejects.toThrow('primary read failed');
    await expect(client.request('wallet.read')).resolves.toEqual(['secondary-result']);
    expect(FailingPrimaryWebSocket.urls).toEqual([
      'wss://primary.invalid:50005',
      'wss://secondary.invalid:50005',
    ]);
    client.disconnect();
  });

  it('restores address subscriptions after an unexpected reconnect', async () => {
    vi.useFakeTimers();

    class ReconnectingWebSocket {
      static instances: ReconnectingWebSocket[] = [];

      readonly generation: number;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;

      constructor(_url: string) {
        this.generation = ReconnectingWebSocket.instances.length + 1;
        ReconnectingWebSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
      }

      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string };
        const result =
          request.method === 'server.version'
            ? ['Nito-ElectrumX', '1.4']
            : request.method === 'blockchain.headers.subscribe'
              ? { height: 123, hex: 'aa' }
              : request.method === 'blockchain.scripthash.subscribe'
                ? this.generation.toString(16).padStart(64, '0')
                : [];
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) }),
        );
      }

      close() {
        this.onclose?.();
      }
    }

    vi.stubGlobal('WebSocket', ReconnectingWebSocket);
    const client = new NitoElectrumClient(
      [{ host: 'reconnect.invalid', port: 50005, protocol: 'wss', priority: 1 }],
      { reconnectDelayMs: 1 },
    );
    const connectionStates: boolean[] = [];
    client.subscribeConnectionState((state) => connectionStates.push(state.connected));
    await client.connect();
    const replayedStatuses: (string | null)[] = [];
    const subscription = await client.subscribeAddressStatus(ADDRESS, (status) =>
      replayedStatuses.push(status),
    );

    ReconnectingWebSocket.instances[0]?.onclose?.();
    await vi.advanceTimersByTimeAsync(1);

    expect(ReconnectingWebSocket.instances).toHaveLength(2);
    expect(replayedStatuses).toEqual(['2'.padStart(64, '0')]);
    expect(connectionStates).toEqual([true, false, true]);
    subscription.unsubscribe();
    client.disconnect();
  });

  it('limits global RPC concurrency and starts timeouts only after dispatch', async () => {
    vi.useFakeTimers();

    class DelayedFakeWebSocket {
      static inFlight = 0;
      static peakInFlight = 0;

      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;

      constructor(_url: string) {
        queueMicrotask(() => this.onopen?.());
      }

      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string };
        DelayedFakeWebSocket.inFlight += 1;
        DelayedFakeWebSocket.peakInFlight = Math.max(
          DelayedFakeWebSocket.peakInFlight,
          DelayedFakeWebSocket.inFlight,
        );
        const result =
          request.method === 'blockchain.headers.subscribe'
            ? { height: 123 }
            : request.method === 'server.version'
              ? ['Nito-ElectrumX', '1.4']
              : [];
        setTimeout(() => {
          DelayedFakeWebSocket.inFlight -= 1;
          this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) });
        }, 8);
      }

      close() {
        this.onclose?.();
      }
    }

    vi.stubGlobal('WebSocket', DelayedFakeWebSocket);
    const client = new NitoElectrumClient(
      [{ host: 'benchmark.invalid', port: 50005, protocol: 'wss', priority: 1 }],
      { timeoutMs: 20, maxConcurrentRequests: 2 },
    );
    const connection = client.connect();
    await vi.runAllTimersAsync();
    await connection;
    client.resetRequestMetrics();

    const reads = Promise.all(
      Array.from({ length: 8 }, () => client.request('benchmark.read')),
    );
    await vi.runAllTimersAsync();
    await reads;

    expect(DelayedFakeWebSocket.peakInFlight).toBe(2);
    expect(client.getRequestMetrics()).toMatchObject({
      totalRequests: 8,
      successfulRequests: 8,
      failedRequests: 0,
      peakInFlight: 2,
      maxQueueDepth: 6,
    });
    client.disconnect();
  });

  it('rejects an empty server set and invalid concurrency', () => {
    expect(() => new NitoElectrumClient([])).toThrow('At least one');
    expect(
      () => new NitoElectrumClient(NITO_ELECTRUM_SERVERS, { maxConcurrentRequests: 0 }),
    ).toThrow('positive integer');
  });
});
