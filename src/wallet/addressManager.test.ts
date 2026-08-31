import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { instantiateNitoWasmCrypto, type NitoWasmCrypto } from '../crypto/wasmAbi';
import type { HdAddressSequence } from '../domain/wallet-policy';
import type { HdAddressDeriver, ScannedAddress } from './transparentScan';
import { HdAddressManager } from './addressManager';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEQUENCE: HdAddressSequence = {
  account: 0,
  accountKey: 'bech32',
  branch: 'external',
};

describe('HdAddressManager', () => {
  let wasm: NitoWasmCrypto;
  let deriveAddresses: HdAddressDeriver;

  beforeAll(async () => {
    const bytes = await readFile(resolve(process.cwd(), 'public', 'wasm', 'nito_wallet_crypto_web.wasm'));
    wasm = await instantiateNitoWasmCrypto(bytes, (target) => target.fill(0x4a));
    deriveAddresses = async (_sessionId, requests) =>
      wasm.invoke('deriveAddresses', { mnemonic: MNEMONIC, requests });
  });

  it('keeps the current unused address in memory without incrementing it', async () => {
    const manager = new HdAddressManager('opaque-session', deriveAddresses);
    const first = await manager.currentOrReserve(SEQUENCE, []);
    const reopened = await manager.currentOrReserve(SEQUENCE, []);
    expect(first.index).toBe(0);
    expect(reopened).toEqual(first);
    await expect(manager.scanRequirements()).resolves.toEqual([{
      ...SEQUENCE,
      highestIssuedIndex: 0,
    }]);
  });

  it('shows external index zero even when later addresses were already used', async () => {
    const derived = await deriveAddresses('opaque-session', Array.from({ length: 6 }, (_, index) => ({
      path: `m/84'/0'/0'/0/${index}`,
      scriptType: 'p2wpkh' as const,
    })));
    const knownAddresses = derived.map((address, index) => ({
      ...address,
      ownerKind: 'hd' as const,
      account: 0 as const,
      accountKey: 'bech32' as const,
      accountLabel: 'Bech32',
      accountPath: "m/84'/0'/0'",
      recoveryOnly: false,
      branch: 'external' as const,
      index,
      balance: { confirmedSats: 0, unconfirmedSats: 0, totalSats: 0 },
      utxos: [],
      history: [],
      used: index < 5,
    })) satisfies ScannedAddress[];
    const workerDeriver = vi.fn(deriveAddresses);
    const manager = new HdAddressManager('opaque-session', workerDeriver);

    await expect(manager.currentOrPrimary(SEQUENCE, knownAddresses)).resolves.toMatchObject({
      index: 0,
      path: "m/84'/0'/0'/0/0",
    });
    await expect(manager.reserveNew(SEQUENCE, knownAddresses)).resolves.toMatchObject({
      index: 5,
      path: "m/84'/0'/0'/0/5",
    });
    expect(workerDeriver).not.toHaveBeenCalled();
  });

  it('reserves above every address proven used on chain', async () => {
    const manager = new HdAddressManager('opaque-session', deriveAddresses);
    const knownAddresses = Array.from({ length: 5 }, (_, index) => ({
      ownerKind: 'hd' as const,
      account: 0 as const,
      accountKey: 'bech32' as const,
      accountLabel: 'Bech32',
      accountPath: "m/84'/0'/0'",
      recoveryOnly: false,
      branch: 'external' as const,
      index,
      path: `m/84'/0'/0'/0/${index}`,
      scriptType: 'p2wpkh' as const,
      address: `known-${index}`,
      publicKeyHex: `02${'11'.repeat(32)}`,
      scriptHex: `0014${'22'.repeat(20)}`,
      balance: { confirmedSats: 0, unconfirmedSats: 0, totalSats: 0 },
      utxos: [],
      history: [],
      used: true,
    })) satisfies ScannedAddress[];

    await expect(manager.currentOrReserve(SEQUENCE, knownAddresses)).resolves.toMatchObject({
      index: 5,
      path: "m/84'/0'/0'/0/5",
      scriptType: 'p2wpkh',
    });
  });

  it('does not consume an index when derivation fails before display', async () => {
    let fail = true;
    const flakyDeriver: HdAddressDeriver = async (sessionId, requests) => {
      if (fail) {
        fail = false;
        throw new Error('synthetic worker failure');
      }
      return deriveAddresses(sessionId, requests);
    };
    const manager = new HdAddressManager('opaque-session', flakyDeriver);

    await expect(manager.reserveNew(SEQUENCE, [])).rejects.toThrow('synthetic worker failure');
    await expect(manager.reserveNew(SEQUENCE, [])).resolves.toMatchObject({ index: 0 });
  });
});
