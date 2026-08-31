'use client';

import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Copy,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  House,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Image from 'next/image';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/info-tip';
import { RecoveryPhraseCopy } from '@/components/recovery-phrase-copy';
import type { WalletSessionSummary } from '@/src/crypto/workerProtocol';
import {
  DEFAULT_HD_RECEIVE_ACCOUNT_KEY,
  HD_ACCOUNT_TEMPLATES,
  offersRecoveryPhraseInSettings,
  type HdAccountKey,
  type HdAddressSequence,
  type HdBranch,
} from '@/src/domain/wallet-policy';
import { useI18n, type TranslationKey, type Translator } from '@/src/i18n';
import { translateNetworkError, translateWalletError } from '@/src/i18nError';
import { nitoTransactionExplorerUrl } from '@/src/network/explorer';
import {
  AUTO_LOCK_MINUTE_OPTIONS,
  BACKGROUND_LOCK_SECOND_OPTIONS,
  isAutoLockMinutes,
  isBackgroundLockSeconds,
  type AutoLockMinutes,
  type BackgroundLockSeconds,
} from '@/src/security/sessionPolicy';
import {
  WalletNetworkController,
  type WalletNetworkState,
} from '@/src/services/walletNetworkController';
import { createAddressQr } from '@/src/ui/addressQr';
import { formatNitoAmount } from '@/src/ui/formatNito';
import {
  manualSyncAvailableAt,
  manualSyncSecondsRemaining,
} from '@/src/ui/manualSyncPolicy';
import { revealWalletStep } from '@/src/ui/revealWalletStep';
import { useAutoDismiss } from '@/src/ui/useAutoDismiss';
import {
  HdAddressManager,
  type IssuedHdAddress,
} from '@/src/wallet/addressManager';
import { isTransparentUtxoSpendable } from '@/src/wallet/coinbaseMaturity';
import { shouldOfferMaxForRecipient } from '@/src/wallet/sendRecipientPolicy';
import {
  acceptedTransactionAddresses,
  walletTransactionIsUnconfirmed,
  type AcceptedTransparentTransaction,
} from '@/src/wallet/transparentBroadcast';
import type {
  HdAddressDeriver,
  TransparentWalletSnapshot,
} from '@/src/wallet/transparentScan';
import {
  assertTransparentSendFitsAvailable,
  addRbfNetworkFeeMargin,
  buildTransparentConsolidation,
  buildTransparentMultiSend,
  buildTransparentRbfCancellation,
  calculateMaxTransparentSendAmount,
  DEFAULT_FEE_PER_VBYTE,
  estimateTransparentRbfCancellation,
  estimateTransparentMultiSend,
  MAX_SEND_RECIPIENTS,
  parseNitoAmountToSats,
  planTransparentConsolidation,
  TransparentSendError,
  type PreparedTransparentSend,
  type PreparedTransparentConsolidation,
  type TransparentRbfCancellationQuote,
  type TransparentPsbtSigner,
  type TransparentSendEstimate,
  type TransparentSendOutput,
  type TransparentConsolidationPlan,
} from '@/src/wallet/transparentSend';

const INPUT_CLASS =
  'mt-2 min-h-12 w-full rounded-2xl border border-sky-200/[0.12] bg-[#050d1a] px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 placeholder:text-slate-600 hover:border-sky-200/20 hover:bg-[#07111f] focus:border-sky-300/55 focus:ring-4 focus:ring-sky-300/10';
const ACCOUNT_ZERO_EXTERNAL: Omit<HdAddressSequence, 'accountKey'> = {
  account: 0,
  branch: 'external',
};
const DISCONNECTED_SESSION_LOCK_DELAY_MS = 15_000;
type WalletDashboardProps = {
  summary: WalletSessionSummary;
  autoLockMinutes: AutoLockMinutes;
  backgroundLockSeconds: BackgroundLockSeconds;
  deriveAddresses: HdAddressDeriver;
  signPsbt: TransparentPsbtSigner;
  revealMnemonic: MnemonicReveal;
  onAutoLockMinutesChange: (minutes: AutoLockMinutes) => void;
  onBackgroundLockSecondsChange: (seconds: BackgroundLockSeconds) => void;
  onLock: () => void | Promise<void>;
};

export type MnemonicReveal = (
  password?: string,
) => Promise<{ mnemonic: string; wordCount: 12 | 24 }>;

type RecipientDraft = {
  id: number;
  address: string;
  amount: string;
};

type SendPreview = {
  outputs: TransparentSendOutput[];
  estimate: TransparentSendEstimate;
  feePerVbyte: bigint;
  changeAddress: string;
  scannedAt: string;
};

type ConsolidationPreview = {
  plan: TransparentConsolidationPlan;
  feePerVbyte: bigint;
  changeAddress: string;
  scannedAt: string;
};

type BroadcastReceipt = {
  txid: string;
  watchAddresses: string[];
  replacementOf?: string;
  rbf?: {
    original: PreparedTransparentSend;
    sourceSnapshot: TransparentWalletSnapshot;
    returnAddress: string;
  };
};

type WalletView = 'home' | 'receive' | 'send' | 'settings';

const satsToInputAmount = (sats: bigint) => {
  const whole = sats / BigInt(100_000_000);
  const fraction = (sats % BigInt(100_000_000))
    .toString()
    .padStart(8, '0')
    .replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

const sourceLabelKey = (summary: WalletSessionSummary): TranslationKey => {
  if (summary.source === 'bip39-hd') return 'wallet.bip39';
  if (summary.source === 'email-credentials') return 'wallet.email';
  return 'wallet.privateKey';
};

const familyFor = (key: HdAccountKey) =>
  HD_ACCOUNT_TEMPLATES.find((template) => template.key === key)!;

const defaultFamilyFor = (summary: WalletSessionSummary): HdAccountKey => {
  if (summary.hd) return DEFAULT_HD_RECEIVE_ACCOUNT_KEY;
  if (
    summary.primaryAddresses.some((address) => address.scriptType === 'p2wpkh')
  ) {
    return 'bech32';
  }
  const scriptType = summary.primaryAddresses[0]?.scriptType;
  return (
    HD_ACCOUNT_TEMPLATES.find((template) => template.scriptType === scriptType)
      ?.key ?? 'legacy'
  );
};

const networkTone = (state?: WalletNetworkState) => {
  if (
    state?.record?.status === 'fresh' &&
    (state.status === 'ready' || state.status === 'scanning')
  ) {
    return 'bg-emerald-300 text-slate-950';
  }
  if (state?.status === 'stale' || state?.status === 'error') {
    return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
  }
  return 'border-sky-300/25 bg-sky-300/10 text-sky-100';
};

const networkLabel = (state: WalletNetworkState | undefined, t: Translator) => {
  if (!state || state.status === 'idle') return t('network.initializing');
  if (state.status === 'connecting') return t('network.connecting');
  if (state.status === 'scanning' && state.record?.status === 'fresh')
    return t('wallet.synced');
  if (state.status === 'scanning') return t('network.scanning');
  if (state.status === 'ready') return t('wallet.synced');
  if (state.status === 'stale') return t('network.stale');
  return t('network.unavailable');
};

export function WalletDashboard({
  summary,
  autoLockMinutes,
  backgroundLockSeconds,
  deriveAddresses,
  signPsbt,
  revealMnemonic,
  onAutoLockMinutesChange,
  onBackgroundLockSecondsChange,
  onLock,
}: WalletDashboardProps) {
  const { t } = useI18n();
  const translatorRef = useRef(t);
  const [activeView, setActiveView] = useState<WalletView>('home');
  const [network, setNetwork] = useState<WalletNetworkState>();
  const [selectedFamily, setSelectedFamily] = useState<HdAccountKey>(() =>
    defaultFamilyFor(summary),
  );
  const [issuedAddress, setIssuedAddress] = useState<IssuedHdAddress>();
  const [addressBusy, setAddressBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [feeRate, setFeeRate] = useState(DEFAULT_FEE_PER_VBYTE.toString());
  const [customFeeEnabled, setCustomFeeEnabled] = useState(false);
  const [recipients, setRecipients] = useState<RecipientDraft[]>([
    { id: 1, address: '', amount: '' },
  ]);
  const [sendPreview, setSendPreview] = useState<SendPreview>();
  const [preparedSend, setPreparedSend] = useState<PreparedTransparentSend>();
  const [consolidationPreview, setConsolidationPreview] =
    useState<ConsolidationPreview>();
  const [preparedConsolidation, setPreparedConsolidation] =
    useState<PreparedTransparentConsolidation>();
  const [broadcastedConsolidationTxids, setBroadcastedConsolidationTxids] =
    useState<string[]>([]);
  const [revealedMnemonic, setRevealedMnemonic] = useState<{
    mnemonic: string;
    wordCount: 12 | 24;
  }>();
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string>();
  const [backupPassword, setBackupPassword] = useState('');
  const [backupPasswordVisible, setBackupPasswordVisible] = useState(false);
  const [backupRevealRequested, setBackupRevealRequested] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [manualSyncInProgress, setManualSyncInProgress] = useState(false);
  const [manualSyncCooldownOpen, setManualSyncCooldownOpen] = useState(false);
  const [manualSyncCooldownSeconds, setManualSyncCooldownSeconds] = useState(0);
  const [broadcastReceipt, setBroadcastReceipt] = useState<BroadcastReceipt>();
  const [rbfQuote, setRbfQuote] = useState<TransparentRbfCancellationQuote>();
  const [rbfBusy, setRbfBusy] = useState(false);
  const [rbfError, setRbfError] = useState<string>();
  const closeBroadcastDialog = useCallback(() => {
    setBroadcastReceipt(undefined);
    setRbfQuote(undefined);
    setRbfError(undefined);
  }, []);
  const controllerRef = useRef<WalletNetworkController | undefined>(undefined);
  const manualSyncAvailableAtRef = useRef(0);
  const addressManagerRef = useRef<HdAddressManager | undefined>(undefined);
  const addressOperationRef = useRef(0);
  const nextRecipientIdRef = useRef(2);
  const recipientAddressRefs = useRef<Record<number, HTMLInputElement | null>>(
    {},
  );
  const pendingRecipientFocusRef = useRef<number | undefined>(undefined);
  const sendPreviewButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendSignButtonRef = useRef<HTMLButtonElement | null>(null);
  const sendBroadcastButtonRef = useRef<HTMLButtonElement | null>(null);
  const consolidationSignButtonRef = useRef<HTMLButtonElement | null>(null);
  const consolidationBroadcastButtonRef = useRef<HTMLButtonElement | null>(
    null,
  );
  const sendErrorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!revealedMnemonic) return;
    const timer = setTimeout(() => {
      setRevealedMnemonic(undefined);
      setBackupRevealRequested(false);
      setBackupPassword('');
      setBackupPasswordVisible(false);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [revealedMnemonic]);

  useAutoDismiss(notice, setNotice);

  useEffect(() => {
    if (!manualSyncCooldownOpen) return;
    const updateCountdown = () => {
      setManualSyncCooldownSeconds(
        manualSyncSecondsRemaining(manualSyncAvailableAtRef.current),
      );
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [manualSyncCooldownOpen]);

  useEffect(() => {
    translatorRef.current = t;
  }, [t]);

  useEffect(() => {
    if (network?.record?.staleReason !== 'connection-lost') return;
    const timer = window.setTimeout(() => {
      void onLock();
    }, DISCONNECTED_SESSION_LOCK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [network?.record?.staleReason, onLock]);

  useEffect(() => {
    const target =
      activeView === 'send'
        ? preparedSend
          ? sendBroadcastButtonRef.current
          : sendPreview
            ? sendSignButtonRef.current
            : null
        : activeView === 'home'
          ? preparedConsolidation
            ? consolidationBroadcastButtonRef.current
            : consolidationPreview
              ? consolidationSignButtonRef.current
              : null
          : null;
    if (!target) return;

    const frame = window.requestAnimationFrame(() => {
      revealWalletStep(target);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeView,
    consolidationPreview,
    preparedConsolidation,
    preparedSend,
    sendPreview,
  ]);

  useEffect(() => {
    if ((activeView !== 'send' && activeView !== 'home') || !sendError) return;

    const frame = window.requestAnimationFrame(() => {
      revealWalletStep(sendErrorRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, sendError]);

  useEffect(() => {
    const recipientId = pendingRecipientFocusRef.current;
    if (recipientId === undefined) return;
    pendingRecipientFocusRef.current = undefined;

    const frame = window.requestAnimationFrame(() => {
      revealWalletStep(recipientAddressRefs.current[recipientId]);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [recipients.length]);

  useEffect(() => {
    let active = true;
    const controller = new WalletNetworkController();
    const addressManager = summary.hd
      ? new HdAddressManager(summary.sessionId, deriveAddresses)
      : undefined;
    controllerRef.current = controller;
    addressManagerRef.current = addressManager;
    const unsubscribe = controller.subscribe((state) => {
      if (active) {
        setNetwork(state);
        if (state.status === 'ready') setLocalError(undefined);
      }
    });
    void controller
      .start({
        wallet: summary,
        ...(summary.hd
          ? {
              deriveAddresses,
              getIssuedAddresses: addressManager?.scanRequirements,
            }
          : {}),
      })
      .catch((caught: unknown) => {
        if (active)
          setLocalError(
            translateWalletError(caught, translatorRef.current, 'network'),
          );
      });
    return () => {
      active = false;
      addressOperationRef.current += 1;
      unsubscribe();
      controller.close();
      if (controllerRef.current === controller)
        controllerRef.current = undefined;
      if (addressManagerRef.current === addressManager)
        addressManagerRef.current = undefined;
    };
  }, [deriveAddresses, summary]);

  const snapshot = network?.record?.snapshot;
  const broadcastIsUnconfirmed = Boolean(
    broadcastReceipt &&
    snapshot &&
    walletTransactionIsUnconfirmed(snapshot, broadcastReceipt.txid),
  );
  const broadcastIsConfirmed = Boolean(
    broadcastReceipt &&
    snapshot?.history.some(
      (entry) =>
        entry.txid.toLowerCase() === broadcastReceipt.txid.toLowerCase() &&
        entry.height > 0,
    ),
  );
  const canAttemptRbf = Boolean(
    broadcastReceipt?.rbf &&
    broadcastIsUnconfirmed &&
    network?.status === 'ready' &&
    network.record?.status === 'fresh',
  );
  const broadcastOriginalIsConfirmed = Boolean(
    broadcastReceipt?.replacementOf &&
    snapshot?.history.some(
      (entry) =>
        entry.txid.toLowerCase() ===
          broadcastReceipt.replacementOf?.toLowerCase() && entry.height > 0,
    ),
  );

  useEffect(() => {
    if (
      !broadcastReceipt ||
      broadcastIsConfirmed ||
      broadcastOriginalIsConfirmed
    )
      return;
    let refreshInFlight = false;
    const refreshTransactionState = () => {
      const controller = controllerRef.current;
      const current = controller?.getState();
      if (
        refreshInFlight ||
        !controller ||
        current?.status !== 'ready' ||
        current.record?.status !== 'fresh'
      ) {
        return;
      }
      refreshInFlight = true;
      void controller
        .refreshKnownAddresses(broadcastReceipt.watchAddresses)
        .catch(() => {
          // A concurrent disconnect or lock is already reflected by the
          // controller state; tracking must not create a competing error.
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };
    const timer = window.setInterval(refreshTransactionState, 4_000);
    return () => window.clearInterval(timer);
  }, [broadcastIsConfirmed, broadcastOriginalIsConfirmed, broadcastReceipt]);

  const selectedSequence = useMemo<HdAddressSequence>(
    () => ({ ...ACCOUNT_ZERO_EXTERNAL, accountKey: selectedFamily }),
    [selectedFamily],
  );

  useEffect(() => {
    if (!summary.hd || network?.status !== 'ready' || !snapshot) return;
    if (issuedAddress && issuedAddress.accountKey === selectedFamily) {
      return;
    }
    const manager = addressManagerRef.current;
    if (!manager) return;
    const operation = addressOperationRef.current + 1;
    addressOperationRef.current = operation;
    setAddressBusy(true);
    setLocalError(undefined);
    void manager
      .currentOrPrimary(selectedSequence, snapshot.addresses)
      .then((issued) => {
        if (addressOperationRef.current === operation) setIssuedAddress(issued);
      })
      .catch((caught: unknown) => {
        if (addressOperationRef.current === operation)
          setLocalError(translateWalletError(caught, translatorRef.current));
      })
      .finally(() => {
        if (addressOperationRef.current === operation) setAddressBusy(false);
      });
  }, [
    issuedAddress,
    network?.status,
    selectedFamily,
    selectedSequence,
    snapshot,
    summary.hd,
  ]);

  const singleKeyAddress = useMemo(
    () =>
      summary.primaryAddresses.find(
        (address) => address.scriptType === 'p2wpkh',
      ),
    [summary.primaryAddresses],
  );

  const receiveAddress = summary.hd
    ? issuedAddress?.address
    : singleKeyAddress?.address;
  const receivePath = summary.hd ? issuedAddress?.path : undefined;
  const receiveIndex = summary.hd ? issuedAddress?.index : undefined;
  const receiveQr = useMemo(
    () => (receiveAddress ? createAddressQr(receiveAddress) : undefined),
    [receiveAddress],
  );

  if (
    network?.status === 'error' ||
    network?.status === 'stale' ||
    network?.record?.status !== 'fresh' ||
    !snapshot
  ) {
    return (
      <>
        <WalletScanGate
          error={localError ?? translateNetworkError(network?.errorCode, t)}
          network={network}
          onExit={onLock}
          onRetry={() => void refreshWallet()}
          singleKey={!summary.hd}
        />
        {broadcastReceipt ? (
          <TransactionBroadcastDialog
            busy={rbfBusy}
            canAttemptRbf={false}
            error={rbfError}
            isConfirmed={broadcastIsConfirmed}
            originalIsConfirmed={broadcastOriginalIsConfirmed}
            onCancelRbf={() => {
              setRbfQuote(undefined);
              setRbfError(undefined);
            }}
            onClose={closeBroadcastDialog}
            onConfirmRbf={() => void broadcastRbfCancellation()}
            onPrepareRbf={() => void prepareRbfCancellation()}
            quote={rbfQuote}
            receipt={broadcastReceipt}
          />
        ) : null}
      </>
    );
  }

  if (manualSyncInProgress) {
    return (
      <WalletScanGate
        network={network}
        onExit={onLock}
        onRetry={() => undefined}
        singleKey={!summary.hd}
      />
    );
  }

  async function copyReceiveAddress() {
    if (!receiveAddress) return;
    try {
      await navigator.clipboard.writeText(receiveAddress);
      setNotice(t('notice.addressCopied'));
      setLocalError(undefined);
    } catch (caught: unknown) {
      setLocalError(translateWalletError(caught, t, 'copy'));
    }
  }

  async function reserveNewAddress() {
    const manager = addressManagerRef.current;
    if (!manager || !snapshot || !summary.hd) return;
    const operation = addressOperationRef.current + 1;
    addressOperationRef.current = operation;
    setAddressBusy(true);
    setLocalError(undefined);
    setNotice(undefined);
    try {
      const issued = await manager.reserveNew(
        selectedSequence,
        snapshot.addresses,
      );
      if (addressOperationRef.current !== operation) return;
      setIssuedAddress(issued);
      const alreadyCovered = snapshot.addresses.some(
        (address) =>
          address.ownerKind === 'hd' &&
          address.account === issued.account &&
          address.accountKey === issued.accountKey &&
          address.branch === issued.branch &&
          address.index === issued.index &&
          address.path === issued.path &&
          address.address === issued.address,
      );
      if (alreadyCovered) {
        setNotice(
          t('notice.addressReady', {
            family: familyFor(selectedFamily).label,
            index: issued.index,
          }),
        );
        return;
      }
      const refreshed = await controllerRef.current?.refresh();
      if (addressOperationRef.current !== operation) return;
      setNotice(
        refreshed?.status === 'ready'
          ? t('notice.addressReservedScanned', {
              family: familyFor(selectedFamily).label,
              index: issued.index,
            })
          : t('notice.addressReservedReconnect', { index: issued.index }),
      );
    } catch (caught: unknown) {
      if (addressOperationRef.current === operation)
        setLocalError(translateWalletError(caught, t));
    } finally {
      if (addressOperationRef.current === operation) setAddressBusy(false);
    }
  }

  async function refreshWallet(): Promise<boolean> {
    setLocalError(undefined);
    setNotice(undefined);
    try {
      await controllerRef.current?.refresh();
      return true;
    } catch (caught: unknown) {
      setLocalError(translateWalletError(caught, t, 'network'));
      return false;
    }
  }

  async function runManualWalletSync() {
    const now = Date.now();
    const secondsRemaining = manualSyncSecondsRemaining(
      manualSyncAvailableAtRef.current,
      now,
    );
    if (secondsRemaining > 0) {
      setManualSyncCooldownSeconds(secondsRemaining);
      setManualSyncCooldownOpen(true);
      return;
    }

    manualSyncAvailableAtRef.current = manualSyncAvailableAt(now);
    setManualSyncCooldownOpen(false);
    setManualSyncInProgress(true);
    try {
      if (await refreshWallet()) setNotice(t('wallet.refreshComplete'));
    } finally {
      setManualSyncInProgress(false);
    }
  }

  const invalidateSend = () => {
    setSendPreview(undefined);
    setPreparedSend(undefined);
    setConsolidationPreview(undefined);
    setPreparedConsolidation(undefined);
    setBroadcastedConsolidationTxids([]);
    setSendError(undefined);
  };

  const cancelPreparedSend = () => {
    setPreparedSend(undefined);
    setSendPreview(undefined);
    setSendError(undefined);
    window.requestAnimationFrame(() => {
      revealWalletStep(sendPreviewButtonRef.current);
    });
  };

  const updateRecipient = (
    id: number,
    field: 'address' | 'amount',
    value: string,
  ) => {
    setRecipients((current) =>
      current.map((recipient) =>
        recipient.id === id ? { ...recipient, [field]: value } : recipient,
      ),
    );
    invalidateSend();
  };

  const parseFeeRate = () => {
    if (!customFeeEnabled) return DEFAULT_FEE_PER_VBYTE;
    if (!/^\d+$/u.test(feeRate)) {
      throw new TransparentSendError('invalid-fee-rate');
    }
    const parsed = BigInt(feeRate);
    if (parsed < BigInt(1) || parsed > BigInt(10_000)) {
      throw new TransparentSendError('invalid-fee-rate');
    }
    return parsed;
  };

  const recipientOutputs = (targetIndex?: number): TransparentSendOutput[] =>
    recipients.map((recipient, index) => ({
      address: recipient.address,
      amountSats:
        index === targetIndex
          ? BigInt(0)
          : parseNitoAmountToSats(recipient.amount),
    }));

  async function ensureSendChange() {
    const controller = controllerRef.current;
    if (!controller) {
      throw Object.assign(new Error('NETWORK_SYNC_FAILED'), {
        code: 'NETWORK_SYNC_FAILED',
      });
    }
    // A live Electrum notification may already be reconciling one address.
    // Await that bounded work, but never start a new HD discovery scan here.
    await controller.waitForIdle();
    const current = controller.getState();
    if (current.status !== 'ready' || current.record?.status !== 'fresh') {
      throw Object.assign(new Error('FRESH_SYNC_REQUIRED'), {
        code: 'FRESH_SYNC_REQUIRED',
      });
    }
    if (!summary.hd) {
      const change =
        summary.primaryAddresses.find(
          (address) => address.scriptType === 'p2wpkh',
        ) ?? summary.primaryAddresses[0];
      if (!change) throw new TransparentSendError('change-address-unavailable');
      return {
        changeAddress: change.address,
        snapshot: current.record.snapshot,
      };
    }

    const manager = addressManagerRef.current;
    if (!manager) throw new TransparentSendError('change-address-unavailable');
    const change = await manager.currentOrReserve(
      { account: 0, accountKey: 'bech32', branch: 'internal' },
      current.record.snapshot.addresses,
    );
    const coveredChange = current.record.snapshot.addresses.some(
      (address) =>
        address.ownerKind === 'hd' &&
        address.path === change.path &&
        address.address === change.address,
    );
    if (coveredChange) {
      return {
        changeAddress: change.address,
        snapshot: current.record.snapshot,
      };
    }

    // The normal change address is already part of the scanned trailing gap.
    // A refresh is only required for an explicitly issued index beyond the
    // current coverage; avoiding it keeps preview/MAX entirely local.
    const refreshed = await controller.refresh();
    if (
      refreshed.status !== 'ready' ||
      refreshed.record?.status !== 'fresh' ||
      !refreshed.record.snapshot.addresses.some(
        (address) =>
          address.ownerKind === 'hd' &&
          address.path === change.path &&
          address.address === change.address,
      )
    ) {
      throw new TransparentSendError('change-address-unavailable');
    }
    return {
      changeAddress: change.address,
      snapshot: refreshed.record.snapshot,
    };
  }

  async function ensureTaprootReturnAddress() {
    const controller = controllerRef.current;
    if (!controller) {
      throw Object.assign(new Error('NETWORK_SYNC_FAILED'), {
        code: 'NETWORK_SYNC_FAILED',
      });
    }
    await controller.waitForIdle();
    const current = controller.getState();
    if (current.status !== 'ready' || current.record?.status !== 'fresh') {
      throw Object.assign(new Error('FRESH_SYNC_REQUIRED'), {
        code: 'FRESH_SYNC_REQUIRED',
      });
    }
    if (!summary.hd) {
      const returnAddress = summary.primaryAddresses.find(
        (address) => address.scriptType === 'p2wpkh',
      );
      if (!returnAddress) {
        throw new TransparentSendError('change-address-unavailable');
      }
      return {
        returnAddress: returnAddress.address,
        snapshot: current.record.snapshot,
      };
    }

    const manager = addressManagerRef.current;
    if (!manager) throw new TransparentSendError('change-address-unavailable');
    const returnAddress = await manager.reserveNew(
      { account: 0, accountKey: 'taproot', branch: 'internal' },
      current.record.snapshot.addresses,
    );
    const isCovered = current.record.snapshot.addresses.some(
      (address) =>
        address.ownerKind === 'hd' &&
        address.path === returnAddress.path &&
        address.address === returnAddress.address,
    );
    if (isCovered) {
      return {
        returnAddress: returnAddress.address,
        snapshot: current.record.snapshot,
      };
    }

    const refreshed = await controller.refresh();
    if (
      refreshed.status !== 'ready' ||
      refreshed.record?.status !== 'fresh' ||
      !refreshed.record.snapshot.addresses.some(
        (address) =>
          address.ownerKind === 'hd' &&
          address.path === returnAddress.path &&
          address.address === returnAddress.address,
      )
    ) {
      throw new TransparentSendError('change-address-unavailable');
    }
    return {
      returnAddress: returnAddress.address,
      snapshot: refreshed.record.snapshot,
    };
  }

  async function previewSend() {
    setSendBusy(true);
    setSendError(undefined);
    setSendPreview(undefined);
    setPreparedSend(undefined);
    setConsolidationPreview(undefined);
    setPreparedConsolidation(undefined);
    setBroadcastedConsolidationTxids([]);
    try {
      const outputs = recipientOutputs();
      const feePerVbyte = parseFeeRate();
      const context = await ensureSendChange();
      const estimate = await estimateTransparentMultiSend({
        snapshot: context.snapshot,
        outputs,
        feePerVbyte,
        changeAddress: context.changeAddress,
      });
      assertTransparentSendFitsAvailable(estimate.fitsAvailable);
      setSendPreview({
        outputs,
        estimate,
        feePerVbyte,
        changeAddress: context.changeAddress,
        scannedAt: context.snapshot.scannedAt,
      });
    } catch (caught: unknown) {
      setSendPreview(undefined);
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function applyMax(targetIndex: number) {
    if (!snapshot) return;
    if (
      !shouldOfferMaxForRecipient(
        recipients,
        targetIndex,
        snapshot.spendableSats,
      )
    ) {
      return;
    }
    setSendBusy(true);
    setSendError(undefined);
    setPreparedSend(undefined);
    try {
      const feePerVbyte = parseFeeRate();
      const context = await ensureSendChange();
      const max = await calculateMaxTransparentSendAmount({
        snapshot: context.snapshot,
        outputs: recipientOutputs(targetIndex),
        targetIndex,
        feePerVbyte,
        changeAddress: context.changeAddress,
      });
      setRecipients((current) =>
        current.map((recipient, index) =>
          index === targetIndex
            ? { ...recipient, amount: satsToInputAmount(max.amountSats) }
            : recipient,
        ),
      );
      setSendPreview(undefined);
    } catch (caught: unknown) {
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function signSend() {
    if (!sendPreview) return;
    setSendBusy(true);
    setSendError(undefined);
    try {
      const controller = controllerRef.current;
      await controller?.waitForIdle();
      const current = controller?.getState();
      if (
        current?.status !== 'ready' ||
        current.record?.status !== 'fresh' ||
        current.record.snapshot.scannedAt !== sendPreview.scannedAt
      ) {
        throw Object.assign(new Error('SNAPSHOT_CHANGED'), {
          code: 'SNAPSHOT_CHANGED',
        });
      }
      const prepared = await buildTransparentMultiSend({
        sessionId: summary.sessionId,
        snapshot: current.record.snapshot,
        outputs: sendPreview.outputs,
        signPsbt,
        feePerVbyte: sendPreview.feePerVbyte,
        changeAddress: sendPreview.changeAddress,
      });
      if (
        prepared.feeSats !== sendPreview.estimate.feeSats ||
        prepared.inputCount !== sendPreview.estimate.inputCount ||
        prepared.outputCount !== sendPreview.estimate.outputCount ||
        prepared.changeUsed !== sendPreview.estimate.changeUsed
      ) {
        throw new TransparentSendError('signed-transaction-mismatch');
      }
      setPreparedSend(prepared);
    } catch (caught: unknown) {
      setPreparedSend(undefined);
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function broadcastSend() {
    if (!preparedSend) return;
    setSendBusy(true);
    setSendError(undefined);
    try {
      const controller = controllerRef.current;
      await controller?.waitForIdle();
      if (!controller || !sendPreview?.changeAddress) {
        throw Object.assign(new Error('SNAPSHOT_CHANGED'), {
          code: 'SNAPSHOT_CHANGED',
        });
      }
      const rbfContext = await ensureTaprootReturnAddress();
      const original = preparedSend;
      const txid = await controller.broadcastTransaction(
        preparedSend.hex,
        preparedSend.txid,
        {
          inputs: preparedSend.walletInputs,
          outputs: preparedSend.walletOutputs,
        },
      );
      if (!txid) {
        throw Object.assign(new Error('BROADCAST_NO_TXID'), {
          code: 'BROADCAST_NO_TXID',
        });
      }
      setActiveView('home');
      setNotice(undefined);
      setRbfQuote(undefined);
      setRbfError(undefined);
      setBroadcastReceipt({
        txid,
        watchAddresses: acceptedTransactionAddresses(
          acceptedTransaction(txid, preparedSend),
        ),
        rbf: {
          original,
          sourceSnapshot: rbfContext.snapshot,
          returnAddress: rbfContext.returnAddress,
        },
      });
      setRecipients([
        { id: nextRecipientIdRef.current, address: '', amount: '' },
      ]);
      nextRecipientIdRef.current += 1;
      setSendPreview(undefined);
      setPreparedSend(undefined);
    } catch (caught: unknown) {
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  const acceptedTransaction = (
    txid: string,
    transaction: PreparedTransparentSend,
  ): AcceptedTransparentTransaction => ({
    txid,
    inputs: transaction.walletInputs,
    outputs: transaction.walletOutputs,
  });

  async function prepareRbfCancellation() {
    const receipt = broadcastReceipt;
    if (!receipt?.rbf) return;
    setRbfBusy(true);
    setRbfError(undefined);
    try {
      const controller = controllerRef.current;
      await controller?.waitForIdle();
      const current = controller?.getState();
      if (
        !controller ||
        !current?.record?.snapshot ||
        current.status !== 'ready' ||
        current.record.status !== 'fresh'
      ) {
        throw Object.assign(new Error('FRESH_SYNC_REQUIRED'), {
          code: 'FRESH_SYNC_REQUIRED',
        });
      }
      if (
        !walletTransactionIsUnconfirmed(current.record.snapshot, receipt.txid)
      ) {
        throw new TransparentSendError('rbf-transaction-confirmed');
      }
      let networkFeeRate = DEFAULT_FEE_PER_VBYTE;
      try {
        networkFeeRate = addRbfNetworkFeeMargin(
          await controller.estimateHighPriorityFeeRate(),
        );
      } catch {
        // The original-rate and absolute-increase rules still protect the
        // replacement if a server temporarily cannot estimate the mempool.
      }
      setRbfQuote(
        estimateTransparentRbfCancellation({
          snapshot: receipt.rbf.sourceSnapshot,
          original: receipt.rbf.original,
          returnAddress: receipt.rbf.returnAddress,
          feePerVbyte: networkFeeRate,
        }),
      );
    } catch (caught: unknown) {
      setRbfQuote(undefined);
      setRbfError(translateWalletError(caught, t));
    } finally {
      setRbfBusy(false);
    }
  }

  async function broadcastRbfCancellation() {
    const receipt = broadcastReceipt;
    if (!receipt?.rbf || !rbfQuote) return;
    setRbfBusy(true);
    setRbfError(undefined);
    try {
      const controller = controllerRef.current;
      await controller?.waitForIdle();
      const current = controller?.getState();
      if (
        !controller ||
        !current?.record?.snapshot ||
        current.status !== 'ready' ||
        current.record.status !== 'fresh'
      ) {
        throw Object.assign(new Error('FRESH_SYNC_REQUIRED'), {
          code: 'FRESH_SYNC_REQUIRED',
        });
      }
      if (
        !walletTransactionIsUnconfirmed(current.record.snapshot, receipt.txid)
      ) {
        throw new TransparentSendError('rbf-transaction-confirmed');
      }
      const replacement = await buildTransparentRbfCancellation({
        sessionId: summary.sessionId,
        snapshot: receipt.rbf.sourceSnapshot,
        original: receipt.rbf.original,
        returnAddress: receipt.rbf.returnAddress,
        signPsbt,
        feePerVbyte: rbfQuote.feePerVbyte,
      });
      if (
        replacement.feeSats !== rbfQuote.feeSats ||
        replacement.walletOutputs[0]?.valueSats !== rbfQuote.outputSats
      ) {
        throw new TransparentSendError('rbf-replacement-fee');
      }
      const replacementTxid = await controller.broadcastReplacementTransaction(
        replacement.hex,
        replacement.txid,
        acceptedTransaction(receipt.txid, receipt.rbf.original),
        {
          inputs: replacement.walletInputs,
          outputs: replacement.walletOutputs,
        },
      );
      const replacementTransaction: AcceptedTransparentTransaction = {
        txid: replacementTxid,
        inputs: replacement.walletInputs,
        outputs: replacement.walletOutputs,
      };
      setBroadcastReceipt({
        txid: replacementTxid,
        watchAddresses: acceptedTransactionAddresses(replacementTransaction),
        replacementOf: receipt.txid,
      });
      setRbfQuote(undefined);
    } catch (caught: unknown) {
      setRbfError(translateWalletError(caught, t));
    } finally {
      setRbfBusy(false);
    }
  }

  async function previewConsolidation() {
    setSendBusy(true);
    setSendError(undefined);
    setSendPreview(undefined);
    setPreparedSend(undefined);
    setPreparedConsolidation(undefined);
    setBroadcastedConsolidationTxids([]);
    try {
      const feePerVbyte = parseFeeRate();
      const context = await ensureTaprootReturnAddress();
      const plan = planTransparentConsolidation({
        snapshot: context.snapshot,
        toAddress: context.returnAddress,
        feePerVbyte,
      });
      setConsolidationPreview({
        plan,
        feePerVbyte,
        changeAddress: context.returnAddress,
        scannedAt: context.snapshot.scannedAt,
      });
    } catch (caught: unknown) {
      setConsolidationPreview(undefined);
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function signConsolidation() {
    if (!consolidationPreview) return;
    setSendBusy(true);
    setSendError(undefined);
    try {
      const controller = controllerRef.current;
      await controller?.waitForIdle();
      const current = controller?.getState();
      if (
        current?.status !== 'ready' ||
        current.record?.status !== 'fresh' ||
        current.record.snapshot.scannedAt !== consolidationPreview.scannedAt
      ) {
        throw Object.assign(new Error('SNAPSHOT_CHANGED'), {
          code: 'SNAPSHOT_CHANGED',
        });
      }
      const prepared = await buildTransparentConsolidation({
        sessionId: summary.sessionId,
        snapshot: current.record.snapshot,
        toAddress: consolidationPreview.changeAddress,
        signPsbt,
        feePerVbyte: consolidationPreview.feePerVbyte,
      });
      if (
        prepared.inputCount !== consolidationPreview.plan.inputCount ||
        prepared.outputCount !== consolidationPreview.plan.outputCount ||
        prepared.totalFeeSats !== consolidationPreview.plan.totalFeeSats
      ) {
        throw new TransparentSendError('signed-transaction-mismatch');
      }
      setPreparedConsolidation(prepared);
    } catch (caught: unknown) {
      setPreparedConsolidation(undefined);
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function broadcastNextConsolidation() {
    if (!preparedConsolidation) return;
    const transaction = preparedConsolidation.transactions.find(
      ({ txid }) => !broadcastedConsolidationTxids.includes(txid),
    );
    if (!transaction) return;
    setSendBusy(true);
    setSendError(undefined);
    try {
      const txid = await controllerRef.current?.broadcastTransaction(
        transaction.hex,
        transaction.txid,
        {
          inputs: transaction.walletInputs,
          outputs: transaction.walletOutputs,
        },
      );
      if (!txid) {
        throw Object.assign(new Error('BROADCAST_NO_TXID'), {
          code: 'BROADCAST_NO_TXID',
        });
      }
      setActiveView('home');
      setRbfQuote(undefined);
      setRbfError(undefined);
      setBroadcastReceipt({
        txid,
        watchAddresses: acceptedTransactionAddresses({
          txid,
          inputs: transaction.walletInputs,
          outputs: transaction.walletOutputs,
        }),
      });
      const completed = [...broadcastedConsolidationTxids, txid];
      setBroadcastedConsolidationTxids(completed);
      setNotice(undefined);
    } catch (caught: unknown) {
      setSendError(translateWalletError(caught, t));
    } finally {
      setSendBusy(false);
    }
  }

  async function recoverRange(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const accountValue = form.get('account');
    const accountKeyValue = form.get('accountKey');
    const branchValue = form.get('branch');
    const fromIndexValue = form.get('fromIndex');
    const toIndexValue = form.get('toIndex');
    if (
      typeof accountValue !== 'string' ||
      typeof accountKeyValue !== 'string' ||
      typeof branchValue !== 'string' ||
      typeof fromIndexValue !== 'string' ||
      typeof toIndexValue !== 'string'
    ) {
      setLocalError(t('errors.recoveryFormIncomplete'));
      return;
    }
    const account = Number(accountValue) as 0 | 1;
    const accountKey = accountKeyValue as HdAccountKey;
    const branch = branchValue as HdBranch;
    const fromIndex = Number(fromIndexValue);
    const toIndex = Number(toIndexValue);
    if (
      (account !== 0 && account !== 1) ||
      !HD_ACCOUNT_TEMPLATES.some((template) => template.key === accountKey) ||
      (branch !== 'external' && branch !== 'internal') ||
      !Number.isSafeInteger(fromIndex) ||
      !Number.isSafeInteger(toIndex) ||
      fromIndex < 0 ||
      toIndex < fromIndex ||
      toIndex > 9_999 ||
      toIndex - fromIndex + 1 > 250
    ) {
      setLocalError(t('errors.recoveryRange'));
      return;
    }
    setRecoveryBusy(true);
    setLocalError(undefined);
    setNotice(undefined);
    try {
      const state = await controllerRef.current?.recoverRanges([
        { account, accountKey, branch, fromIndex, toIndex },
      ]);
      setNotice(
        state?.status === 'ready'
          ? t('notice.rangeInspected', { from: fromIndex, to: toIndex })
          : t('notice.rangeStale'),
      );
    } catch (caught: unknown) {
      setLocalError(translateWalletError(caught, t));
    } finally {
      setRecoveryBusy(false);
    }
  }

  const coverage =
    snapshot?.coverage.filter((item) => item.mode === 'gap') ?? [];
  const spendableUtxoCount =
    snapshot?.utxos.filter(isTransparentUtxoSpendable).length ?? 0;
  const receiveAvailable = Boolean(receiveAddress);
  const navigation = [
    { key: 'home' as const, label: t('nav.home'), icon: House },
    ...(receiveAvailable
      ? [
          {
            key: 'receive' as const,
            label: t('nav.receive'),
            icon: ArrowDownToLine,
          },
        ]
      : []),
    { key: 'send' as const, label: t('nav.send'), icon: ArrowUpRight },
    { key: 'settings' as const, label: t('nav.settings'), icon: Settings },
  ];

  async function revealRecoveryPhrase() {
    if (summary.source === 'email-credentials' && backupPassword.length === 0) {
      setBackupError(t('backup.passwordRequired'));
      return;
    }
    setBackupBusy(true);
    setBackupError(undefined);
    try {
      setRevealedMnemonic(
        await revealMnemonic(
          summary.source === 'email-credentials' ? backupPassword : undefined,
        ),
      );
    } catch (caught: unknown) {
      setRevealedMnemonic(undefined);
      setBackupError(translateWalletError(caught, t, 'local'));
    } finally {
      setBackupPassword('');
      setBackupPasswordVisible(false);
      setBackupBusy(false);
    }
  }

  function hideRecoveryPhrase() {
    setRevealedMnemonic(undefined);
    setBackupRevealRequested(false);
    setBackupPassword('');
    setBackupPasswordVisible(false);
    setBackupError(undefined);
  }

  return (
    <div className="space-y-5">
      {manualSyncCooldownOpen ? (
        <ManualSyncCooldownDialog
          onClose={() => setManualSyncCooldownOpen(false)}
          onSynchronize={() => void runManualWalletSync()}
          secondsRemaining={manualSyncCooldownSeconds}
        />
      ) : null}
      {broadcastReceipt ? (
        <TransactionBroadcastDialog
          busy={rbfBusy}
          canAttemptRbf={canAttemptRbf}
          error={rbfError}
          isConfirmed={broadcastIsConfirmed}
          originalIsConfirmed={broadcastOriginalIsConfirmed}
          onCancelRbf={() => {
            setRbfQuote(undefined);
            setRbfError(undefined);
          }}
          onClose={closeBroadcastDialog}
          onConfirmRbf={() => void broadcastRbfCancellation()}
          onPrepareRbf={() => void prepareRbfCancellation()}
          quote={rbfQuote}
          receipt={broadcastReceipt}
        />
      ) : null}
      <div className="glass-panel subtle-shine flex items-center justify-between gap-3 rounded-3xl p-3.5 sm:p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.07] text-emerald-200">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-black tracking-tight text-white">
              {t(sourceLabelKey(summary))}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {t('app.connectionEstablished')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={`hidden sm:inline-flex ${networkTone(network)}`}
          >
            {networkLabel(network, t)}
          </Badge>
          <Button
            aria-label={t('wallet.refresh')}
            variant="ghost"
            size="icon"
            onClick={() => void runManualWalletSync()}
          >
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onLock()}>
            <LockKeyhole data-icon="inline-start" />
            {t('wallet.exit')}
          </Button>
        </div>
      </div>

      <nav
        aria-label={t('nav.aria')}
        className="grid gap-1.5 rounded-3xl border border-sky-200/[0.10] bg-[#061120] p-1.5"
        style={{
          gridTemplateColumns: `repeat(${navigation.length}, minmax(0, 1fr))`,
        }}
      >
        {navigation.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-label={label}
            aria-current={activeView === key ? 'page' : undefined}
            onClick={() => setActiveView(key)}
            className={`group/nav flex min-h-12 items-center justify-center gap-2 rounded-2xl border px-2 text-xs font-bold outline-none transition-all duration-200 ${activeView === key ? 'border-sky-300/20 bg-[#1769c2] text-white' : 'border-transparent text-slate-500 hover:-translate-y-0.5 hover:bg-white/[0.04] hover:text-slate-200 focus-visible:ring-4 focus-visible:ring-sky-300/10'}`}
          >
            <Icon
              className="size-4 transition-transform duration-200 group-hover/nav:scale-110"
              aria-hidden="true"
            />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </nav>

      {localError || network?.errorCode ? (
        <div
          role="alert"
          className="flex gap-3 rounded-xl border border-red-300/25 bg-red-300/[0.06] p-3 text-sm text-red-100"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {localError ?? translateNetworkError(network?.errorCode, t)}
        </div>
      ) : null}
      {notice ? (
        <div className="flex gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.045] p-3 text-sm text-emerald-100">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ) : null}
      {activeView === 'settings' ? (
        <Card className="glass-panel border-white/[0.08] bg-transparent py-0">
          <CardHeader className="px-5 pt-5">
            <CardTitle className="text-base text-white">
              {t('settings.session')}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="divide-y divide-white/[0.06] text-sm">
              <div className="flex flex-col items-stretch gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <label className="text-slate-500" htmlFor="auto-lock-minutes">
                  {t('settings.lock')}
                </label>
                <select
                  id="auto-lock-minutes"
                  aria-label={t('settings.lock')}
                  className="min-h-10 w-full rounded-xl border border-white/10 bg-[#050d1a] px-3 text-sm font-semibold text-slate-100 outline-none transition hover:border-sky-200/20 focus:border-sky-300/50 focus:ring-4 focus:ring-sky-300/10 sm:w-auto"
                  value={autoLockMinutes}
                  onChange={(event) => {
                    const minutes = Number(event.currentTarget.value);
                    if (isAutoLockMinutes(minutes)) {
                      onAutoLockMinutesChange(minutes);
                    }
                  }}
                >
                  {AUTO_LOCK_MINUTE_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {t('settings.minutes', { minutes })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col items-stretch gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <label
                  className="text-slate-500"
                  htmlFor="background-lock-seconds"
                >
                  {t('settings.backgroundLock')}
                </label>
                <select
                  id="background-lock-seconds"
                  aria-label={t('settings.backgroundLock')}
                  className="min-h-10 w-full rounded-xl border border-white/10 bg-[#050d1a] px-3 text-sm font-semibold text-slate-100 outline-none transition hover:border-sky-200/20 focus:border-sky-300/50 focus:ring-4 focus:ring-sky-300/10 sm:w-auto"
                  value={backgroundLockSeconds}
                  onChange={(event) => {
                    const seconds = Number(event.currentTarget.value);
                    if (isBackgroundLockSeconds(seconds)) {
                      onBackgroundLockSecondsChange(seconds);
                    }
                  }}
                >
                  {BACKGROUND_LOCK_SECOND_OPTIONS.map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {t('settings.seconds', { seconds })}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
      {activeView === 'settings' &&
      offersRecoveryPhraseInSettings(summary.source) ? (
        <Card className="overflow-visible border border-amber-300/15 bg-amber-300/[0.025] py-0">
          <CardHeader className="px-5 pt-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-200">
                {t('backup.label')}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <CardTitle className="text-base text-white">
                  {t('backup.recoveryPhrase', {
                    count: summary.wordCount ?? 24,
                  })}
                </CardTitle>
                <InfoTip label={t('backup.infoLabel')}>
                  {t('backup.compatibility')}
                </InfoTip>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {!revealedMnemonic &&
            summary.source === 'email-credentials' &&
            !backupRevealRequested ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setBackupRevealRequested(true);
                    setBackupError(undefined);
                  }}
                >
                  <Eye data-icon="inline-start" />
                  {t('backup.showPhrase')}
                </Button>
              </div>
            ) : !revealedMnemonic && summary.source === 'email-credentials' ? (
              <form
                className="rounded-2xl border border-amber-300/15 bg-slate-950/55 p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void revealRecoveryPhrase();
                }}
              >
                <label className="text-xs font-semibold text-slate-300">
                  {t('backup.confirmPassword')}
                  <span className="relative mt-2 block">
                    <input
                      autoComplete="current-password"
                      className={`${INPUT_CLASS} mt-0 pr-12`}
                      name="backupPassword"
                      placeholder={t('backup.passwordPlaceholder')}
                      type={backupPasswordVisible ? 'text' : 'password'}
                      value={backupPassword}
                      onChange={(event) => {
                        setBackupPassword(event.currentTarget.value);
                        setBackupError(undefined);
                      }}
                    />
                    <button
                      type="button"
                      aria-label={t(
                        backupPasswordVisible
                          ? 'common.hideField'
                          : 'common.showField',
                        { label: t('access.passwordLabel') },
                      )}
                      aria-pressed={backupPasswordVisible}
                      className="absolute inset-y-0 right-1 grid w-10 place-items-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-200"
                      onClick={() =>
                        setBackupPasswordVisible((visible) => !visible)
                      }
                    >
                      {backupPasswordVisible ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </span>
                </label>
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                  <Button
                    disabled={backupBusy}
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setBackupRevealRequested(false);
                      setBackupPassword('');
                      setBackupPasswordVisible(false);
                      setBackupError(undefined);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    disabled={backupBusy || backupPassword.length === 0}
                    type="submit"
                  >
                    {backupBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Eye data-icon="inline-start" />
                    )}
                    {t('backup.verifyShow')}
                  </Button>
                </div>
              </form>
            ) : !revealedMnemonic ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-slate-500">
                  {t('backup.explicitReveal')}
                </p>
                <Button
                  disabled={backupBusy}
                  type="button"
                  variant="outline"
                  onClick={() => void revealRecoveryPhrase()}
                >
                  {backupBusy ? (
                    <LoaderCircle
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <Eye data-icon="inline-start" />
                  )}
                  {t('backup.revealLocal')}
                </Button>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-300/20 bg-slate-950/65 p-4">
                <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {revealedMnemonic.mnemonic.split(' ').map((word, index) => (
                    <li
                      key={`${index}-${word}`}
                      className="rounded-lg border border-white/8 bg-slate-950/75 px-3 py-2 font-mono text-sm text-slate-100"
                    >
                      <span className="mr-2 text-[10px] text-slate-600">
                        {index + 1}
                      </span>
                      {word}
                    </li>
                  ))}
                </ol>
                <RecoveryPhraseCopy
                  description={t('backup.autoHide')}
                  mnemonic={revealedMnemonic.mnemonic}
                  secondaryAction={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={hideRecoveryPhrase}
                    >
                      <EyeOff data-icon="inline-start" />
                      {t('common.hide')}
                    </Button>
                  }
                />
              </div>
            )}
            {backupError ? (
              <p role="alert" className="mt-3 text-xs leading-5 text-red-200">
                {backupError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {activeView === 'home' ? (
        <div className="grid gap-5">
          <Card className="glass-panel subtle-shine relative border-sky-300/15 bg-transparent py-0">
            <CardContent className="relative p-7 sm:p-10">
              <div className="text-center">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                  {t('home.totalBalance')}
                </p>
                <p className="mt-4 bg-gradient-to-b from-white to-slate-300 bg-clip-text font-mono text-4xl font-black tracking-[-0.045em] text-transparent sm:text-6xl">
                  {formatNitoAmount(snapshot.balanceSats)}
                  <span className="ml-2 text-base text-slate-500">NITO</span>
                </p>
                {snapshot.spendableSats !== snapshot.balanceSats ? (
                  <p className="mt-3 text-xs text-slate-500">
                    {t('home.spendable', {
                      amount: formatNitoAmount(snapshot.spendableSats),
                    })}
                  </p>
                ) : null}
                {snapshot.unconfirmedSats > 0 ? (
                  <p className="mt-2 text-xs font-semibold text-amber-200">
                    {t('home.pending', {
                      amount: formatNitoAmount(snapshot.unconfirmedSats),
                    })}
                  </p>
                ) : null}
                {(snapshot.immatureCoinbaseSats ?? 0) > 0 ? (
                  <p className="mt-2 text-xs font-semibold text-amber-200">
                    {t('home.immature', {
                      amount: formatNitoAmount(
                        snapshot.immatureCoinbaseSats ?? 0,
                      ),
                    })}
                  </p>
                ) : null}
              </div>

              <div className="mx-auto mt-7 flex max-w-md flex-wrap justify-center gap-3">
                {receiveAvailable ? (
                  <Button
                    className="min-w-32"
                    size="lg"
                    type="button"
                    onClick={() => setActiveView('receive')}
                  >
                    <ArrowDownToLine data-icon="inline-start" />
                    {t('nav.receive')}
                  </Button>
                ) : null}
                <Button
                  className="min-w-32"
                  size="lg"
                  type="button"
                  variant="outline"
                  onClick={() => setActiveView('send')}
                >
                  <ArrowUpRight data-icon="inline-start" />
                  {t('nav.send')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {spendableUtxoCount >= 21 ? (
            <Card className="glass-panel overflow-visible border-violet-300/15 bg-transparent py-0">
              <CardContent className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-base text-white">
                      {t('consolidation.title')}
                    </CardTitle>
                    <InfoTip label={t('consolidation.infoLabel')}>
                      {t('consolidation.body')}
                    </InfoTip>
                  </div>
                  <Badge
                    variant="outline"
                    className="border-white/10 text-slate-500"
                  >
                    {t('consolidation.spendable', {
                      count: spendableUtxoCount,
                    })}
                  </Badge>
                </div>
                {!consolidationPreview ? (
                  <Button
                    className="mt-4"
                    disabled={sendBusy || network?.status !== 'ready'}
                    type="button"
                    variant="outline"
                    onClick={() => void previewConsolidation()}
                  >
                    {sendBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Database data-icon="inline-start" />
                    )}
                    {t('consolidation.calculate')}
                  </Button>
                ) : (
                  <div className="mt-4 rounded-xl border border-violet-300/20 bg-violet-300/[0.035] p-4">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <SendMetric
                        label={t('consolidation.metricTransactions')}
                        value={String(
                          consolidationPreview.plan.transactions.length,
                        )}
                      />
                      <SendMetric
                        label={t('consolidation.metricInputs')}
                        value={String(consolidationPreview.plan.inputCount)}
                      />
                      <SendMetric
                        label={t('consolidation.metricOutputs')}
                        value={String(consolidationPreview.plan.outputCount)}
                      />
                      <SendMetric
                        label={t('consolidation.metricFees')}
                        value={`${formatNitoAmount(consolidationPreview.plan.totalFeeSats)} NITO`}
                      />
                    </div>
                    {!preparedConsolidation ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          ref={consolidationSignButtonRef}
                          disabled={sendBusy}
                          type="button"
                          onClick={() => void signConsolidation()}
                        >
                          {sendBusy ? (
                            <LoaderCircle
                              className="animate-spin"
                              data-icon="inline-start"
                            />
                          ) : (
                            <ShieldCheck data-icon="inline-start" />
                          )}
                          {t('consolidation.sign')}
                        </Button>
                        <Button
                          disabled={sendBusy}
                          type="button"
                          variant="outline"
                          onClick={() => setConsolidationPreview(undefined)}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-4">
                        <p className="text-xs leading-5 text-slate-500">
                          {t('consolidation.progress', {
                            current: broadcastedConsolidationTxids.length,
                            total: preparedConsolidation.transactions.length,
                          })}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            ref={consolidationBroadcastButtonRef}
                            disabled={
                              sendBusy ||
                              network?.status !== 'ready' ||
                              broadcastedConsolidationTxids.length >=
                                preparedConsolidation.transactions.length
                            }
                            type="button"
                            onClick={() => void broadcastNextConsolidation()}
                          >
                            {sendBusy ? (
                              <LoaderCircle
                                className="animate-spin"
                                data-icon="inline-start"
                              />
                            ) : (
                              <ArrowUpRight data-icon="inline-start" />
                            )}
                            {t('consolidation.broadcastNext')}
                          </Button>
                          <Button
                            disabled={
                              sendBusy ||
                              broadcastedConsolidationTxids.length > 0
                            }
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setPreparedConsolidation(undefined);
                              setConsolidationPreview(undefined);
                            }}
                          >
                            {t('send.cancelBroadcast')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {sendError ? (
                  <div
                    ref={sendErrorRef}
                    className="mt-4 rounded-xl border border-red-300/20 bg-red-300/[0.05] p-3 text-sm leading-5 text-red-100"
                    role="alert"
                  >
                    {sendError}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {activeView === 'receive' ? (
        <div className="mx-auto w-full max-w-3xl">
          <Card className="glass-panel border-sky-300/15 bg-transparent py-0">
            <CardHeader className="px-5 pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-300">
                    {t('receive.title')}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <CardTitle className="text-lg text-white">
                      {t('receive.addresses')}
                    </CardTitle>
                    <InfoTip label={t('receive.infoLabel')}>
                      {summary.hd ? (
                        <>
                          {t('receive.hdInfo')}
                          {receivePath ? (
                            <span className="mt-2 block font-mono text-[10px] text-slate-500">
                              {t('receive.displayedPath', {
                                path: receivePath,
                                index:
                                  receiveIndex === undefined
                                    ? ''
                                    : t('receive.indexSuffix', {
                                        index: receiveIndex,
                                      }),
                              })}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        t('receive.singleKeyFormats')
                      )}
                    </InfoTip>
                  </div>
                </div>
                {familyFor(selectedFamily).preferred ? (
                  <Badge className="bg-sky-200 text-slate-950">
                    {t('receive.recommended')}
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="px-5 pb-5">
              {summary.hd ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {HD_ACCOUNT_TEMPLATES.map((family) => (
                    <button
                      key={family.key}
                      type="button"
                      onClick={() => {
                        addressOperationRef.current += 1;
                        setIssuedAddress(undefined);
                        setSelectedFamily(family.key);
                        setLocalError(undefined);
                      }}
                      className={`group/family min-h-14 rounded-2xl border px-3 py-2 text-left text-xs font-bold transition-all duration-200 hover:-translate-y-0.5 ${
                        selectedFamily === family.key
                          ? 'border-sky-300/40 bg-sky-300/12 text-sky-100'
                          : 'border-white/8 bg-slate-950/45 text-slate-400 hover:border-white/15 hover:bg-white/[0.055] hover:text-slate-200'
                      }`}
                    >
                      <span className="block font-bold">{family.label}</span>
                      {family.preferred ? (
                        <span className="mt-1 block text-[10px] font-semibold text-sky-300/75">
                          {t('receive.recommended')}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-sky-300/20 bg-sky-300/[0.06] px-3 py-2 text-xs leading-5 text-sky-100">
                  {t('receive.singleKeyInfo')}
                </div>
              )}

              <div className="mt-5 min-h-28 rounded-3xl border border-white/8 bg-slate-950/60 p-4 sm:p-5">
                {addressBusy ? (
                  <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-slate-400">
                    <LoaderCircle className="size-4 animate-spin" />
                    {t('receive.deriving')}
                  </div>
                ) : receiveAddress && receiveQr ? (
                  <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <div>
                      <p className="break-all font-mono text-sm leading-6 text-sky-100">
                        {receiveAddress}
                      </p>
                    </div>
                    <svg
                      aria-labelledby="receive-address-qr-title"
                      className="mx-auto size-40 rounded-2xl border border-white/15 bg-white p-2"
                      shapeRendering="crispEdges"
                      viewBox={`0 0 ${receiveQr.size} ${receiveQr.size}`}
                    >
                      <title id="receive-address-qr-title">
                        {t('receive.qrTitle', { address: receiveAddress })}
                      </title>
                      <rect
                        fill="#ffffff"
                        height={receiveQr.size}
                        width={receiveQr.size}
                      />
                      <path d={receiveQr.path} fill="#020617" />
                    </svg>
                  </div>
                ) : (
                  <p className="flex min-h-20 items-center justify-center text-sm text-slate-500">
                    {t('receive.syncRequired')}
                  </p>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  disabled={!receiveAddress || addressBusy}
                  onClick={() => void copyReceiveAddress()}
                >
                  <Copy data-icon="inline-start" />
                  {t('common.copy')}
                </Button>
                {summary.hd ? (
                  <Button
                    variant="outline"
                    disabled={
                      !snapshot || addressBusy || network?.status !== 'ready'
                    }
                    onClick={() => void reserveNewAddress()}
                  >
                    {addressBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <RefreshCw data-icon="inline-start" />
                    )}
                    {t('receive.newAddress', {
                      family: familyFor(selectedFamily).label,
                    })}
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {activeView === 'settings' && summary.hd ? (
        <Card className="border border-white/8 bg-card/65 py-0">
          <details className="group/details">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 outline-none transition-colors hover:bg-white/[0.025] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-sky-300/10">
              <div>
                <CardTitle className="text-base text-white">
                  {t('settings.scanDetails')}
                </CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {t('settings.scanHint')}
                </p>
              </div>
              <ChevronDown
                className="size-4 text-slate-500 transition-transform duration-200 group-open/details:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <CardContent className="border-t border-white/[0.06] px-5 pt-4 pb-5">
              <p className="mb-4 text-xs leading-5 text-slate-500">
                {t('settings.scanDescription')}
              </p>
              {summary.hd && coverage.length > 0 ? (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {coverage.map((item) => (
                    <div
                      key={`${item.sequenceKey}:${item.branch}`}
                      className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border border-white/8 bg-slate-950/45 p-3"
                    >
                      <div>
                        <p className="text-xs font-bold text-slate-200">
                          {t('settings.accountCoverage', {
                            account: item.account,
                            family: familyFor(item.accountKey).label,
                          })}
                        </p>
                        <p className="mt-1 text-[10px] text-slate-500">
                          {item.branch === 'external'
                            ? t('settings.externalBranch')
                            : t('settings.internalBranch')}
                        </p>
                      </div>
                      <div className="text-right font-mono text-[10px] text-slate-500">
                        <p>
                          {t('settings.scannedRange', {
                            index: item.highestScannedIndex,
                          })}
                        </p>
                        <p className="mt-1">
                          {t('settings.lastUsed', {
                            index: item.lastUsedIndex,
                          })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-6 text-slate-500">
                  {summary.hd
                    ? t('settings.coveragePending')
                    : t('settings.singleKeyNoGap')}
                </p>
              )}
            </CardContent>
          </details>
        </Card>
      ) : null}

      {activeView === 'send' ? (
        <Card className="glass-panel border-amber-300/15 bg-transparent py-0">
          <CardHeader className="px-5 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-amber-200">
                  {t('nav.send')}
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <CardTitle className="text-lg text-white">
                    {t('send.title')}
                  </CardTitle>
                  <InfoTip label={t('send.infoLabel')}>
                    {t('send.infoBody')}
                  </InfoTip>
                </div>
              </div>
              <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.045] px-4 py-2.5 text-right">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-200/70">
                  {t('send.spendableBalance')}
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-emerald-100">
                  {formatNitoAmount(snapshot.spendableSats)} NITO
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void previewSend();
              }}
            >
              {recipients.map((recipient, index) => (
                <div
                  key={recipient.id}
                  className="grid gap-3 rounded-2xl border border-white/8 bg-slate-950/45 p-3.5 lg:grid-cols-[minmax(0,1fr)_14rem_auto]"
                >
                  <label className="text-xs font-semibold text-slate-300">
                    {t('send.recipient', { index: index + 1 })}
                    <input
                      className={INPUT_CLASS}
                      value={recipient.address}
                      ref={(element) => {
                        if (element) {
                          recipientAddressRefs.current[recipient.id] = element;
                        } else {
                          delete recipientAddressRefs.current[recipient.id];
                        }
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t('send.addressPlaceholder')}
                      required
                      onChange={(event) =>
                        updateRecipient(
                          recipient.id,
                          'address',
                          event.currentTarget.value,
                        )
                      }
                    />
                  </label>
                  <label className="text-xs font-semibold text-slate-300">
                    {t('send.amount')}
                    <div className="relative">
                      <input
                        className={`${INPUT_CLASS} pr-16 font-mono`}
                        value={recipient.amount}
                        inputMode="decimal"
                        placeholder={t('send.amountPlaceholder')}
                        required
                        onChange={(event) =>
                          updateRecipient(
                            recipient.id,
                            'amount',
                            event.currentTarget.value,
                          )
                        }
                      />
                      {shouldOfferMaxForRecipient(
                        recipients,
                        index,
                        snapshot.spendableSats,
                      ) ? (
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 mt-1 -translate-y-1/2 rounded-md px-2 py-1 text-[10px] font-bold text-sky-200 hover:bg-sky-300/10 disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={sendBusy || snapshot.spendableSats === 0}
                          onClick={() => void applyMax(index)}
                        >
                          {t('send.max')}
                        </button>
                      ) : null}
                    </div>
                  </label>
                  <div className="flex items-end justify-end">
                    <Button
                      aria-label={t('send.removeRecipient', {
                        index: index + 1,
                      })}
                      disabled={recipients.length === 1 || sendBusy}
                      size="icon"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setRecipients((current) =>
                          current.filter(
                            (candidate) => candidate.id !== recipient.id,
                          ),
                        );
                        invalidateSend();
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap items-start justify-between gap-3">
                {recipients.length < MAX_SEND_RECIPIENTS ? (
                  <Button
                    disabled={sendBusy}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      const recipientId = nextRecipientIdRef.current;
                      setRecipients((current) => [
                        ...current,
                        {
                          id: recipientId,
                          address: '',
                          amount: '',
                        },
                      ]);
                      nextRecipientIdRef.current = recipientId + 1;
                      pendingRecipientFocusRef.current = recipientId;
                      invalidateSend();
                    }}
                  >
                    <Plus data-icon="inline-start" />
                    {t('send.addRecipient')}
                  </Button>
                ) : (
                  <span />
                )}
                <div className="w-full max-w-sm rounded-xl border border-white/8 bg-slate-950/35 px-3 py-2.5 text-xs sm:w-auto sm:min-w-72">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-semibold text-slate-300">
                        {t('send.networkFees')}
                      </p>
                      <p className="mt-1 text-slate-500">
                        {customFeeEnabled
                          ? `${feeRate || '—'} sats/vByte · ${t('send.customValue')}`
                          : `${t('send.automatic')} · ${DEFAULT_FEE_PER_VBYTE.toString()} sats/vByte`}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="border-emerald-300/20 text-emerald-200"
                    >
                      {customFeeEnabled ? t('send.expert') : t('send.auto')}
                    </Badge>
                  </div>
                  <details className="mt-2 border-t border-white/[0.06] pt-2">
                    <summary className="cursor-pointer select-none font-semibold text-slate-500 hover:text-slate-300">
                      {t('send.advanced')}
                    </summary>
                    <label className="mt-3 flex cursor-pointer items-start gap-2 text-slate-400">
                      <input
                        checked={customFeeEnabled}
                        className="mt-0.5 size-4 accent-sky-400"
                        type="checkbox"
                        onChange={(event) => {
                          setCustomFeeEnabled(event.currentTarget.checked);
                          setFeeRate(DEFAULT_FEE_PER_VBYTE.toString());
                          invalidateSend();
                        }}
                      />
                      <span>
                        {t('send.manual')}
                        <span className="mt-1 block text-[10px] leading-4 text-amber-100/60">
                          {t('send.manualWarning')}
                        </span>
                      </span>
                    </label>
                    {customFeeEnabled ? (
                      <label className="mt-3 block font-semibold text-slate-300">
                        {t('send.customFee')}
                        <input
                          className={INPUT_CLASS}
                          value={feeRate}
                          inputMode="numeric"
                          min="1"
                          max="10000"
                          placeholder={t('send.feePlaceholder')}
                          type="number"
                          required
                          onChange={(event) => {
                            setFeeRate(event.currentTarget.value);
                            invalidateSend();
                          }}
                        />
                      </label>
                    ) : null}
                  </details>
                </div>
              </div>

              <Button
                ref={sendPreviewButtonRef}
                disabled={
                  sendBusy ||
                  network?.status !== 'ready' ||
                  !snapshot?.spendableSats
                }
                type="submit"
              >
                {sendBusy && !sendPreview ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <ArrowUpRight data-icon="inline-start" />
                )}
                {t('send.preview')}
              </Button>
            </form>

            {sendError ? (
              <div
                ref={sendErrorRef}
                role="alert"
                tabIndex={-1}
                className="mt-4 rounded-xl border border-red-300/20 bg-red-300/[0.05] p-3 text-sm text-red-100"
              >
                {sendError}
              </div>
            ) : null}

            {sendPreview ? (
              <div className="mt-4 rounded-2xl border border-sky-300/20 bg-sky-300/[0.035] p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <SendMetric
                    label={t('send.metricRecipients')}
                    value={String(sendPreview.outputs.length)}
                  />
                  <SendMetric
                    label={t('send.metricAmount')}
                    value={`${formatNitoAmount(sendPreview.estimate.amountSats)} NITO`}
                  />
                  <SendMetric
                    label={t('send.metricFee')}
                    value={`${formatNitoAmount(sendPreview.estimate.feeSats)} NITO`}
                  />
                  <SendMetric
                    label={t('send.metricInputsOutputs', {
                      inputs: sendPreview.estimate.inputCount,
                      outputs: sendPreview.estimate.outputCount,
                    })}
                    value={`${sendPreview.estimate.inputCount} / ${sendPreview.estimate.outputCount}`}
                  />
                </div>
                {!preparedSend ? (
                  <Button
                    ref={sendSignButtonRef}
                    className="mt-4"
                    disabled={sendBusy}
                    type="button"
                    onClick={() => void signSend()}
                  >
                    {sendBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <ShieldCheck data-icon="inline-start" />
                    )}
                    {t('send.signAfterReview')}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {preparedSend ? (
              <div className="mt-4 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.04] p-4">
                <p className="text-sm font-bold text-emerald-100">
                  {t('send.signedTitle')}
                </p>
                <p className="mt-2 break-all font-mono text-xs text-slate-400">
                  {preparedSend.txid}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {t('send.signedSummary', {
                    inputs: preparedSend.inputCount,
                    outputs: preparedSend.outputCount,
                    fee: formatNitoAmount(preparedSend.feeSats),
                  })}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    ref={sendBroadcastButtonRef}
                    disabled={sendBusy || network?.status !== 'ready'}
                    type="button"
                    onClick={() => void broadcastSend()}
                  >
                    {sendBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <ArrowUpRight data-icon="inline-start" />
                    )}
                    {t('send.broadcastNow')}
                  </Button>
                  <Button
                    disabled={sendBusy}
                    type="button"
                    variant="outline"
                    onClick={cancelPreparedSend}
                  >
                    {t('send.cancelBroadcast')}
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {activeView === 'settings' && summary.hd ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="border border-violet-300/15 bg-violet-300/[0.025] py-0">
            <details className="group/search">
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 outline-none transition-colors hover:bg-white/[0.025] focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-violet-300/10">
                <div className="flex items-center gap-2">
                  <Search
                    className="size-4 text-violet-200"
                    aria-hidden="true"
                  />
                  <div>
                    <CardTitle className="text-base text-white">
                      {t('settings.addressSearch')}
                    </CardTitle>
                    <p className="mt-1 text-xs text-slate-500">
                      {t('settings.addressSearchHint')}
                    </p>
                  </div>
                </div>
                <ChevronDown
                  className="size-4 text-slate-500 transition-transform duration-200 group-open/search:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <CardContent className="border-t border-white/[0.06] px-5 pt-4 pb-5">
                <p className="text-xs leading-5 text-slate-500">
                  {t('settings.addressSearchBody')}
                </p>
                <form
                  className="mt-4 grid gap-3 sm:grid-cols-2"
                  onSubmit={recoverRange}
                >
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.account')}
                    <select
                      className={INPUT_CLASS}
                      name="account"
                      defaultValue="1"
                    >
                      <option value="0">{t('settings.accountStandard')}</option>
                      <option value="1">{t('settings.accountOne')}</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.family')}
                    <select
                      className={INPUT_CLASS}
                      name="accountKey"
                      defaultValue="bech32"
                    >
                      {HD_ACCOUNT_TEMPLATES.map((family) => (
                        <option key={family.key} value={family.key}>
                          {family.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.branch')}
                    <select
                      className={INPUT_CLASS}
                      name="branch"
                      defaultValue="external"
                    >
                      <option value="external">
                        {t('settings.externalBranch')}
                      </option>
                      <option value="internal">
                        {t('settings.internalBranch')}
                      </option>
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs font-semibold text-slate-300">
                      {t('settings.from')}
                      <input
                        className={INPUT_CLASS}
                        name="fromIndex"
                        type="number"
                        min="0"
                        max="9999"
                        defaultValue="20"
                        placeholder={t('settings.fromPlaceholder')}
                        required
                      />
                    </label>
                    <label className="text-xs font-semibold text-slate-300">
                      {t('settings.to')}
                      <input
                        className={INPUT_CLASS}
                        name="toIndex"
                        type="number"
                        min="0"
                        max="9999"
                        defaultValue="39"
                        placeholder={t('settings.toPlaceholder')}
                        required
                      />
                    </label>
                  </div>
                  <Button
                    className="sm:col-span-2"
                    disabled={recoveryBusy || network?.status !== 'ready'}
                    type="submit"
                  >
                    {recoveryBusy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Search data-icon="inline-start" />
                    )}
                    {t('settings.inspectSession')}
                  </Button>
                </form>
              </CardContent>
            </details>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function TransactionBroadcastDialog({
  busy,
  canAttemptRbf,
  error,
  isConfirmed,
  originalIsConfirmed,
  onCancelRbf,
  onClose,
  onConfirmRbf,
  onPrepareRbf,
  quote,
  receipt,
}: {
  busy: boolean;
  canAttemptRbf: boolean;
  error?: string;
  isConfirmed: boolean;
  originalIsConfirmed: boolean;
  onCancelRbf: () => void;
  onClose: () => void;
  onConfirmRbf: () => void;
  onPrepareRbf: () => void;
  quote?: TransparentRbfCancellationQuote;
  receipt: BroadcastReceipt;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const isReplacement = Boolean(receipt.replacementOf);
  const replacementFailed = Boolean(isReplacement && originalIsConfirmed);
  const displayedTxid = replacementFailed
    ? receipt.replacementOf!
    : receipt.txid;
  const explorerUrl = nitoTransactionExplorerUrl(displayedTxid);
  const trackingComplete = isConfirmed || replacementFailed;
  const progressValue = trackingComplete ? 100 : 67;
  const progressWidth = trackingComplete ? 'w-full' : 'w-2/3';

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md"
      role="presentation"
    >
      <dialog
        open
        aria-labelledby="transaction-broadcast-title"
        aria-modal="true"
        className="relative m-0 max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-[2rem] border border-sky-200/[0.14] bg-[#071321] p-0 text-slate-100"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`grid size-11 shrink-0 place-items-center rounded-2xl border ${replacementFailed ? 'border-amber-300/20 bg-amber-300/[0.08] text-amber-200' : 'border-emerald-300/15 bg-emerald-300/[0.08] text-emerald-200'}`}
            >
              {replacementFailed ? (
                <CircleAlert className="size-5" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-5" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <h2
                className="text-lg font-black tracking-tight text-white"
                id="transaction-broadcast-title"
              >
                {replacementFailed
                  ? t('transaction.rbfFailed')
                  : isReplacement
                    ? isConfirmed
                      ? t('transaction.rbfConfirmed')
                      : t('transaction.rbfAccepted')
                    : t('transaction.broadcasted')}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {replacementFailed
                  ? t('transaction.originalConfirmed')
                  : isConfirmed
                    ? t('transaction.confirmed')
                    : t('transaction.awaitingConfirmation')}
              </p>
            </div>
          </div>
          <Button
            ref={closeRef}
            aria-label={t('common.close')}
            disabled={busy}
            size="icon"
            type="button"
            variant="ghost"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-5 sm:px-6 sm:py-6">
          <div className="rounded-2xl border border-white/[0.08] bg-slate-950/55 p-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
              {t('transaction.id')}
            </p>
            <a
              className="mt-2 flex items-start gap-2 break-all font-mono text-xs leading-5 text-sky-300 underline decoration-sky-300/30 underline-offset-4 transition hover:text-sky-200 hover:decoration-sky-200 focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-300/15"
              href={explorerUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span>{displayedTxid}</span>
              <ExternalLink
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
            </a>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.018] p-4">
            <progress
              aria-label={t('transaction.confirmationProgress')}
              className="sr-only"
              max={100}
              value={progressValue}
            />
            <div
              aria-hidden="true"
              className="h-2 overflow-hidden rounded-full bg-slate-950/80"
            >
              <div
                className={`h-full rounded-full bg-gradient-to-r transition-[width] duration-700 ${replacementFailed ? 'from-sky-500 via-amber-300 to-amber-400' : 'from-sky-500 via-cyan-300 to-emerald-300'} ${progressWidth}`}
              />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] font-bold uppercase tracking-[0.1em]">
              <span className="text-sky-200">
                {t('transaction.progressBroadcast')}
              </span>
              <span className="text-center text-cyan-200">
                {t('transaction.progressMempool')}
              </span>
              <span
                className={`text-right transition-colors ${replacementFailed ? 'text-amber-200' : isConfirmed ? 'text-emerald-200' : 'text-slate-600'}`}
              >
                {t('transaction.progressConfirmed')}
              </span>
            </div>
          </div>

          {isReplacement ? (
            <output
              className={`block rounded-2xl border p-3 text-xs leading-5 ${replacementFailed ? 'border-amber-300/20 bg-amber-300/[0.05] text-amber-100/85' : isConfirmed ? 'border-emerald-300/20 bg-emerald-300/[0.05] text-emerald-100/85' : 'border-sky-300/20 bg-sky-300/[0.04] text-sky-100/85'}`}
            >
              <p>
                {replacementFailed
                  ? t('transaction.rbfFailedBody')
                  : isConfirmed
                    ? t('transaction.rbfConfirmedBody')
                    : t('transaction.rbfAcceptedBody')}
              </p>
            </output>
          ) : null}

          {quote ? (
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-4">
              <p className="font-bold text-amber-100">
                {t('transaction.rbfConfirmTitle')}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {t('transaction.rbfConfirmBody')}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <SendMetric
                  label={t('transaction.originalFee')}
                  value={`${formatNitoAmount(quote.originalFeeSats)} NITO`}
                />
                <SendMetric
                  label={t('transaction.replacementFee')}
                  value={`${formatNitoAmount(quote.feeSats)} NITO`}
                />
              </div>
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <Button
                  className="border border-red-300/20 bg-red-500 text-white hover:bg-red-400"
                  disabled={busy}
                  type="button"
                  onClick={onConfirmRbf}
                >
                  {busy ? (
                    <LoaderCircle
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <RotateCcw data-icon="inline-start" />
                  )}
                  {t('transaction.rbfConfirmAction')}
                </Button>
                <Button
                  disabled={busy}
                  type="button"
                  variant="outline"
                  onClick={onCancelRbf}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : canAttemptRbf ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.018] p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-slate-500">
                {t('transaction.rbfIntro')}
              </p>
              <Button
                className="shrink-0"
                disabled={busy}
                type="button"
                variant="outline"
                onClick={onPrepareRbf}
              >
                {busy ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <RotateCcw data-icon="inline-start" />
                )}
                {t('transaction.rbfAttempt')}
              </Button>
            </div>
          ) : null}

          {error ? (
            <div
              className="flex gap-3 rounded-xl border border-red-300/20 bg-red-300/[0.05] p-3 text-sm leading-5 text-red-100"
              role="alert"
            >
              <CircleAlert
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {error}
            </div>
          ) : null}

          <Button
            className="w-full"
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
        </div>
      </dialog>
    </div>
  );
}

function ManualSyncCooldownDialog({
  onClose,
  onSynchronize,
  secondsRemaining,
}: {
  onClose: () => void;
  onSynchronize: () => void;
  secondsRemaining: number;
}) {
  const { t } = useI18n();
  const waiting = secondsRemaining > 0;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#020712]/80 p-4 backdrop-blur-sm">
      <dialog
        aria-labelledby="manual-sync-cooldown-title"
        aria-modal="true"
        className="glass-panel relative m-0 max-h-[calc(100dvh-2rem)] w-full max-w-sm overflow-y-auto rounded-3xl border border-sky-200/[0.12] p-0 text-slate-100"
        open
      >
        <div className="p-6">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-2xl border border-sky-300/15 bg-sky-300/[0.08] text-sky-200">
              <RefreshCw className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h2
                className="text-base font-black tracking-tight text-white"
                id="manual-sync-cooldown-title"
              >
                {t(
                  waiting
                    ? 'wallet.refreshCooldownTitle'
                    : 'wallet.refreshReadyTitle',
                )}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                {waiting
                  ? t('wallet.refreshCooldownBody', {
                      seconds: secondsRemaining,
                    })
                  : t('wallet.refreshReadyBody')}
              </p>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
            {!waiting ? (
              <Button type="button" onClick={onSynchronize}>
                <RefreshCw data-icon="inline-start" />
                {t('wallet.refreshNow')}
              </Button>
            ) : null}
          </div>
        </div>
      </dialog>
    </div>
  );
}

function WalletScanGate({
  error,
  network,
  onExit,
  onRetry,
  singleKey,
}: {
  error?: string;
  network?: WalletNetworkState;
  onExit: () => void | Promise<void>;
  onRetry: () => void;
  singleKey: boolean;
}) {
  const { t } = useI18n();
  const completed = network?.progress?.completedAddresses ?? 0;
  const scheduled = network?.progress?.scheduledAddresses ?? 0;
  const percent =
    scheduled > 0 ? Math.min(99, Math.round((completed / scheduled) * 100)) : 0;
  const failed =
    network?.status === 'error' ||
    network?.status === 'stale' ||
    Boolean(error);
  return (
    <div className="flex min-h-[calc(100dvh-8rem)] items-center justify-center py-10">
      <div className="w-full max-w-md text-center">
        <Image
          alt="Logo NITO"
          className={`mx-auto size-20 ${failed ? '' : 'motion-safe:animate-spin [animation-duration:2.8s]'}`}
          height={80}
          priority
          src="/nito-logo.svg"
          width={80}
        />
        <h2 className="mt-6 text-xl font-bold tracking-tight text-white">
          {failed ? t('scan.failedTitle') : t('scan.title')}
        </h2>
        {failed || singleKey ? (
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
            {failed ? t('scan.failedBody') : t('scan.singleKeyBody')}
          </p>
        ) : null}

        <div className="mt-7 overflow-hidden rounded-full bg-white/[0.07]">
          <div
            className={`h-1.5 rounded-full transition-[width] duration-500 ${failed ? 'bg-red-400' : 'bg-[#2f81f7]'}`}
            style={{ width: `${failed ? 100 : Math.max(4, percent)}%` }}
          />
        </div>
        <div className="mt-3 text-center text-[11px] text-slate-600">
          <span>{networkLabel(network, t)}</span>
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-red-300/20 bg-red-300/[0.05] p-3 text-left text-sm leading-6 text-red-100"
          >
            {error}
          </div>
        ) : null}
        {failed ? (
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <Button type="button" onClick={onRetry}>
              <RefreshCw data-icon="inline-start" />
              {t('scan.retry')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => void onExit()}>
              <LockKeyhole data-icon="inline-start" />
              {t('wallet.exit')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SendMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-slate-950/45 p-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">
        {label}
      </p>
      <p className="mt-2 font-mono text-sm font-bold text-slate-100">{value}</p>
    </div>
  );
}
