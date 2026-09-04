import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { bech32 } from 'bech32';
import { beforeAll, describe, expect, it } from 'vitest';

import { instantiateNitoWasmCrypto } from '../crypto/wasmAbi';
import type { DerivedAddress } from '../crypto/workerProtocol';
import {
  HD_ACCOUNT_TEMPLATES,
  type HdAccountKey,
} from '../domain/wallet-policy';
import { automaticChangeAccount, changeAccountForWallet } from './changePolicy';

const FAMILIES = HD_ACCOUNT_TEMPLATES.map((template) => template.key);
const HD = { hd: true, primaryAddresses: [] };

describe('Bitcoin Core recipient-based change policy', () => {
  let addresses: Record<HdAccountKey, string>;
  beforeAll(async () => {
    const wasm = await instantiateNitoWasmCrypto(
      await readFile(resolve('public/wasm/nito_wallet_crypto_web.wasm')),
      (target) => target.fill(0x5a),
    );
    const derived = wasm.invoke<DerivedAddress[]>('deriveAddresses', {
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      requests: HD_ACCOUNT_TEMPLATES.map((template) => ({
        path: `${template.accountPath}/0/2`,
        scriptType: template.scriptType,
      })),
    });
    addresses = Object.fromEntries(
      FAMILIES.map((key, index) => [key, derived[index].address]),
    ) as Record<HdAccountKey, string>;
  });

  it.each(FAMILIES)('matches a single %s recipient', (family) => {
    expect(changeAccountForWallet([addresses[family]], HD)).toBe(family);
  });

  it('matches all 15 mixed-family combinations independently of recipient order', () => {
    for (let mask = 1; mask < 16; mask += 1) {
      const families = FAMILIES.filter((_, index) => mask & (1 << index));
      const recipients = families.map((key) => addresses[key]);
      const expected = families[families.length - 1];
      expect(changeAccountForWallet(recipients, HD)).toBe(expected);
      expect(changeAccountForWallet([...recipients].reverse(), HD)).toBe(
        expected,
      );
    }
  });

  it('supports raw keys without offering Taproot change, even for Taproot recipients', () => {
    const raw = {
      hd: false,
      primaryAddresses: HD_ACCOUNT_TEMPLATES.map(({ scriptType }) => ({
        scriptType,
      })),
    };
    for (const family of ['legacy', 'p2sh', 'bech32'] as const) {
      expect(changeAccountForWallet([addresses[family]], raw)).toBe(family);
    }
    expect(changeAccountForWallet([addresses.taproot], raw)).toBe('bech32');
    expect(
      changeAccountForWallet([addresses.taproot, addresses.p2sh], raw),
    ).toBe('p2sh');
    expect(
      changeAccountForWallet(
        [addresses.taproot, addresses.legacy, addresses.bech32],
        raw,
      ),
    ).toBe('bech32');
  });

  it('never selects an unavailable family or a foreign-network address', () => {
    expect(automaticChangeAccount([addresses.taproot], ['legacy'])).toBe(
      'legacy',
    );
    expect(() => automaticChangeAccount([addresses.taproot], [])).toThrow(
      expect.objectContaining({ code: 'change-address-unavailable' }),
    );
    const foreignWitnessAddress = bech32.encode(
      'bc',
      bech32.decode(addresses.bech32).words,
    );
    for (const address of ['bad-address', foreignWitnessAddress]) {
      expect(() => changeAccountForWallet([address], HD)).toThrow(
        expect.objectContaining({ code: 'recipient-address-invalid' }),
      );
    }
    expect(() => changeAccountForWallet(['  '], HD)).toThrow(
      expect.objectContaining({ code: 'recipient-address-required' }),
    );
    // NITO shares Bitcoin's Legacy/P2SH prefixes; those addresses cannot be
    // distinguished by network from their encoding alone.
    expect(
      changeAccountForWallet(['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'], HD),
    ).toBe('legacy');
  });
});
