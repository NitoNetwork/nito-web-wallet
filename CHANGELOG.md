# Changelog

## 1.2.1 — 2026-11-07

- Use the same concise, two-line BIP39 passphrase explanation when creating and restoring a wallet in all nine interface languages.

## 1.2.0 — 2026-11-07

- Add an optional BIP39 passphrase when creating or restoring an HD wallet.
- Keep the passphrase in browser-only session memory and clear it with the wallet's other sensitive material.
- Preserve compatibility with wallets created without a passphrase and explain the distinct-wallet behavior in all nine interface languages.

## 1.1.3 — 2026-11-01

- Display the current wallet version in the footer with a direct link to its matching GitHub release tag.
- Allow inactivity and tab-change session locking to be disabled with a translated “Never” option.
- Keep disabled lock preferences in the same browser-only settings entry without storing any additional wallet data.

## 1.1.2 — 2026-11-01

- Update vulnerable build and runtime dependencies to patched releases while preserving the existing standalone deployment architecture.
- Replace the Nito logo and all favicon sizes with the new transparent brand artwork.
- Strengthen standalone smoke tests, supply-chain checks, and reproducible-build validation for the updated dependency tree.

## 1.1.1 — 2026-09-08

- Display the selected receive address's HD index.
- Choose the lowest unused receive index, skipping addresses already issued during the session.
- Verify newly discovered receive addresses before presenting them as unused, and serialize address reservations.
- Explain address reuse and privacy in all nine interface languages.

## 1.1.0 — 2026-09-04

- Keep the complete home balance and currency on one line, adapting to screen width and font changes without rounding or truncating amounts.
- Add a dedicated My UTXOs tab with five outputs per page and direct page selection.
- Show each output's owning address, address family, local timestamp, confirmations, and spendability, including pending payments and immature mining rewards.
- Keep UTXO details updated through the existing synchronization and block subscriptions.
- Select payment change addresses automatically from supported recipient address types.
- Prefer proportionate UTXOs within a fee premium of up to 25%, capped at 1,000 nitoshis, without increasing input count or funded value relative to the cheapest candidate.
- Expand regression coverage for UTXO selection, automatic change, MAX, consolidation, and RBF using the Rust/WASM signer.

Wallet access methods and recovery phrases remain unchanged.

## 1.0.0

- Initial public release.
