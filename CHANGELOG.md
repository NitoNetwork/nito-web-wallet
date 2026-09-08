# Changelog

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
