import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { instantiateNitoWasmCrypto, type NitoWasmCrypto } from '../crypto/wasmAbi';
import { deriveEmailCredentialMnemonic } from './email-credentials';

const BIP39_RESTORATION_VECTOR =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const EMAIL_RESTORATION_VECTOR =
  'dice scare infant wreck behave rude rapid author motor knife venue two shoe absurd penalty bus one famous cricket abuse extend panel panic exclude';

type AddressRequest = Readonly<{
  path: string;
  scriptType: 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr';
}>;

describe('BIP39 restoration compatibility', () => {
  let wasm: NitoWasmCrypto;

  beforeAll(async () => {
    const bytes = await readFile(
      resolve(process.cwd(), 'public', 'wasm', 'nito_wallet_crypto_web.wasm'),
    );
    wasm = await instantiateNitoWasmCrypto(bytes, (target) => target.fill(0x39));
  });

  const derive = (mnemonic: string, requests: readonly AddressRequest[]) =>
    wasm.invoke<Array<{ path: string; address: string }>>('deriveAddresses', {
      mnemonic,
      requests,
    });

  it('restores the 12-word vector across external, internal and deep paths', () => {
    const requests: AddressRequest[] = [
      { path: "m/44'/0'/0'/1/0", scriptType: 'p2pkh' },
      { path: "m/49'/0'/0'/1/0", scriptType: 'p2sh-p2wpkh' },
      { path: "m/84'/0'/0'/1/0", scriptType: 'p2wpkh' },
      { path: "m/86'/0'/0'/1/0", scriptType: 'p2tr' },
      { path: "m/44'/0'/1'/0/1", scriptType: 'p2pkh' },
      { path: "m/49'/0'/1'/0/1", scriptType: 'p2sh-p2wpkh' },
      { path: "m/84'/0'/1'/0/1", scriptType: 'p2wpkh' },
      { path: "m/86'/0'/1'/0/1", scriptType: 'p2tr' },
      { path: "m/84'/0'/0'/0/20", scriptType: 'p2wpkh' },
      { path: "m/84'/0'/0'/1/37", scriptType: 'p2wpkh' },
      { path: "m/84'/0'/1'/0/999", scriptType: 'p2wpkh' },
      { path: "m/84'/0'/1'/0/1000", scriptType: 'p2wpkh' },
      { path: "m/84'/0'/1'/0/9999", scriptType: 'p2wpkh' },
    ];

    expect(derive(BIP39_RESTORATION_VECTOR, requests).map(({ address }) => address)).toEqual([
      '1J3J6EvPrv8q6AC3VCjWV45Uf3nssNMRtH',
      '34K56kSjgUCUSD8GTtuF7c9Zzwokbs6uZ7',
      'nito1q8c6fshw2dlwun7ekn9qwf37cu2rn755uyz5tjf',
      'nito1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqmkcdcl',
      '1Gb9eQ8tqEd1dHQEU2JB5V6p7C4ivQyBDq',
      '323g91YR7r6FWKF8SegvykHdmy5S2AVTv2',
      'nito1qx0tpa0ctsy5v8xewdkpf69hhtz5cw0rf3xe4ev',
      'nito1pqfhqcv85tqvlzhxcdde06k5arfkyyz6tvf9x03v2mgy2w25qpmjs7vkfn4',
      'nito1qy62dyq937vfjr5e8tj3ltx7zc6fw958t7k4vlf',
      'nito1qkzkg24m6j2gkwq4y5s0xhjmxtdvvzkwtaqd30y',
      'nito1qh242zj2v9tuwrtfdwthtc594yclukrjxczx3a4',
      'nito1q2ym2c9tpt90jhs0x5fepk0v6ghnfsk7q4w29vv',
      'nito1qj0vycncf27q0478janvcexrltgp3lnauj07mws',
    ]);
  });

  it('restores a deterministic email wallet from its revealed 24-word BIP39 phrase', async () => {
    const derivedMnemonic = await deriveEmailCredentialMnemonic(
      '  Test.User+Legacy@Example.COM  ',
      '  Legacy-Test-Password-2026!  ',
    );
    expect(derivedMnemonic).toBe(EMAIL_RESTORATION_VECTOR);
    const requests: AddressRequest[] = [
      { path: "m/44'/0'/0'/0/0", scriptType: 'p2pkh' },
      { path: "m/49'/0'/0'/0/0", scriptType: 'p2sh-p2wpkh' },
      { path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' },
      { path: "m/86'/0'/0'/0/0", scriptType: 'p2tr' },
    ];
    const emailAddresses = derive(derivedMnemonic, requests);
    const restoredFromSeedAddresses = derive(EMAIL_RESTORATION_VECTOR, requests);

    expect(emailAddresses.map(({ address }) => address)).toEqual([
      '1LxDd9JxFmkWq5YDdpAfbE5RsXJkRtwAd2',
      '3FpxsTP8NcgaiEh56GMZMpvRpUfBKsqtXT',
      'nito1qu5eegn0ek0uyygj9pkevfxg80avl50nn08ugr0',
      'nito1ptmrefqhfhsxyl7xup05fphztqwld0trvsa7z0q7a7dcztxye7cdq9u2x3n',
    ]);
    expect(restoredFromSeedAddresses).toEqual(emailAddresses);
  });
});
