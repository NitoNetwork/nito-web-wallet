# Security Model

## Accepted wallet sources

The wallet accepts 12-word and 24-word BIP39 phrases, NITO mainnet WIF keys, 32-byte hexadecimal private keys, and deterministic email/password pairs. XPRV input is intentionally unsupported.

Email and password input is local derivation, not remote authentication. Any change in capitalization, whitespace, or characters can produce a different wallet. Weak credential pairs may be vulnerable to offline guessing.

## Secret boundary

Sensitive form values are sent directly to a dedicated Web Worker. Rust/WASM validates wallet material, derives addresses, and signs PSBTs inside that Worker.

Unlocked recovery phrases and private keys are stored in AES-256-GCM in-memory vaults under non-extractable Web Crypto keys. The Worker decrypts them only for the duration of an authorized operation and clears mutable buffers afterwards. Deterministic email wallets use a password-derived encryption key, and recovery phrase display requires the original password again.

Generated recovery phrases are shown only on the backup screen. Moving to verification removes the phrase from the interface and returning to that screen is not possible. Leaving the page, changing windows during creation, locking the wallet, reaching an inactivity limit, or exceeding the configured background limit terminates the Worker and returns to wallet access.

JavaScript strings are immutable, so a browser cannot guarantee immediate physical erasure of every previous string allocation. Removing references, clearing mutable buffers, encrypting in-memory secrets, and terminating the Worker reduce exposure but do not make a compromised runtime trustworthy.

## Browser storage

The application does not persist wallet secrets, credentials, snapshots, balances, UTXOs, transaction IDs, address allocations, or drafts in IndexedDB, local storage, session storage, cookies, or the Cache API.

Only the inactivity and background lock preferences are stored in the browser. HTTP responses use `Cache-Control: no-store`.

## Synchronization integrity

The dashboard is unavailable until the initial Electrum scan completes. HD discovery treats non-empty history as usage even when the current balance is zero and requires 20 consecutive unused addresses per covered sequence.

Electrum read failures, inconsistent balance and UTXO data, reorganization signals, and disconnections prevent a stale snapshot from being used for spending. Address subscriptions update known addresses, and new block notifications refresh pending transactions and immature coinbase outputs. A normal block does not trigger a complete HD discovery scan.

## Transaction safety

Preview, signing, and broadcast are separate user actions. Input ownership, derivation paths, scripts, amounts, and the final transaction ID are verified before the in-memory wallet state is updated.

RBF cancellation signs a competing transaction using the same inputs and a higher fee. It remains an attempt until one transaction confirms. The wallet tracks both candidates and reports whether the replacement or the original transaction won.

## Out-of-scope threats

A malicious browser extension, same-origin script injection, compromised browser, operating system, or device can capture input or memory during an unlocked session. Use a dedicated trusted browser profile and keep recovery material offline.

Private Orchard/Bech32x transactions are not exposed without a linked and tested native implementation.
