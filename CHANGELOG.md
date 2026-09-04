# Changelog

## 1.1.0 — 2026-09-04

- Add a dedicated My UTXOs tab with five outputs per page and direct page selection.
- Show each output's owning address, address family, local timestamp, confirmations, and spendability, including pending payments and immature mining rewards.
- Keep UTXO details updated through the existing synchronization and block subscriptions.
- Select payment change addresses automatically from supported recipient address types.
- Prefer proportionate UTXOs within a fee premium of up to 25%, capped at 1,000 nitoshis, without increasing input count or funded value relative to the cheapest candidate.
- Expand regression coverage for UTXO selection, automatic change, MAX, consolidation, and RBF using the Rust/WASM signer.

Wallet access methods and recovery phrases remain unchanged.

## 1.0.0

- Initial public release.
