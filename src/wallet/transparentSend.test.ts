import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as btc from '@scure/btc-signer';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DerivedAddress, PrivateKeyInfo } from '../crypto/workerProtocol';
import {
  instantiateNitoWasmCrypto,
  type NitoWasmCrypto,
} from '../crypto/wasmAbi';
import type {
  ScannedAddress,
  TransparentWalletSnapshot,
} from './transparentScan';
import {
  addRbfNetworkFeeMargin,
  buildTransparentConsolidation,
  buildTransparentRbfCancellation,
  buildTransparentSend,
  calculateMaxTransparentSendAmount,
  estimateTransparentRbfCancellation,
  estimateTransparentMultiSend,
  parseNitoAmountToSats,
  planTransparentConsolidation,
  RBF_SEQUENCE,
} from './transparentSend';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );

describe('transparent send selection', () => {
  let wasm: NitoWasmCrypto;
  let external: DerivedAddress;
  let internal: DerivedAddress;
  let recipient: DerivedAddress;
  let legacy: DerivedAddress;
  let p2shHistorical: DerivedAddress;
  let taprootInternal: DerivedAddress;

  beforeAll(async () => {
    wasm = await instantiateNitoWasmCrypto(
      await readFile(
        resolve(process.cwd(), 'public', 'wasm', 'nito_wallet_crypto_web.wasm'),
      ),
      (target) => target.fill(0x5a),
    );
    [external, internal, recipient, legacy, p2shHistorical, taprootInternal] =
      wasm.invoke<DerivedAddress[]>('deriveAddresses', {
        mnemonic: MNEMONIC,
        requests: [
          { path: "m/84'/0'/0'/0/0", scriptType: 'p2wpkh' },
          { path: "m/84'/0'/0'/1/0", scriptType: 'p2wpkh' },
          { path: "m/84'/0'/0'/0/1", scriptType: 'p2wpkh' },
          { path: "m/44'/0'/0'/0/0", scriptType: 'p2pkh' },
          { path: "m/49'/0'/1'/0/0", scriptType: 'p2sh-p2wpkh' },
          { path: "m/86'/0'/0'/1/1", scriptType: 'p2tr' },
        ],
      });
  });

  it('adds a rounded-up safety margin to the live RBF fee rate', () => {
    expect(addRbfNetworkFeeMargin(BigInt(1))).toBe(BigInt(2));
    expect(addRbfNetworkFeeMargin(BigInt(10))).toBe(BigInt(12));
  });

  const scannedAddress = (
    material: DerivedAddress,
    branch: 'external' | 'internal',
    index: number,
    balanceSats: number,
  ): ScannedAddress => ({
    ...material,
    ownerKind: 'hd',
    account: 0,
    accountKey: 'bech32',
    accountLabel: 'Bech32',
    accountPath: "m/84'/0'/0'",
    recoveryOnly: false,
    branch,
    index,
    balance: {
      confirmedSats: balanceSats,
      unconfirmedSats: 0,
      totalSats: balanceSats,
    },
    utxos: [],
    history: [],
    used: balanceSats > 0,
  });

  const makeSnapshot = (): TransparentWalletSnapshot => {
    const owner = scannedAddress(external, 'external', 0, 100_000_000);
    const change = scannedAddress(internal, 'internal', 0, 0);
    const utxo = {
      txid: '11'.repeat(32),
      vout: 0,
      valueSats: 100_000_000,
      height: 100,
      address: external.address,
      confirmations: 12,
      isCoinbase: false,
    };
    owner.utxos = [utxo];
    return {
      schemaVersion: 1,
      sourceKind: 'bip39-hd',
      scanMode: 'gap',
      confirmedSats: 100_000_000,
      unconfirmedSats: 0,
      balanceSats: 100_000_000,
      spendableSats: 100_000_000,
      immatureCoinbaseSats: 0,
      immatureCoinbaseBlocksRemaining: 0,
      utxos: [utxo],
      history: [],
      addresses: [owner, change],
      usedAddresses: [owner],
      spendableAddresses: [owner],
      gapLimit: 20,
      coverage: [],
      scannedAt: '2026-08-30T12:00:00.000Z',
    };
  };

  it('parses NITO amounts without floating point arithmetic', () => {
    expect(parseNitoAmountToSats('1')).toBe(BigInt(100_000_000));
    expect(parseNitoAmountToSats('0,12345678')).toBe(BigInt(12_345_678));
    expect(parseNitoAmountToSats('99 993,87651555')).toBe(
      BigInt('9999387651555'),
    );
    expect(() => parseNitoAmountToSats('0.000000001')).toThrow(
      expect.objectContaining({ code: 'invalid-amount-format' }),
    );
    expect(() => parseNitoAmountToSats('0.00000001')).toThrow(
      expect.objectContaining({ code: 'amount-below-dust' }),
    );
    expect(() => parseNitoAmountToSats('9'.repeat(100_000))).toThrow(
      expect.objectContaining({ code: 'invalid-amount-format' }),
    );
    expect(() => parseNitoAmountToSats('90071992.54740992')).toThrow(
      expect.objectContaining({ code: 'invalid-amount-format' }),
    );
  });

  it('quotes an unsigned send and an exact Max with reserved internal change', async () => {
    const snapshot = makeSnapshot();
    const quote = await estimateTransparentMultiSend({
      snapshot,
      outputs: [{ address: recipient.address, amountSats: BigInt(25_000_000) }],
      changeAddress: internal.address,
    });
    const max = await calculateMaxTransparentSendAmount({
      snapshot,
      toAddress: recipient.address,
      changeAddress: internal.address,
    });

    expect(quote).toMatchObject({
      amountSats: BigInt(25_000_000),
      fitsAvailable: true,
      inputCount: 1,
      changeUsed: true,
    });
    expect(quote.feeSats).toBeGreaterThan(0);
    expect(max.amountSats + BigInt(max.feeSats)).toBe(BigInt(100_000_000));
    expect(max.changeUsed).toBe(false);
  });

  it('signs only selected inputs inside the real WASM and finalizes locally', async () => {
    const snapshot = makeSnapshot();
    const signerRequests: unknown[][] = [];
    const transaction = await buildTransparentSend({
      sessionId: 'opaque-test-session',
      snapshot,
      toAddress: recipient.address,
      amountSats: BigInt(25_000_000),
      changeAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) => {
        signerRequests.push(signers);
        return wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        });
      },
    });

    expect(signerRequests).toEqual([
      [
        {
          txid: '11'.repeat(32),
          vout: 0,
          path: "m/84'/0'/0'/0/0",
          scriptType: 'p2wpkh',
        },
      ],
    ]);
    expect(transaction.txid).toMatch(/^[0-9a-f]{64}$/u);
    expect(transaction.hex.length).toBeGreaterThan(100);
    expect(transaction).toMatchObject({
      inputCount: 1,
      outputCount: 2,
      changeUsed: true,
      walletInputs: [
        { txid: '11'.repeat(32), vout: 0, valueSats: 100_000_000 },
      ],
    });
    expect(transaction.walletOutputs).toEqual([
      expect.objectContaining({ address: internal.address }),
    ]);
    const signed = btc.Transaction.fromRaw(hexBytes(transaction.hex));
    expect(
      Array.from(
        { length: signed.inputsLength },
        (_, index) => signed.getInput(index).sequence,
      ),
    ).toEqual([RBF_SEQUENCE]);
  });

  it('builds a higher-fee RBF cancellation from the exact original inputs', async () => {
    const snapshot = makeSnapshot();
    const original = await buildTransparentSend({
      sessionId: 'opaque-test-session',
      snapshot,
      toAddress: recipient.address,
      amountSats: BigInt(25_000_000),
      changeAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        }),
    });
    const quote = estimateTransparentRbfCancellation({
      snapshot,
      original,
      returnAddress: internal.address,
      feePerVbyte: BigInt(6),
    });
    const replacement = await buildTransparentRbfCancellation({
      sessionId: 'opaque-test-session',
      snapshot,
      original,
      returnAddress: internal.address,
      feePerVbyte: BigInt(6),
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        }),
    });
    const originalTx = btc.Transaction.fromRaw(hexBytes(original.hex));
    const replacementTx = btc.Transaction.fromRaw(hexBytes(replacement.hex));

    expect(replacement).toMatchObject({
      replacesTxid: original.txid,
      feeSats: quote.feeSats,
      inputCount: original.inputCount,
      outputCount: 1,
      changeUsed: false,
      walletInputs: original.walletInputs,
      walletOutputs: [
        {
          vout: 0,
          valueSats: quote.outputSats,
          address: internal.address,
        },
      ],
    });
    expect(replacement.feeSats).toBeGreaterThan(original.feeSats);
    expect(quote.feePerVbyte).toBeGreaterThanOrEqual(BigInt(6));
    expect(quote.feePerVbyte).toBeGreaterThanOrEqual(
      BigInt(Math.ceil(original.feeSats / originalTx.vsize)) + BigInt(1),
    );
    expect(BigInt(quote.feeSats)).toBeGreaterThanOrEqual(
      quote.feePerVbyte * BigInt(quote.estimatedVbytes),
    );
    expect(replacementTx.getInput(0).sequence).toBe(RBF_SEQUENCE);
    expect(replacementTx.getInput(0).txid).toEqual(originalTx.getInput(0).txid);
    expect(replacementTx.getInput(0).index).toBe(originalTx.getInput(0).index);
    expect(BigInt(replacement.feeSats)).toBeGreaterThanOrEqual(
      BigInt(original.feeSats) + BigInt(replacementTx.vsize),
    );
    expect(replacementTx.vsize).toBeLessThanOrEqual(quote.estimatedVbytes);
  });

  it('refuses cancellation when the original transaction does not signal RBF', async () => {
    const snapshot = makeSnapshot();
    const original = await buildTransparentSend({
      sessionId: 'opaque-test-session',
      snapshot,
      toAddress: recipient.address,
      amountSats: BigInt(25_000_000),
      changeAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        }),
    });
    const nonReplaceable = btc.Transaction.fromRaw(hexBytes(original.hex));
    nonReplaceable.updateInput(0, { sequence: 0xffff_ffff }, true);

    expect(() =>
      estimateTransparentRbfCancellation({
        snapshot,
        original: {
          ...original,
          txid: nonReplaceable.id,
          hex: nonReplaceable.hex,
        },
        returnAddress: internal.address,
      }),
    ).toThrow(expect.objectContaining({ code: 'rbf-unavailable' }));
  });

  it('fails closed when the signing port returns an unsigned PSBT', async () => {
    await expect(
      buildTransparentSend({
        sessionId: 'opaque-test-session',
        snapshot: makeSnapshot(),
        toAddress: recipient.address,
        amountSats: BigInt(25_000_000),
        changeAddress: internal.address,
        signPsbt: async (_sessionId, psbtBase64) => ({ psbtBase64 }),
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
  });

  it('signs a WIF/HEX single-key spend without inventing an HD path', async () => {
    const privateKey = '01'.padStart(64, '0');
    const inspected = wasm.invoke<PrivateKeyInfo>('inspectPrivateKey', {
      privateKey,
    });
    const material = inspected.addresses.find(
      (address) => address.scriptType === 'p2wpkh',
    )!;
    const owner: ScannedAddress = {
      ...material,
      ownerKind: 'single-key',
      keyAddressIndex: inspected.addresses.indexOf(material),
      balance: {
        confirmedSats: 100_000_000,
        unconfirmedSats: 0,
        totalSats: 100_000_000,
      },
      utxos: [],
      history: [],
      used: true,
    };
    const utxo = {
      txid: '44'.repeat(32),
      vout: 0,
      valueSats: 100_000_000,
      height: 100,
      address: material.address,
      confirmations: 12,
      isCoinbase: false,
    };
    owner.utxos = [utxo];
    const snapshot: TransparentWalletSnapshot = {
      schemaVersion: 1,
      sourceKind: 'single-private-key',
      scanMode: 'single-key',
      confirmedSats: 100_000_000,
      unconfirmedSats: 0,
      balanceSats: 100_000_000,
      spendableSats: 100_000_000,
      immatureCoinbaseSats: 0,
      immatureCoinbaseBlocksRemaining: 0,
      utxos: [utxo],
      history: [],
      addresses: [owner],
      usedAddresses: [owner],
      spendableAddresses: [owner],
      gapLimit: null,
      coverage: [{ mode: 'single-key', addressCount: 1, complete: true }],
      scannedAt: '2026-08-30T12:00:00.000Z',
    };
    const signers: unknown[][] = [];

    const transaction = await buildTransparentSend({
      sessionId: 'opaque-single-key-session',
      snapshot,
      toAddress: recipient.address,
      amountSats: BigInt(25_000_000),
      signPsbt: async (_sessionId, psbtBase64, requestedSigners) => {
        signers.push(requestedSigners);
        return wasm.invoke<{ psbtBase64: string }>('signPsbtWithPrivateKey', {
          privateKey,
          psbtBase64,
          signers: requestedSigners,
        });
      },
    });

    expect(signers).toEqual([
      [
        {
          txid: '44'.repeat(32),
          vout: 0,
          scriptType: 'p2wpkh',
          publicKeyCompressed: true,
        },
      ],
    ]);
    expect(JSON.stringify(signers)).not.toContain('path');
    expect(transaction.txid).toMatch(/^[0-9a-f]{64}$/u);
    expect(transaction.walletOutputs).toEqual([
      expect.objectContaining({ address: material.address }),
    ]);
  });

  it('signs one mixed transaction across all four scripts, both branches and account 1', async () => {
    const previous = new btc.Transaction({ allowUnknownInputs: true });
    previous.addOutput({
      script: hexBytes(legacy.scriptHex),
      amount: BigInt(25_000_000),
    });
    previous.addInput(
      {
        txid: '00'.repeat(32),
        index: 0xffff_ffff,
        sequence: 0xffff_ffff,
        finalScriptSig: Uint8Array.from([1, 0]),
      },
      true,
    );
    const definitions = [
      {
        material: legacy,
        account: 0 as const,
        accountKey: 'legacy' as const,
        accountPath: "m/44'/0'/0'",
        branch: 'external' as const,
        index: 0,
        txid: previous.id,
        rawTx: previous.hex,
      },
      {
        material: p2shHistorical,
        account: 1 as const,
        accountKey: 'p2sh' as const,
        accountPath: "m/49'/0'/1'",
        branch: 'external' as const,
        index: 0,
        txid: '33'.repeat(32),
      },
      {
        material: external,
        account: 0 as const,
        accountKey: 'bech32' as const,
        accountPath: "m/84'/0'/0'",
        branch: 'external' as const,
        index: 0,
        txid: '11'.repeat(32),
      },
      {
        material: taprootInternal,
        account: 0 as const,
        accountKey: 'taproot' as const,
        accountPath: "m/86'/0'/0'",
        branch: 'internal' as const,
        index: 1,
        txid: '22'.repeat(32),
      },
    ];
    const owners = definitions.map(
      (definition): ScannedAddress => ({
        ...definition.material,
        ownerKind: 'hd',
        account: definition.account,
        accountKey: definition.accountKey,
        accountLabel: definition.accountKey,
        accountPath: definition.accountPath,
        recoveryOnly: definition.account === 1,
        branch: definition.branch,
        index: definition.index,
        balance: {
          confirmedSats: 25_000_000,
          unconfirmedSats: 0,
          totalSats: 25_000_000,
        },
        utxos: [],
        history: [],
        used: true,
      }),
    );
    const utxos = definitions.map((definition, index) => ({
      txid: definition.txid,
      vout: 0,
      valueSats: 25_000_000,
      height: 100 + index,
      address: definition.material.address,
      confirmations: 12,
      isCoinbase: false,
      ...('rawTx' in definition ? { rawTx: definition.rawTx } : {}),
    }));
    owners.forEach((owner, index) => {
      owner.utxos = [utxos[index]!];
    });
    const change = scannedAddress(internal, 'internal', 0, 0);
    const snapshot: TransparentWalletSnapshot = {
      schemaVersion: 1,
      sourceKind: 'bip39-hd',
      scanMode: 'gap-with-recovery',
      confirmedSats: 100_000_000,
      unconfirmedSats: 0,
      balanceSats: 100_000_000,
      spendableSats: 100_000_000,
      immatureCoinbaseSats: 0,
      immatureCoinbaseBlocksRemaining: 0,
      utxos,
      history: [],
      addresses: [...owners, change],
      usedAddresses: owners,
      spendableAddresses: owners,
      gapLimit: 20,
      coverage: [],
      scannedAt: '2026-08-30T12:00:00.000Z',
    };
    const requestedSigners: unknown[][] = [];
    const transaction = await buildTransparentSend({
      sessionId: 'opaque-test-session',
      snapshot,
      toAddress: recipient.address,
      amountSats: BigInt(99_000_000),
      changeAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) => {
        requestedSigners.push(signers);
        return wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        });
      },
    });

    expect(transaction.inputCount).toBe(4);
    expect(
      new Set(
        (requestedSigners[0] as Array<{ scriptType: string }>).map(
          ({ scriptType }) => scriptType,
        ),
      ),
    ).toEqual(new Set(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr']));
    expect(JSON.stringify(requestedSigners)).toContain("m/49'/0'/1'/0/0");
    expect(JSON.stringify(requestedSigners)).toContain("m/86'/0'/0'/1/1");
    expect(transaction.txid).toMatch(/^[0-9a-f]{64}$/u);

    const replacement = await buildTransparentRbfCancellation({
      sessionId: 'opaque-test-session',
      snapshot,
      original: transaction,
      returnAddress: taprootInternal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        }),
    });
    expect(replacement.inputCount).toBe(4);
    expect(replacement.outputCount).toBe(1);
    expect(replacement.feeSats).toBeGreaterThan(transaction.feeSats);
    expect(replacement.walletInputs).toEqual(transaction.walletInputs);
    expect(replacement.walletOutputs).toEqual([
      expect.objectContaining({ address: taprootInternal.address }),
    ]);
  });

  it('mixes spendable UTXOs from external and internal branches', async () => {
    const snapshot = makeSnapshot();
    const internalOwner = snapshot.addresses[1]!;
    const secondUtxo = {
      txid: '22'.repeat(32),
      vout: 1,
      valueSats: 50_000_000,
      height: 101,
      address: internal.address,
      confirmations: 11,
      isCoinbase: false,
    };
    internalOwner.balance = {
      confirmedSats: 50_000_000,
      unconfirmedSats: 0,
      totalSats: 50_000_000,
    };
    internalOwner.utxos = [secondUtxo];
    internalOwner.used = true;
    snapshot.utxos.push(secondUtxo);

    const quote = await estimateTransparentMultiSend({
      snapshot,
      outputs: [
        { address: recipient.address, amountSats: BigInt(120_000_000) },
      ],
      changeAddress: internal.address,
    });

    expect(quote.fitsAvailable).toBe(true);
    expect(quote.inputCount).toBe(2);
  });

  it('requires HD change to be both owned and on an internal branch', async () => {
    const snapshot = makeSnapshot();
    await expect(
      estimateTransparentMultiSend({
        snapshot,
        outputs: [
          { address: recipient.address, amountSats: BigInt(25_000_000) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'change-address-unavailable' });
    await expect(
      estimateTransparentMultiSend({
        snapshot,
        outputs: [
          { address: recipient.address, amountSats: BigInt(25_000_000) },
        ],
        changeAddress: external.address,
      }),
    ).rejects.toMatchObject({ code: 'change-address-not-owned' });
  });

  it('rejects invalid recipients and unconfirmed-only funds before signing', async () => {
    const snapshot = makeSnapshot();
    await expect(
      estimateTransparentMultiSend({
        snapshot,
        outputs: [{ address: 'not-nito', amountSats: BigInt(25_000_000) }],
        changeAddress: internal.address,
      }),
    ).rejects.toMatchObject({ code: 'recipient-address-invalid' });
    snapshot.utxos[0]!.confirmations = 0;
    await expect(
      estimateTransparentMultiSend({
        snapshot,
        outputs: [
          { address: recipient.address, amountSats: BigInt(25_000_000) },
        ],
        changeAddress: internal.address,
      }),
    ).rejects.toMatchObject({ code: 'no-spendable-utxo' });
  });

  it('plans then signs a 21-input consolidation with the real WASM', async () => {
    const snapshot = makeSnapshot();
    const owner = snapshot.addresses[0]!;
    const utxos = Array.from({ length: 21 }, (_, index) => ({
      txid: (index + 1).toString(16).padStart(2, '0').repeat(32),
      vout: 0,
      valueSats: 1_000_000,
      height: 100 + index,
      address: owner.address,
      confirmations: 20,
      isCoinbase: false,
    }));
    snapshot.utxos = utxos;
    snapshot.confirmedSats = 21_000_000;
    snapshot.balanceSats = 21_000_000;
    snapshot.spendableSats = 21_000_000;
    owner.balance = {
      confirmedSats: 21_000_000,
      unconfirmedSats: 0,
      totalSats: 21_000_000,
    };
    owner.utxos = utxos;
    const plan = planTransparentConsolidation({
      snapshot,
      toAddress: internal.address,
    });

    expect(plan).toMatchObject({
      inputCount: 21,
      outputCount: 9,
      transactions: [{ inputCount: 21, outputCount: 9 }],
    });
    const prepared = await buildTransparentConsolidation({
      sessionId: 'opaque-test-session',
      snapshot,
      toAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke<{ psbtBase64: string }>('signPsbt', {
          mnemonic: MNEMONIC,
          psbtBase64,
          signers,
        }),
    });

    expect(prepared).toMatchObject({
      inputCount: 21,
      outputCount: 9,
      transactions: [{ inputCount: 21, outputCount: 9, changeUsed: false }],
    });
    expect(prepared.transactions[0]?.walletOutputs).toHaveLength(9);
  });

  it('does not count unconfirmed UTXOs toward the consolidation threshold', () => {
    const snapshot = makeSnapshot();
    const owner = snapshot.addresses[0]!;
    snapshot.utxos = Array.from({ length: 21 }, (_, index) => ({
      txid: (index + 1).toString(16).padStart(2, '0').repeat(32),
      vout: 0,
      valueSats: 1_000_000,
      height: 100 + index,
      address: owner.address,
      confirmations: index === 0 ? 0 : 20,
      isCoinbase: false,
    }));

    expect(() =>
      planTransparentConsolidation({
        snapshot,
        toAddress: internal.address,
      }),
    ).toThrow(
      expect.objectContaining({ code: 'consolidation-not-enough-utxos' }),
    );
  });
});
