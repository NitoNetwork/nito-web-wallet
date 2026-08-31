import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { NitoCryptoError, NitoWasmCrypto, instantiateNitoWasmCrypto } from './wasmAbi';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('compiled Nito crypto WASM ABI', () => {
  let wasm: NitoWasmCrypto;

  beforeAll(async () => {
    const bytes = await readFile(
      resolve(process.cwd(), 'public', 'wasm', 'nito_wallet_crypto_web.wasm'),
    );
    wasm = await instantiateNitoWasmCrypto(bytes, (target) => target.fill(0x5a));
  });

  it('executes the mobile BIP39 address derivation inside real WASM', () => {
    const result = wasm.invoke<Array<{ address: string; scriptType: string }>>('deriveAddresses', {
      mnemonic: MNEMONIC,
      requests: [
        { path: "m/44'/0'/0'/0/0", scriptType: 'p2pkh' },
        { path: "m/49'/0'/0'/0/0", scriptType: 'p2sh-p2wpkh' },
        { path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' },
        { path: "m/86'/0'/0'/0/0", scriptType: 'p2tr' },
      ],
    });

    expect(result.map(({ address }) => address)).toEqual([
      '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA',
      '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf',
      'nito1qcr8te4kr609gcawutmrza0j4xv80jy8z540c02',
      'nito1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqrvfekz',
    ]);
    expect(result.map(({ scriptType }) => scriptType)).toEqual([
      'p2pkh',
      'p2sh-p2wpkh',
      'p2wpkh',
      'p2tr',
    ]);
  });

  it('generates both allowed mnemonic sizes through the host CSPRNG boundary', () => {
    const twelve = wasm.invoke<{ mnemonic: string }>('generateMnemonic', { wordCount: 12 });
    const twentyFour = wasm.invoke<{ mnemonic: string }>('generateMnemonic', { wordCount: 24 });
    expect(twelve.mnemonic.split(' ')).toHaveLength(12);
    expect(twentyFour.mnemonic.split(' ')).toHaveLength(24);
  });

  it('validates WIF/HEX and never returns the supplied private value', () => {
    const privateKey =
      '0000000000000000000000000000000000000000000000000000000000000001';
    const result = wasm.invoke<{
      format: string;
      compressed: boolean;
      addresses: Array<{ address: string }>;
    }>('inspectPrivateKey', { privateKey });
    expect(result.format).toBe('hex');
    expect(result.compressed).toBe(true);
    expect(result.addresses.map(({ address }) => address)).toContain(
      'nito1qw508d6qejxtdg4y5r3zarvary0c5xw7kfauqqr',
    );
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it('propagates structured Rust errors', () => {
    const deriveInvalidPath = () =>
      wasm.invoke('deriveAddresses', {
        mnemonic: MNEMONIC,
        requests: [{ path: "m/84'/0'/0'/0/10000", scriptType: 'p2wpkh' }],
      });
    expect(deriveInvalidPath).toThrow(NitoCryptoError);
    try {
      deriveInvalidPath();
    } catch (error) {
      expect((error as NitoCryptoError).code).toBe('INVALID_DERIVATION_PATH');
    }
  });
});
