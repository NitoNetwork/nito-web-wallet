'use client';

import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Dice5,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  type ComponentProps,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/info-tip';
import { RecoveryPhraseCopy } from '@/components/recovery-phrase-copy';
import { CryptoWorkerClient } from '@/src/crypto/cryptoWorkerClient';
import type { WalletSessionSummary } from '@/src/crypto/workerProtocol';
import {
  WALLET_SOURCE_POLICIES,
  type WalletSourceKind,
} from '@/src/domain/wallet-policy';
import { useI18n } from '@/src/i18n';
import { translateWalletError } from '@/src/i18nError';
import { createSeedBackupWordIndexes } from '@/src/services/seedBackup';
import {
  clearAndDisableBrowserCredentialFields,
  enableBrowserCredentialFields,
} from '@/src/security/browserCredentialGate';
import {
  loadBrowserLockPreferences,
  storeBrowserLockPreferences,
  type LockPreferences,
} from '@/src/security/lockPreferenceStorage';
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  DEFAULT_BACKGROUND_LOCK_SECONDS,
  type AutoLockMinutes,
  type BackgroundLockSeconds,
} from '@/src/security/sessionPolicy';
import { PhysicalDiceEntropySession } from '@/src/ui/diceEntropy';
import { useAutoDismiss } from '@/src/ui/useAutoDismiss';
import type { HdAddressDeriver } from '@/src/wallet/transparentScan';
import type { TransparentPsbtSigner } from '@/src/wallet/transparentSend';
import type { MnemonicReveal } from './wallet-dashboard';

const WalletDashboard = lazy(() =>
  import('./wallet-dashboard').then((module) => ({
    default: module.WalletDashboard,
  })),
);

const EMAIL_FIELD = 'username';
const PASSWORD_FIELD = 'password';
const INPUT_CLASS =
  'mt-2 min-h-12 w-full rounded-2xl border border-sky-200/[0.12] bg-[#050d1a] px-4 py-3 text-sm text-slate-100 outline-none transition-all duration-200 placeholder:text-slate-600 hover:border-sky-200/20 hover:bg-[#07111f] focus:border-sky-300/55 focus:ring-4 focus:ring-sky-300/10';
const SOURCE_ICONS: Record<WalletSourceKind, typeof Fingerprint> = {
  'bip39-hd': Fingerprint,
  'single-private-key': KeyRound,
  'email-credentials': Mail,
};
const ACCESS_SOURCE_ORDER: readonly WalletSourceKind[] = [
  'email-credentials',
  'bip39-hd',
  'single-private-key',
];

type PendingCreation =
  | {
      summary: WalletSessionSummary;
      mnemonic: string;
      wordIndexes: readonly number[];
      stage: 'backup';
    }
  | {
      summary: WalletSessionSummary;
      wordIndexes: readonly number[];
      stage: 'verify';
    };

function formField<
  T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
>(form: HTMLFormElement, name: string): T {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLElement)) throw new Error('FORM_FIELD_MISSING');
  return field as T;
}

function SecretInput({
  label,
  revealed,
  onToggle,
  className = '',
  ...props
}: ComponentProps<'input'> & {
  label: string;
  revealed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <label className={`text-xs font-semibold text-slate-300 ${className}`}>
      {label}
      <span className="relative mt-2 block">
        <input
          {...props}
          className={`${INPUT_CLASS} mt-0 pr-12 font-mono`}
          type={revealed ? 'text' : 'password'}
        />
        <button
          type="button"
          aria-label={t(revealed ? 'common.hideField' : 'common.showField', {
            label,
          })}
          aria-pressed={revealed}
          className="absolute inset-y-1 right-1 grid w-10 place-items-center rounded-xl text-slate-500 outline-none transition-all duration-200 hover:bg-white/[0.06] hover:text-sky-200 focus-visible:ring-2 focus-visible:ring-sky-300/30"
          onClick={onToggle}
        >
          {revealed ? (
            <EyeOff className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
        </button>
      </span>
    </label>
  );
}

export function WalletAccessWorkspace() {
  const { t } = useI18n();
  const [source, setSource] = useState<WalletSourceKind>('email-credentials');
  const [bip39Mode, setBip39Mode] = useState<'create' | 'import'>('import');
  const [mnemonicVisible, setMnemonicVisible] = useState(false);
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [emailPasswordVisible, setEmailPasswordVisible] = useState(false);
  const [emailCredentialsEnabled, setEmailCredentialsEnabled] = useState(false);
  const [lockPreferences, setLockPreferences] = useState<LockPreferences>(
    () =>
      loadBrowserLockPreferences() ?? {
        autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
        backgroundLockSeconds: DEFAULT_BACKGROUND_LOCK_SECONDS,
      },
  );
  const { autoLockMinutes, backgroundLockSeconds } = lockPreferences;
  const [activeWallet, setActiveWallet] = useState<WalletSessionSummary>();
  const [sessionActive, setSessionActive] = useState(false);
  const [pendingCreation, setPendingCreation] = useState<PendingCreation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [diceEnabled, setDiceEnabled] = useState(false);
  const [diceCount, setDiceCount] = useState(0);
  const [diceSession] = useState(() => new PhysicalDiceEntropySession());
  const clientRef = useRef(new CryptoWorkerClient());
  const sessionRef = useRef<WalletSessionSummary | undefined>(undefined);
  const emailCredentialFormRef = useRef<HTMLFormElement>(null);

  const setAutoLockMinutes = useCallback((minutes: AutoLockMinutes) => {
    setLockPreferences((preferences) => ({
      ...preferences,
      autoLockMinutes: minutes,
    }));
  }, []);

  const setBackgroundLockSeconds = useCallback(
    (seconds: BackgroundLockSeconds) => {
      setLockPreferences((preferences) => ({
        ...preferences,
        backgroundLockSeconds: seconds,
      }));
    },
    [],
  );

  const clearEmailCredentialDom = useCallback(() => {
    const form = emailCredentialFormRef.current;
    if (form) {
      const email = form.elements.namedItem(EMAIL_FIELD);
      const password = form.elements.namedItem(PASSWORD_FIELD);
      if (
        email instanceof HTMLInputElement &&
        password instanceof HTMLInputElement
      ) {
        clearAndDisableBrowserCredentialFields(form, email, password);
      }
    }
  }, []);

  const clearEmailCredentialFields = useCallback(() => {
    clearEmailCredentialDom();
    setEmailCredentialsEnabled(false);
    setEmailPasswordVisible(false);
  }, [clearEmailCredentialDom]);

  const enableEmailCredentialFields = useCallback(() => {
    const form = emailCredentialFormRef.current;
    if (form) {
      const email = form.elements.namedItem(EMAIL_FIELD);
      const password = form.elements.namedItem(PASSWORD_FIELD);
      if (
        email instanceof HTMLInputElement &&
        password instanceof HTMLInputElement
      ) {
        enableBrowserCredentialFields(form, email, password);
      }
    }
    setEmailCredentialsEnabled(true);
  }, []);

  const deriveAddresses = useCallback<HdAddressDeriver>(
    (sessionId, requests) =>
      clientRef.current.request({
        type: 'deriveAddresses',
        sessionId,
        requests,
      }),
    [],
  );
  const signPsbt = useCallback<TransparentPsbtSigner>(
    (sessionId, psbtBase64, signers) =>
      clientRef.current.request({
        type: 'signPsbt',
        sessionId,
        psbtBase64,
        signers,
      }),
    [],
  );
  const revealMnemonic = useCallback<MnemonicReveal>(async (password) => {
    const session = sessionRef.current;
    if (!session) {
      throw Object.assign(new Error('SESSION_LOCKED'), {
        code: 'SESSION_LOCKED',
      });
    }
    return clientRef.current.request({
      type: 'revealMnemonic',
      sessionId: session.sessionId,
      ...(password === undefined ? {} : { password }),
    });
  }, []);

  const destroySession = useCallback(
    (message?: string) => {
      sessionRef.current = undefined;
      setSessionActive(false);
      setActiveWallet(undefined);
      setPendingCreation(undefined);
      setNotice(message ?? t('notice.sessionDestroyed'));
      // Terminate synchronously instead of waiting for a round trip: leaving the
      // wallet must destroy the Worker even if WASM or the event loop is stuck.
      clientRef.current.dispose();
    },
    [t],
  );

  useAutoDismiss(notice, setNotice);

  useEffect(() => {
    storeBrowserLockPreferences(lockPreferences);
  }, [lockPreferences]);

  useEffect(
    () => () => {
      diceSession.clear();
      sessionRef.current = undefined;
      clientRef.current.dispose();
    },
    [diceSession],
  );

  useEffect(() => {
    // The wallet never restores credentials itself. Browser password managers
    // may fill this empty form, but credentials are still erased when leaving.
    window.addEventListener('pagehide', clearEmailCredentialFields);
    return () => {
      window.removeEventListener('pagehide', clearEmailCredentialFields);
      clearEmailCredentialDom();
    };
  }, [clearEmailCredentialDom, clearEmailCredentialFields]);

  useEffect(() => {
    if (!activeWallet) return;
    let timer: ReturnType<typeof setTimeout>;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          destroySession(
            t('notice.sessionInactive', { minutes: autoLockMinutes }),
          ),
        autoLockMinutes * 60 * 1_000,
      );
    };
    for (const eventName of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(eventName, resetTimer, { passive: true });
    }
    resetTimer();
    return () => {
      clearTimeout(timer);
      for (const eventName of [
        'pointerdown',
        'keydown',
        'touchstart',
      ] as const) {
        window.removeEventListener(eventName, resetTimer);
      }
    };
  }, [activeWallet, autoLockMinutes, destroySession, t]);

  useEffect(() => {
    if (!activeWallet && !pendingCreation) return;
    let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
    let hiddenAt: number | undefined;
    const clearBackgroundTimer = () => {
      if (backgroundTimer !== undefined) clearTimeout(backgroundTimer);
      backgroundTimer = undefined;
    };
    const destroySensitivePage = () => {
      clearBackgroundTimer();
      hiddenAt = undefined;
      destroySession(
        backgroundLockSeconds === 0
          ? t('notice.sessionBackgroundImmediate')
          : t('notice.sessionBackground', {
              seconds: backgroundLockSeconds,
            }),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (pendingCreation) {
          destroySensitivePage();
          return;
        }
        hiddenAt = Date.now();
        clearBackgroundTimer();
        if (backgroundLockSeconds === 0) {
          destroySensitivePage();
          return;
        }
        backgroundTimer = setTimeout(
          destroySensitivePage,
          backgroundLockSeconds * 1_000,
        );
        return;
      }
      if (
        hiddenAt !== undefined &&
        Date.now() - hiddenAt >= backgroundLockSeconds * 1_000
      ) {
        destroySensitivePage();
        return;
      }
      hiddenAt = undefined;
      clearBackgroundTimer();
    };
    const blurPendingBackup = () => {
      if (pendingCreation) destroySensitivePage();
    };
    const restoreFromPageCache = (event: PageTransitionEvent) => {
      if (event.persisted) destroySensitivePage();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', destroySensitivePage);
    window.addEventListener('pageshow', restoreFromPageCache);
    // A generated phrase is stricter than an unlocked wallet: leaving its
    // browser window destroys the creation flow even if visibility stays visible.
    if (pendingCreation) window.addEventListener('blur', blurPendingBackup);
    return () => {
      clearBackgroundTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', destroySensitivePage);
      window.removeEventListener('pageshow', restoreFromPageCache);
      window.removeEventListener('blur', blurPendingBackup);
    };
  }, [activeWallet, backgroundLockSeconds, destroySession, pendingCreation, t]);

  const activate = (summary: WalletSessionSummary) => {
    sessionRef.current = summary;
    setSessionActive(true);
    setActiveWallet(summary);
    setError(undefined);
    setNotice(undefined);
  };

  async function createMnemonic(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const wordCount = Number(
      formField<HTMLSelectElement>(form, 'wordCount').value,
    ) as 12 | 24;
    setBusy(true);
    setError(undefined);
    try {
      const diceEntropyBase64 = diceEnabled
        ? diceSession.entropyDigestBase64()
        : undefined;
      const created = await clientRef.current.request({
        type: 'createMnemonic',
        wordCount,
        ...(diceEntropyBase64 ? { diceEntropyBase64 } : {}),
      });
      const { mnemonic, ...summary } = created;
      // Do not let the transport-only mnemonic property leak into either the
      // session ref or the verification-stage summary object.
      created.mnemonic = '';
      sessionRef.current = summary;
      setPendingCreation({
        summary,
        mnemonic,
        wordIndexes: createSeedBackupWordIndexes(
          summary.wordCount ?? wordCount,
        ),
        stage: 'backup',
      });
      diceSession.clear();
      setDiceCount(0);
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    } finally {
      setBusy(false);
    }
  }

  async function verifyMnemonicBackup(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = pendingCreation;
    if (!current || current.stage !== 'verify') return;
    const form = event.currentTarget;
    const fields = current.wordIndexes.map((_, index) =>
      formField<HTMLInputElement>(form, `backupWord-${index}`),
    );
    setBusy(true);
    setError(undefined);
    try {
      const result = await clientRef.current.request({
        type: 'verifyMnemonicBackup',
        sessionId: current.summary.sessionId,
        answers: current.wordIndexes.map((wordIndex, index) => ({
          wordIndex,
          word: fields[index]!.value,
        })),
      });
      if (!result.valid) {
        setPendingCreation({
          ...current,
          wordIndexes: createSeedBackupWordIndexes(
            current.summary.wordCount ?? 24,
          ),
        });
        setError(t('errors.backupIncorrect'));
        return;
      }
      setPendingCreation(undefined);
      activate(current.summary);
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    } finally {
      for (const field of fields) field.value = '';
      setBusy(false);
    }
  }

  async function importMnemonic(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = formField<HTMLInputElement>(event.currentTarget, 'mnemonic');
    setBusy(true);
    setError(undefined);
    try {
      activate(
        await clientRef.current.request({
          type: 'importMnemonic',
          mnemonic: field.value,
        }),
      );
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    } finally {
      field.value = '';
      setBusy(false);
    }
  }

  async function importPrivateKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = formField<HTMLInputElement>(
      event.currentTarget,
      'privateKey',
    );
    setBusy(true);
    setError(undefined);
    try {
      activate(
        await clientRef.current.request({
          type: 'importPrivateKey',
          privateKey: field.value,
        }),
      );
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    } finally {
      field.value = '';
      setBusy(false);
    }
  }

  async function importEmailCredentials(
    event: SyntheticEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formField<HTMLInputElement>(form, EMAIL_FIELD);
    const password = formField<HTMLInputElement>(form, PASSWORD_FIELD);
    setBusy(true);
    setError(undefined);
    try {
      activate(
        await clientRef.current.request({
          type: 'importEmailCredentials',
          email: email.value,
          password: password.value,
        }),
      );
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    } finally {
      clearEmailCredentialFields();
      setBusy(false);
    }
  }

  function addDieResult(value: number) {
    try {
      diceSession.append(value);
      setDiceCount(diceSession.count);
      setError(undefined);
    } catch (caught) {
      setError(translateWalletError(caught, t, 'local'));
    }
  }

  if (activeWallet && sessionActive) {
    return (
      <section className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <Suspense
          fallback={
            <div className="flex min-h-[calc(100dvh-8rem)] items-center justify-center">
              <LoaderCircle
                className="size-8 animate-spin text-sky-300"
                aria-hidden="true"
              />
              <span className="sr-only">{t('scan.title')}</span>
            </div>
          }
        >
          <WalletDashboard
            summary={activeWallet}
            autoLockMinutes={autoLockMinutes}
            backgroundLockSeconds={backgroundLockSeconds}
            deriveAddresses={deriveAddresses}
            signPsbt={signPsbt}
            revealMnemonic={revealMnemonic}
            onAutoLockMinutesChange={setAutoLockMinutes}
            onBackgroundLockSecondsChange={setBackgroundLockSeconds}
            onLock={destroySession}
          />
        </Suspense>
      </section>
    );
  }

  if (pendingCreation) {
    const showingBackup = pendingCreation.stage === 'backup';
    return (
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <Card className="border border-amber-300/20 bg-[#091221] py-0">
          <CardHeader className="px-5 pt-5">
            <p className="text-xs font-black uppercase tracking-[0.14em] text-amber-300">
              {t('backup.required')}
            </p>
            <CardTitle className="mt-2 text-xl text-white">
              {showingBackup
                ? t('backup.noteWords', {
                    count: pendingCreation.summary.wordCount ?? 24,
                  })
                : t('backup.verificationTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {error ? <ErrorNotice message={error} /> : null}
            {showingBackup ? (
              <>
                <ol className="grid gap-2 sm:grid-cols-3">
                  {pendingCreation.mnemonic.split(' ').map((word, index) => (
                    <li
                      key={`${index}-${word}`}
                      className="rounded-lg border border-white/8 bg-slate-950/60 px-3 py-2 font-mono text-sm text-slate-100"
                    >
                      <span className="mr-2 text-[10px] text-slate-600">
                        {index + 1}
                      </span>
                      {word}
                    </li>
                  ))}
                </ol>
                <RecoveryPhraseCopy
                  description={t('backup.creationNoTimeout')}
                  mnemonic={pendingCreation.mnemonic}
                />
                <Button
                  className="mt-5 w-full"
                  type="button"
                  onClick={() => {
                    setError(undefined);
                    setPendingCreation({
                      summary: pendingCreation.summary,
                      wordIndexes: pendingCreation.wordIndexes,
                      stage: 'verify',
                    });
                  }}
                >
                  {t('backup.continueVerification')}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </>
            ) : (
              <p className="text-sm leading-6 text-slate-400">
                {t('backup.verificationIntro')}
              </p>
            )}
            {!showingBackup ? (
              <form className="mt-5" onSubmit={verifyMnemonicBackup}>
                <div className="grid gap-3 rounded-xl border border-amber-300/20 bg-slate-950/45 p-4 sm:grid-cols-3">
                  {pendingCreation.wordIndexes.map((wordIndex, index) => (
                    <label
                      key={wordIndex}
                      className="text-xs font-semibold text-amber-50"
                    >
                      {t('backup.verification', {
                        current: index + 1,
                        total: pendingCreation.wordIndexes.length,
                        index: wordIndex + 1,
                      })}
                      <input
                        className={`${INPUT_CLASS} font-mono`}
                        name={`backupWord-${index}`}
                        type="password"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        placeholder={t('backup.wordPlaceholder', {
                          index: wordIndex + 1,
                        })}
                        required
                      />
                    </label>
                  ))}
                </div>
                <Button className="mt-4 w-full" type="submit" disabled={busy}>
                  {busy ? <LoaderCircle className="animate-spin" /> : null}
                  {t('backup.verifyComplete')}
                </Button>
              </form>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => destroySession(t('notice.creationCancelled'))}
              >
                {showingBackup ? <ArrowLeft data-icon="inline-start" /> : null}
                {t('common.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col px-4 py-9 sm:px-6 sm:py-14">
      <div className="mb-7 text-center sm:mb-10">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-sky-300/15 bg-sky-300/[0.055] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-sky-200/85">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t('access.badge')}
        </div>
        <h1 className="text-3xl font-black tracking-[-0.035em] text-white sm:text-4xl">
          {t('access.title')}
        </h1>
      </div>

      {error ? <ErrorNotice message={error} /> : null}
      {notice ? (
        <div className="flex gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.045] p-3 text-sm text-emerald-100">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {notice}
        </div>
      ) : null}
      <Card className="glass-panel subtle-shine bg-transparent py-0">
        <div className="grid min-h-[470px] md:grid-cols-[280px_minmax(0,1fr)]">
          <div
            className="grid grid-cols-3 gap-1.5 border-b border-white/[0.07] bg-slate-950/20 p-2.5 md:grid-cols-1 md:content-start md:border-r md:border-b-0 md:p-4"
            role="tablist"
            aria-label={t('access.sourceAria')}
          >
            {ACCESS_SOURCE_ORDER.map((kind) => {
              const policy = WALLET_SOURCE_POLICIES.find(
                (entry) => entry.kind === kind,
              )!;
              const Icon = SOURCE_ICONS[policy.kind];
              const active = source === policy.kind;
              return (
                <button
                  key={policy.kind}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    clearEmailCredentialFields();
                    setSource(policy.kind);
                    setError(undefined);
                    setMnemonicVisible(false);
                    setPrivateKeyVisible(false);
                    setEmailPasswordVisible(false);
                  }}
                  className={`group/source flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl border px-2 text-center text-[11px] font-bold outline-none transition-all duration-200 sm:text-xs md:min-h-16 md:flex-row md:justify-start md:gap-3 md:px-4 md:text-left ${active ? 'border-sky-300/30 bg-[#1769c2] text-white' : 'border-transparent text-slate-500 hover:-translate-y-0.5 hover:border-sky-200/10 hover:bg-white/[0.035] hover:text-slate-200 focus-visible:border-sky-300/30 focus-visible:ring-4 focus-visible:ring-sky-300/10'}`}
                >
                  <span
                    className={`grid size-8 place-items-center rounded-xl transition-all duration-200 ${active ? 'bg-white/12' : 'bg-white/[0.035] group-hover/source:bg-white/[0.07]'}`}
                  >
                    <Icon
                      className="size-4 transition-transform duration-200 group-hover/source:scale-110"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 break-words">
                    {t(
                      policy.kind === 'email-credentials'
                        ? 'source.email'
                        : policy.kind === 'bip39-hd'
                          ? 'source.bip39'
                          : 'source.privateKey',
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-col justify-center p-5 sm:p-8 lg:p-11">
            {source === 'bip39-hd' ? (
              <p className="mb-7 max-w-xl text-sm leading-6 text-slate-400">
                {t('source.bip39Description')}
              </p>
            ) : null}

            {source === 'bip39-hd' ? (
              <div>
                <div className="mb-6 grid grid-cols-2 rounded-2xl border border-white/[0.06] bg-slate-950/55 p-1.5">
                  {(['import', 'create'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={bip39Mode === mode}
                      onClick={() => {
                        setBip39Mode(mode);
                        setError(undefined);
                      }}
                      className={`min-h-10 rounded-xl border px-3 py-2 text-xs font-bold outline-none transition-all duration-200 ${bip39Mode === mode ? 'border-sky-200/15 bg-[#10243d] text-white' : 'border-transparent text-slate-500 hover:bg-white/[0.035] hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-sky-300/25'}`}
                    >
                      {mode === 'import'
                        ? t('access.import')
                        : t('access.create')}
                    </button>
                  ))}
                </div>

                {bip39Mode === 'create' ? (
                  <div>
                    <h2 className="mb-5 text-lg font-black tracking-tight text-white">
                      {t('access.newPhrase')}
                    </h2>
                    <form className="space-y-4" onSubmit={createMnemonic}>
                      <label className="text-xs font-semibold text-slate-300">
                        {t('access.length')}
                        <select
                          className={INPUT_CLASS}
                          name="wordCount"
                          defaultValue="24"
                        >
                          <option value="24">{t('access.words24')}</option>
                          <option value="12">{t('access.words12')}</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-3 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          checked={diceEnabled}
                          onChange={(event) => {
                            setDiceEnabled(event.target.checked);
                            if (!event.target.checked) {
                              diceSession.clear();
                              setDiceCount(0);
                            }
                          }}
                        />
                        {t('access.dice')}
                      </label>
                      {diceEnabled ? (
                        <div className="rounded-xl border border-white/8 bg-slate-950/45 p-3">
                          <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>
                              {t('access.rolls', { count: diceCount })}
                            </span>
                            <button
                              type="button"
                              className="text-sky-300"
                              onClick={() => {
                                diceSession.clear();
                                setDiceCount(0);
                              }}
                            >
                              {t('access.clear')}
                            </button>
                          </div>
                          <div className="mt-3 grid grid-cols-6 gap-2">
                            {[1, 2, 3, 4, 5, 6].map((value) => (
                              <Button
                                key={value}
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={diceSession.complete}
                                onClick={() => addDieResult(value)}
                              >
                                {value}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <Button
                        disabled={busy}
                        size="lg"
                        type="submit"
                        className="w-full"
                      >
                        {busy ? (
                          <LoaderCircle
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : (
                          <Dice5 data-icon="inline-start" />
                        )}{' '}
                        {t('access.generate')}
                      </Button>
                    </form>
                  </div>
                ) : (
                  <div>
                    <h2 className="mb-5 text-lg font-black tracking-tight text-white">
                      {t('access.restore')}
                    </h2>
                    <form
                      className="space-y-4"
                      onSubmit={importMnemonic}
                      autoComplete="off"
                    >
                      <SecretInput
                        autoCapitalize="none"
                        autoComplete="off"
                        autoCorrect="off"
                        label={t('access.phrase')}
                        name="mnemonic"
                        onToggle={() =>
                          setMnemonicVisible((visible) => !visible)
                        }
                        placeholder={t('access.phrasePlaceholder')}
                        required
                        revealed={mnemonicVisible}
                        spellCheck={false}
                      />
                      <Button
                        disabled={busy}
                        size="lg"
                        type="submit"
                        className="w-full"
                      >
                        {busy ? (
                          <LoaderCircle
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : null}
                        {t('access.openSync')}
                      </Button>
                    </form>
                  </div>
                )}
              </div>
            ) : null}

            {source === 'single-private-key' ? (
              <div>
                <h2 className="mb-5 text-lg font-black tracking-tight text-white">
                  {t('access.privateTitle')}
                </h2>
                <form
                  className="space-y-4"
                  onSubmit={importPrivateKey}
                  autoComplete="off"
                >
                  <SecretInput
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    label={t('access.privateLabel')}
                    name="privateKey"
                    onToggle={() => setPrivateKeyVisible((visible) => !visible)}
                    placeholder={t('access.privatePlaceholder')}
                    required
                    revealed={privateKeyVisible}
                    spellCheck={false}
                  />
                  <Button
                    disabled={busy}
                    size="lg"
                    type="submit"
                    className="w-full"
                  >
                    {busy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    {t('access.openSync')}
                  </Button>
                </form>
              </div>
            ) : null}

            {source === 'email-credentials' ? (
              <div>
                <div className="mb-5 flex items-center gap-2">
                  <h2 className="text-lg font-black tracking-tight text-white">
                    {t('access.emailTitle')}
                  </h2>
                  <InfoTip label={t('access.emailInfoLabel')}>
                    <span className="block">{t('access.emailIntro')}</span>
                    <span className="mt-2 block italic text-amber-100/90">
                      {t('access.emailExactWarning')}
                    </span>
                    <span className="mt-2 block">
                      {t('access.emailSeedAvailable')}
                    </span>
                  </InfoTip>
                </div>
                <form
                  ref={emailCredentialFormRef}
                  className="grid gap-4 sm:grid-cols-2"
                  onSubmit={importEmailCredentials}
                  autoComplete={emailCredentialsEnabled ? 'on' : 'off'}
                >
                  <label className="text-xs font-semibold text-slate-300">
                    {t('access.emailLabel')}
                    <input
                      className={INPUT_CLASS}
                      name={EMAIL_FIELD}
                      type="email"
                      required
                      autoCapitalize="none"
                      autoComplete={
                        emailCredentialsEnabled ? 'username' : 'off'
                      }
                      autoCorrect="off"
                      onFocus={enableEmailCredentialFields}
                      onPointerDown={enableEmailCredentialFields}
                      placeholder={t('access.emailPlaceholder')}
                      readOnly={!emailCredentialsEnabled}
                      spellCheck={false}
                    />
                  </label>
                  <SecretInput
                    autoComplete={
                      emailCredentialsEnabled ? 'current-password' : 'off'
                    }
                    autoCapitalize="none"
                    autoCorrect="off"
                    label={t('access.passwordLabel')}
                    minLength={8}
                    name={PASSWORD_FIELD}
                    onFocus={enableEmailCredentialFields}
                    onPointerDown={enableEmailCredentialFields}
                    onToggle={() =>
                      setEmailPasswordVisible((visible) => !visible)
                    }
                    placeholder={t('access.passwordPlaceholder')}
                    required
                    readOnly={!emailCredentialsEnabled}
                    revealed={emailPasswordVisible}
                    spellCheck={false}
                  />
                  <Button
                    disabled={busy}
                    size="lg"
                    type="submit"
                    className="w-full sm:col-span-2"
                  >
                    {busy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    {t('access.openSync')}
                  </Button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <p className="mt-6 flex items-center justify-center gap-2 text-center text-[11px] font-medium leading-5 text-slate-500">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
        {t('access.noSecret')}
      </p>
    </section>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-4 flex gap-3 rounded-xl border border-red-300/25 bg-red-300/[0.06] p-3 text-sm text-red-100"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}
