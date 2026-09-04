import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import * as btc from '@scure/btc-signer';
import { beforeAll, describe, expect, it } from 'vitest';

import type { DerivedAddress, PrivateKeyInfo } from '../crypto/workerProtocol';
import { HD_ACCOUNT_TEMPLATES } from '../domain/wallet-policy';
import { changeAccountForWallet } from './changePolicy';
import { HdAddressManager } from './addressManager';
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
  buildTransparentMultiSend,
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
  ): Extract<ScannedAddress, { ownerKind: 'hd' }> => ({
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

  it.each([false, true])(
    'uses 0.1 instead of a large UTXO for a 0.09 payment (reverse order: %s)',
    async (reverse) => {
      const snapshot = makeSnapshot();
      snapshot.utxos = [
        { ...snapshot.utxos[0]!, valueSats: 10_000_000 },
        {
          ...snapshot.utxos[0]!,
          txid: '22'.repeat(32),
          valueSats: 204_950_654_564,
        },
      ];
      if (reverse) snapshot.utxos.reverse();
      const outputs = [
        { address: recipient.address, amountSats: BigInt(9_000_000) },
      ];
      const before = structuredClone(snapshot);
      const quote = await estimateTransparentMultiSend({
        snapshot,
        outputs,
        changeAddress: internal.address,
      });
      const signed = await buildTransparentMultiSend({
        sessionId: 'selection-test',
        snapshot,
        outputs,
        changeAddress: internal.address,
        signPsbt: async (_sessionId, psbtBase64, signers) =>
          wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
      });
      expect(signed.walletInputs).toEqual([
        expect.objectContaining({
          txid: '11'.repeat(32),
          valueSats: 10_000_000,
        }),
      ]);
      expect(signed.feeSats).toBe(282);
      expect(signed.feeSats).toBe(quote.feeSats);
      expect(signed.inputCount).toBe(quote.inputCount);
      expect(snapshot).toEqual(before);
    },
  );

  const selectionSnapshot = (
    values: number[],
    materials: DerivedAddress[] = [],
  ) => {
    const snapshot = makeSnapshot();
    snapshot.utxos = values.map((valueSats, index) => {
      const material = materials[index] ?? external;
      if (
        !snapshot.addresses.some(({ address }) => address === material.address)
      ) {
        snapshot.addresses.push(
          scannedAddress(
            material,
            material.path.split('/').at(-2) === '1' ? 'internal' : 'external',
            Number(material.path.split('/').at(-1)),
            valueSats,
          ),
        );
      }
      let txid = (index + 1).toString(16).padStart(64, '0');
      let rawTx: string | undefined;
      if (material.scriptType === 'p2pkh') {
        const previous = new btc.Transaction({ allowUnknownInputs: true });
        previous.addOutput({
          script: hexBytes(material.scriptHex),
          amount: BigInt(valueSats),
        });
        previous.addInput(
          {
            txid: '00'.repeat(32),
            index: 0xffff_ffff,
            sequence: 0xffff_ffff,
            finalScriptSig: Uint8Array.from([1, index]),
          },
          true,
        );
        txid = previous.id;
        rawTx = previous.hex;
      }
      return {
        ...snapshot.utxos[0]!,
        txid,
        rawTx,
        valueSats,
        address: material.address,
      };
    });
    snapshot.spendableSats = values.reduce((total, value) => total + value, 0);
    snapshot.confirmedSats = snapshot.spendableSats;
    snapshot.balanceSats = snapshot.spendableSats;
    return snapshot;
  };

  const signSelection = async (
    snapshot: TransparentWalletSnapshot,
    amounts = [BigInt(9_000_000)],
    feePerVbyte = BigInt(2),
    addresses: { toAddress?: string; changeAddress?: string } = {},
  ) => {
    const outputs = amounts.map((amountSats, index) => ({
      address:
        index === 0
          ? (addresses.toAddress ?? recipient.address)
          : legacy.address,
      amountSats,
    }));
    const args = {
      snapshot,
      outputs,
      changeAddress: addresses.changeAddress ?? internal.address,
      feePerVbyte,
    };
    const before = structuredClone(snapshot);
    const quote = await estimateTransparentMultiSend(args);
    const signed = await buildTransparentMultiSend({
      ...args,
      sessionId: 'selection-test',
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
    });
    expect(signed).toMatchObject({
      feeSats: quote.feeSats,
      inputCount: quote.inputCount,
      outputCount: quote.outputCount,
      changeUsed: quote.changeUsed,
    });
    const transaction = btc.Transaction.fromRaw(hexBytes(signed.hex));
    const inputTotal = signed.walletInputs.reduce(
      (sum, input) => sum + BigInt(input.valueSats),
      BigInt(0),
    );
    const outputTotal = Array.from(
      { length: transaction.outputsLength },
      (_, index) => transaction.getOutput(index).amount!,
    ).reduce((sum, amount) => sum + amount, BigInt(0));
    expect(inputTotal - outputTotal).toBe(BigInt(signed.feeSats));
    expect(BigInt(signed.feeSats)).toBeGreaterThanOrEqual(
      feePerVbyte * BigInt(transaction.vsize),
    );
    expect(
      new Set(signed.walletInputs.map(({ txid, vout }) => `${txid}:${vout}`))
        .size,
    ).toBe(signed.inputCount);
    expect(snapshot).toEqual(before);
    return signed;
  };

  it.each(HD_ACCOUNT_TEMPLATES)(
    'chooses the smallest sufficient $label UTXO with real WASM signing',
    async ({ scriptType, accountPath }) => {
      const [material] = wasm.invoke<DerivedAddress[]>('deriveAddresses', {
        mnemonic: MNEMONIC,
        requests: [{ path: `${accountPath}/0/0`, scriptType }],
      });
      const signed = await signSelection(
        selectionSnapshot(
          [10_000_000, 50_000_000, 20_000_000],
          [material, material, material],
        ),
      );
      expect(signed.walletInputs.map(({ valueSats }) => valueSats)).toEqual([
        10_000_000,
      ]);
    },
  );

  it.each([
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 1, 3, 0],
    [3, 0, 2, 1],
    [0, 3, 1, 2],
  ])(
    'anchors the margin to the cheapest quote without fee creep (order: %j)',
    async (...order) => {
      const values = [10_000_000, 20_000_000, 30_000_000, 40_000_000];
      const materials = [legacy, p2shHistorical, external, taprootInternal];
      const signed = await signSelection(
        selectionSnapshot(
          order.map((index) => values[index]!),
          order.map((index) => materials[index]!),
        ),
      );
      // Taproot costs 260, Bech32 282, P2SH 350 and Legacy 462 nitoshis.
      // The ceiling stays 325, not 352 after considering Bech32.
      expect(signed.walletInputs).toEqual([
        expect.objectContaining({
          address: external.address,
          valueSats: 30_000_000,
        }),
      ]);
      expect(signed.feeSats).toBe(282);
    },
  );

  it.each([false, true])(
    'spends 0.1 P2SH instead of 2049 Taproot for a 0.09 Taproot payment within the fee margin (reverse: %s)',
    async (reverse) => {
      const snapshot = selectionSnapshot(
        [10_000_000, 204_941_654_188, 10_000_000, 9_000_000],
        [p2shHistorical, taprootInternal, legacy, taprootInternal],
      );
      if (reverse) snapshot.utxos.reverse();
      const addresses = {
        toAddress: taprootInternal.address,
        changeAddress: taprootInternal.address,
      };
      const cheapest = await signSelection(
        selectionSnapshot([204_941_654_188], [taprootInternal]),
        undefined,
        undefined,
        addresses,
      );
      expect(cheapest.feeSats).toBe(308);
      const signed = await signSelection(
        snapshot,
        undefined,
        undefined,
        addresses,
      );
      expect(signed.walletInputs).toEqual([
        expect.objectContaining({
          address: p2shHistorical.address,
          valueSats: 10_000_000,
        }),
      ]);
      expect(signed.feeSats).toBe(376);
      expect(signed.feeSats - cheapest.feeSats).toBe(68);
    },
  );

  it.each([352, 353])(
    'enforces the rounded-down 25 percent ceiling including discarded dust (fee: %s)',
    async (fee) => {
      const signed = await signSelection(
        selectionSnapshot([9_000_000 + fee, 10_000_000]),
      );
      // Cheapest quote: 282. floor(282 * 25%) = 70. 352 fits, 353 does not.
      expect(signed.walletInputs[0]!.valueSats).toBe(
        fee === 352 ? 9_000_352 : 10_000_000,
      );
      expect(signed.feeSats).toBe(fee === 352 ? 352 : 282);
      expect(signed.changeUsed).toBe(fee !== 352);
    },
  );

  it.each([29, 30])(
    'caps the premium at 1000 nitoshis when fees rise (rate: %s)',
    async (rate) => {
      const snapshot = selectionSnapshot(
        [10_000_000, 100_000_000],
        [p2shHistorical, taprootInternal],
      );
      const signed = await signSelection(snapshot, undefined, BigInt(rate), {
        toAddress: taprootInternal.address,
        changeAddress: taprootInternal.address,
      });
      // Both fit the relative margin; the P2SH premium is 986 or 1020 nitoshis.
      expect(signed.walletInputs[0]!.valueSats).toBe(
        rate === 29 ? 10_000_000 : 100_000_000,
      );
      expect(signed.feeSats).toBe(rate * (rate === 29 ? 188 : 154));
    },
  );

  it('does not pay a premium when both inputs contain the same amount', async () => {
    const snapshot = selectionSnapshot(
      [10_000_000, 10_000_000],
      [p2shHistorical, taprootInternal],
    );
    const signed = await signSelection(snapshot, undefined, undefined, {
      toAddress: taprootInternal.address,
      changeAddress: taprootInternal.address,
    });
    expect(signed.walletInputs[0]!.address).toBe(taprootInternal.address);
    expect(signed.feeSats).toBe(308);
  });

  it('does not spend more funds at a premium just to reduce input count', async () => {
    const signed = await signSelection(
      selectionSnapshot(
        [4_500_000, 4_500_400, 100_000_000],
        [external, external, legacy],
      ),
    );
    expect(signed.inputCount).toBe(2);
    expect(signed.feeSats).toBe(400);
    expect(signed.changeUsed).toBe(false);
  });

  it('preserves mixed-family MAX and the RBF inputs after selecting with a margin', async () => {
    const snapshot = selectionSnapshot(
      [10_000_000, 100_000_000],
      [p2shHistorical, taprootInternal],
    );
    const addresses = {
      toAddress: taprootInternal.address,
      changeAddress: taprootInternal.address,
    };
    const max = await calculateMaxTransparentSendAmount({
      snapshot,
      ...addresses,
    });
    const maximum = await signSelection(
      snapshot,
      [max.amountSats],
      undefined,
      addresses,
    );
    expect(maximum.inputCount).toBe(2);
    expect(max.amountSats + BigInt(maximum.feeSats)).toBe(BigInt(110_000_000));
    const original = await signSelection(
      snapshot,
      undefined,
      undefined,
      addresses,
    );
    expect(original.walletInputs[0]!.address).toBe(p2shHistorical.address);
    const replacement = await buildTransparentRbfCancellation({
      sessionId: 'selection-test',
      snapshot,
      original,
      returnAddress: taprootInternal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
    });
    expect(replacement.walletInputs).toEqual(original.walletInputs);
  });

  it('does not accumulate small UTXOs when one input has a lower fee', async () => {
    const signed = await signSelection(
      selectionSnapshot([3_000_000, 3_000_000, 3_000_500, 100_000_000]),
    );
    expect(signed.inputCount).toBe(1);
    expect(signed.walletInputs[0]!.valueSats).toBe(100_000_000);
  });

  it('keeps a lower-fee exact match instead of creating unnecessary change', async () => {
    const signed = await signSelection(
      selectionSnapshot([9_000_220, 10_000_000, 100_000_000]),
    );
    expect(signed.walletInputs[0]!.valueSats).toBe(9_000_220);
    expect(signed.feeSats).toBe(220);
    expect(signed.changeUsed).toBe(false);
  });

  it('counts discarded dust as fees rather than favoring an expensive near match', async () => {
    const signed = await signSelection(
      selectionSnapshot([9_000_600, 10_000_000, 100_000_000]),
    );
    expect(signed.walletInputs[0]!.valueSats).toBe(10_000_000);
    expect(signed.feeSats).toBe(282);
    expect(signed.changeUsed).toBe(true);
  });

  it('prefers fewer inputs when actual fees tie, even if they create change', async () => {
    const single = await signSelection(
      selectionSnapshot([100_000_000], [legacy]),
    );
    const pairValues = [4_500_000, 4_500_000 + single.feeSats];
    const pair = await signSelection(selectionSnapshot(pairValues));
    expect(pair.inputCount).toBe(2);
    expect(pair.feeSats).toBe(single.feeSats);
    expect(pair.changeUsed).toBe(false);
    const signed = await signSelection(
      selectionSnapshot(
        [...pairValues, 100_000_000],
        [external, external, legacy],
      ),
    );
    expect(signed.inputCount).toBe(1);
    expect(signed.feeSats).toBe(single.feeSats);
    expect(signed.changeUsed).toBe(true);
  });

  it('requires the small input to cover all recipients and their fees', async () => {
    const signed = await signSelection(
      selectionSnapshot([8_000_000, 10_000_000, 100_000_000]),
      [BigInt(4_000_000), BigInt(5_000_000)],
    );
    expect(signed.walletInputs[0]!.valueSats).toBe(10_000_000);
    expect(signed.recipients).toHaveLength(2);
  });

  it('uses a sufficient larger input when the fee rate makes the smaller one insufficient', async () => {
    const signed = await signSelection(
      selectionSnapshot([9_000_220, 10_000_000, 100_000_000]),
      undefined,
      BigInt(1_000),
    );
    expect(signed.walletInputs[0]!.valueSats).toBe(10_000_000);
  });

  it('still combines inputs when no single UTXO can fund the payment', async () => {
    const signed = await signSelection(
      selectionSnapshot([6_000_000, 5_000_000, 1_000_000]),
    );
    expect(signed.inputCount).toBe(2);
    expect(signed.walletInputs.map(({ valueSats }) => valueSats)).toEqual([
      6_000_000, 5_000_000,
    ]);
  });

  it('never selects pending or immature inputs just because they are smaller', async () => {
    const snapshot = selectionSnapshot([
      10_000_000, 11_000_000, 12_000_000, 100_000_000,
    ]);
    snapshot.utxos[0]!.confirmations = 0;
    snapshot.utxos[1]!.isCoinbase = true;
    snapshot.utxos[1]!.confirmations = 100;
    snapshot.utxos[2]!.isCoinbase = true;
    snapshot.utxos[2]!.confirmations = 101;
    const signed = await signSelection(snapshot);
    expect(signed.walletInputs[0]!.valueSats).toBe(12_000_000);
  });

  it('retains MAX across multiple UTXOs and preserves the selected inputs for RBF', async () => {
    const snapshot = selectionSnapshot([10_000_000, 100_000_000]);
    const max = await calculateMaxTransparentSendAmount({
      snapshot,
      toAddress: recipient.address,
      changeAddress: internal.address,
    });
    const signed = await signSelection(snapshot, [max.amountSats]);
    expect(signed.inputCount).toBe(2);
    expect(signed.changeUsed).toBe(false);
    expect(max.amountSats + BigInt(signed.feeSats)).toBe(BigInt(110_000_000));
    const original = await signSelection(snapshot);
    expect(original.walletInputs[0]!.valueSats).toBe(10_000_000);
    const replacement = await buildTransparentRbfCancellation({
      sessionId: 'selection-test',
      snapshot,
      original,
      returnAddress: internal.address,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
    });
    expect(replacement.walletInputs).toEqual(original.walletInputs);
  });

  it('preserves multi-recipient MAX with the improved selection', async () => {
    const snapshot = selectionSnapshot([10_000_000, 100_000_000]);
    const max = await calculateMaxTransparentSendAmount({
      snapshot,
      changeAddress: internal.address,
      targetIndex: 1,
      outputs: [
        { address: recipient.address, amountSats: BigInt(9_000_000) },
        { address: legacy.address, amountSats: BigInt(0) },
      ],
    });
    const signed = await signSelection(snapshot, [
      BigInt(9_000_000),
      max.amountSats,
    ]);
    expect(signed.inputCount).toBe(2);
    expect(signed.changeUsed).toBe(false);
    expect(max.amountSats + BigInt(9_000_000 + signed.feeSats)).toBe(
      BigInt(110_000_000),
    );
  });

  it('breaks equivalent candidate ties by outpoint regardless of scan order', async () => {
    const snapshot = selectionSnapshot([10_000_000, 10_000_000, 100_000_000]);
    snapshot.utxos[1]!.txid = snapshot.utxos[0]!.txid;
    snapshot.utxos[1]!.vout = 1;
    const first = await signSelection(snapshot);
    snapshot.utxos.reverse();
    const second = await signSelection(snapshot);
    expect(first.walletInputs[0]!.vout).toBe(0);
    expect(second.walletInputs).toEqual(first.walletInputs);
    expect(second.hex).toBe(first.hex);
  });

  it('does not sign when the balance cannot cover the requested amount and fee', async () => {
    const snapshot = selectionSnapshot([4_500_000, 4_500_000]);
    let signingCalls = 0;
    await expect(
      buildTransparentSend({
        sessionId: 'selection-test',
        snapshot,
        toAddress: recipient.address,
        amountSats: BigInt(9_000_000),
        changeAddress: internal.address,
        signPsbt: async (_sessionId, psbtBase64) => {
          signingCalls += 1;
          return { psbtBase64 };
        },
      }),
    ).rejects.toMatchObject({ code: 'insufficient-funds' });
    expect(signingCalls).toBe(0);
  });

  it('keeps a bounded search with 1400 individually sufficient UTXOs', async () => {
    const snapshot = selectionSnapshot(
      Array.from({ length: 1400 }, (_, index) => 10_000_000 + index * 100_000),
    );
    const signed = await signSelection(snapshot);
    expect(signed.walletInputs[0]!.valueSats).toBe(10_000_000);
    expect(signed.inputCount).toBe(1);
  });

  it.each(HD_ACCOUNT_TEMPLATES)(
    'quotes, signs and recovers automatic $label change using real WASM',
    async (template) => {
      const [payee] = wasm.invoke<DerivedAddress[]>('deriveAddresses', {
        mnemonic: MNEMONIC,
        requests: [
          {
            path: `${template.accountPath}/0/2`,
            scriptType: template.scriptType,
          },
        ],
      });
      const outputs = [
        { address: payee.address, amountSats: BigInt(25_000_000) },
      ];
      const accountKey = changeAccountForWallet(
        outputs.map(({ address }) => address),
        { hd: true, primaryAddresses: [] },
      );
      const manager = new HdAddressManager(
        'change-test',
        async (_sessionId, requests) =>
          wasm.invoke('deriveAddresses', { mnemonic: MNEMONIC, requests }),
      );
      const sequence = {
        account: 0 as const,
        accountKey,
        branch: 'internal' as const,
      };
      const snapshot = makeSnapshot();
      const change = await manager.currentOrReserve(
        sequence,
        snapshot.addresses,
      );
      expect(change.path).toBe(`${template.accountPath}/1/0`);
      expect(change.scriptType).toBe(template.scriptType);
      const owner: ScannedAddress = {
        ...scannedAddress(change, 'internal', 0, 0),
        accountKey,
        accountPath: template.accountPath,
        accountLabel: template.label,
      };
      snapshot.addresses = snapshot.addresses
        .filter(({ address }) => address !== change.address)
        .concat(owner);
      const quote = await estimateTransparentMultiSend({
        snapshot,
        outputs,
        changeAddress: change.address,
      });
      // Reopening an unsigned preview must not burn a fresh index.
      expect(
        await manager.currentOrReserve(sequence, snapshot.addresses),
      ).toEqual(change);
      const signed = await buildTransparentMultiSend({
        sessionId: 'change-test',
        snapshot,
        outputs,
        changeAddress: change.address,
        signPsbt: async (_sessionId, psbtBase64, signers) =>
          wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
      });
      expect(signed).toMatchObject({
        feeSats: quote.feeSats,
        outputCount: quote.outputCount,
        changeUsed: true,
      });
      const transaction = btc.Transaction.fromRaw(hexBytes(signed.hex));
      const returnOutput = signed.walletOutputs.find(
        ({ address }) => address === change.address,
      )!;
      expect(returnOutput).toBeDefined();
      expect(transaction.getOutput(returnOutput.vout).script).toEqual(
        hexBytes(change.scriptHex),
      );
      expect(returnOutput.valueSats + signed.feeSats + 25_000_000).toBe(
        100_000_000,
      );
      const max = await calculateMaxTransparentSendAmount({
        snapshot,
        outputs,
        targetIndex: 0,
        changeAddress: change.address,
      });
      expect(max.amountSats + BigInt(max.feeSats)).toBe(BigInt(100_000_000));
      expect(max.changeUsed).toBe(false);
      // Once the change has appeared in history, the next payment uses index 1.
      owner.used = true;
      expect(
        await manager.currentOrReserve(sequence, snapshot.addresses),
      ).toMatchObject({ path: `${template.accountPath}/1/1`, index: 1 });
      // A restored session derives exactly the same internal public material.
      const restored = new HdAddressManager(
        'restored-session',
        async (_sessionId, requests) =>
          wasm.invoke('deriveAddresses', { mnemonic: MNEMONIC, requests }),
      );
      expect(await restored.currentOrReserve(sequence, [])).toMatchObject({
        address: change.address,
        scriptHex: change.scriptHex,
      });
    },
  );

  it('signs a mixed-family payment with the same automatic change as its unsigned preview', async () => {
    const payees = wasm.invoke<DerivedAddress[]>('deriveAddresses', {
      mnemonic: MNEMONIC,
      requests: HD_ACCOUNT_TEMPLATES.map((template) => ({
        path: `${template.accountPath}/0/2`,
        scriptType: template.scriptType,
      })),
    });
    const outputs = payees.map(({ address }) => ({
      address,
      amountSats: BigInt(10_000_000),
    }));
    expect(
      changeAccountForWallet(
        outputs.map(({ address }) => address),
        { hd: true, primaryAddresses: [] },
      ),
    ).toBe('taproot');
    const snapshot = makeSnapshot();
    snapshot.addresses.push({
      ...scannedAddress(taprootInternal, 'internal', 1, 0),
      accountKey: 'taproot',
      accountPath: "m/86'/0'/0'",
      accountLabel: 'Taproot',
    });
    const changeAddress = taprootInternal.address;
    const quote = await estimateTransparentMultiSend({
      snapshot,
      outputs,
      changeAddress,
    });
    const signed = await buildTransparentMultiSend({
      sessionId: 'mixed-change-test',
      snapshot,
      outputs,
      changeAddress,
      signPsbt: async (_sessionId, psbtBase64, signers) =>
        wasm.invoke('signPsbt', { mnemonic: MNEMONIC, psbtBase64, signers }),
    });
    expect(signed).toMatchObject({
      feeSats: quote.feeSats,
      outputCount: 5,
      changeUsed: true,
    });
    expect(signed.walletOutputs).toEqual([
      expect.objectContaining({ address: changeAddress }),
    ]);
    const decoded = btc.Transaction.fromRaw(hexBytes(signed.hex));
    expect(
      Array.from(
        { length: decoded.outputsLength },
        (_, index) => decoded.getOutput(index).script,
      ),
    ).toEqual(
      expect.arrayContaining(
        [...payees, taprootInternal].map(({ scriptHex }) =>
          hexBytes(scriptHex),
        ),
      ),
    );
  });

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
