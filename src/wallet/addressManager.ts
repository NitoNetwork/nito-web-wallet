import type { DerivedAddress } from '../crypto/workerProtocol';
import {
  deriveHdPath,
  HD_ACCOUNT_TEMPLATES,
  LEGACY_ACCOUNT_ONE_TEMPLATES,
  type HdAddressSequence,
  type HdScanRequirement,
} from '../domain/wallet-policy';
import { scriptPubKeyForNitoAddress } from '../network/electrum';
import type { HdAddressDeriver, ScannedAddress } from './transparentScan';

export type IssuedHdAddress = HdAddressSequence & { index: number } & DerivedAddress;

const ALL_TEMPLATES = [...HD_ACCOUNT_TEMPLATES, ...LEGACY_ACCOUNT_ONE_TEMPLATES];
const isHex = (value: string) => value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/iu.test(value);
const bytesToHex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');

const sequenceId = (sequence: HdAddressSequence) =>
  `${sequence.account}:${sequence.accountKey}:${sequence.branch}`;

const templateFor = (sequence: HdAddressSequence) => {
  const accountPathSuffix = `/${sequence.account}'`;
  const template = ALL_TEMPLATES.find(
    (candidate) =>
      candidate.key === sequence.accountKey &&
      candidate.accountPath.endsWith(accountPathSuffix),
  );
  if (!template) throw new Error('Unsupported HD address sequence.');
  return template;
};

const lastUsedIndex = (
  addresses: readonly ScannedAddress[],
  sequence: HdAddressSequence,
) => addresses.reduce(
  (highest, address) =>
    address.ownerKind === 'hd' &&
    address.account === sequence.account &&
    address.accountKey === sequence.accountKey &&
    address.branch === sequence.branch &&
    address.used
      ? Math.max(highest, address.index)
      : highest,
  -1,
);

const knownAddressAtIndex = (
  addresses: readonly ScannedAddress[],
  sequence: HdAddressSequence,
  index: number,
): Extract<ScannedAddress, { ownerKind: 'hd' }> | undefined => addresses.find(
  (address): address is Extract<ScannedAddress, { ownerKind: 'hd' }> =>
    address.ownerKind === 'hd' &&
    address.account === sequence.account &&
    address.accountKey === sequence.accountKey &&
    address.branch === sequence.branch &&
    address.index === index,
);

const validateDerivedAddress = (
  derived: readonly DerivedAddress[],
  expectedPath: string,
  expectedScriptType: DerivedAddress['scriptType'],
) => {
  if (derived.length !== 1) throw new Error('Address derivation returned a partial batch.');
  const address = derived[0];
  if (
    !address ||
    address.path !== expectedPath ||
    address.scriptType !== expectedScriptType ||
    address.address.trim() === '' ||
    !isHex(address.publicKeyHex) ||
    !isHex(address.scriptHex) ||
    bytesToHex(scriptPubKeyForNitoAddress(address.address)) !== address.scriptHex.toLowerCase()
  ) {
    throw new Error('Address derivation returned inconsistent public material.');
  }
  return address;
};

/** Current-page receive/change allocation. Locking or closing destroys it. */
export class HdAddressManager {
  private readonly issued = new Map<string, IssuedHdAddress>();

  constructor(
    private readonly sessionId: string,
    private readonly deriveAddresses: HdAddressDeriver,
  ) {}

  scanRequirements = async (): Promise<HdScanRequirement[]> =>
    [...this.issued.values()].map(({ account, accountKey, branch, index }) => ({
      account,
      accountKey,
      branch,
      highestIssuedIndex: index,
    }));

  /**
   * Address shown when a receive family is opened. The first display is always
   * index zero; an address explicitly requested later remains selected for the
   * lifetime of this in-memory session.
   */
  async currentOrPrimary(
    sequence: HdAddressSequence,
    knownAddresses: readonly ScannedAddress[],
  ): Promise<IssuedHdAddress> {
    const current = this.issued.get(sequenceId(sequence));
    if (current) return current;
    return this.deriveOrReuseKnown(sequence, 0, knownAddresses);
  }

  async currentOrReserve(
    sequence: HdAddressSequence,
    knownAddresses: readonly ScannedAddress[],
  ): Promise<IssuedHdAddress> {
    const current = this.issued.get(sequenceId(sequence));
    const usedThrough = lastUsedIndex(knownAddresses, sequence);
    if (current && current.index > usedThrough) return current;
    return this.deriveOrReuseKnown(sequence, usedThrough + 1, knownAddresses);
  }

  async reserveNew(
    sequence: HdAddressSequence,
    knownAddresses: readonly ScannedAddress[],
  ): Promise<IssuedHdAddress> {
    const current = this.issued.get(sequenceId(sequence));
    const index = Math.max(
      lastUsedIndex(knownAddresses, sequence) + 1,
      (current?.index ?? -1) + 1,
    );
    return this.deriveOrReuseKnown(sequence, index, knownAddresses);
  }

  private async deriveOrReuseKnown(
    sequence: HdAddressSequence,
    index: number,
    knownAddresses: readonly ScannedAddress[],
  ): Promise<IssuedHdAddress> {
    const template = templateFor(sequence);
    const path = deriveHdPath(template, sequence.branch, index);
    const known = knownAddressAtIndex(knownAddresses, sequence, index);
    if (known) {
      const issued = {
        ...sequence,
        index,
        ...validateDerivedAddress([known], path, template.scriptType),
      };
      this.issued.set(sequenceId(sequence), issued);
      return issued;
    }
    return this.deriveAndRemember(sequence, index);
  }

  private async deriveAndRemember(
    sequence: HdAddressSequence,
    index: number,
  ): Promise<IssuedHdAddress> {
    const template = templateFor(sequence);
    const path = deriveHdPath(template, sequence.branch, index);
    const derived = await this.deriveAddresses(this.sessionId, [
      { path, scriptType: template.scriptType },
    ]);
    const issued = {
      ...sequence,
      index,
      ...validateDerivedAddress(derived, path, template.scriptType),
    };
    this.issued.set(sequenceId(sequence), issued);
    return issued;
  }
}
