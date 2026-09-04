# Architecture

## Runtime boundaries

The React interface owns transient view state only. A dedicated Web Worker owns wallet sessions and calls the Rust/WASM cryptographic core for mnemonic generation, key derivation, address derivation, and PSBT signing. Electrum clients run outside the Worker and receive public addresses and signed transactions, never wallet secrets.

No backend account, application database, or wallet storage service is required.

## Wallet sources

The wallet supports three sources:

1. BIP39 HD wallets with 12-word or 24-word recovery phrases.
2. Deterministic email wallets derived locally from an exact email and password pair.
3. A single WIF or hexadecimal private key.

HD wallets cover accounts 0 and 1, external and internal branches, and BIP44, BIP49, BIP84, and BIP86 address families. Single-key wallets cover Legacy, P2SH, and Bech32 addresses for the same scalar.

## Synchronization

The initial HD synchronization proves address discovery with a gap limit of 20 unused addresses. An address with transaction history is considered used even when its balance is zero. The first balance is published only after all required sequences have completed successfully.

During an unlocked session, Electrum address subscriptions update known addresses. A newly used address extends HD discovery only when necessary. New block notifications refresh pending transactions and immature coinbase outputs without repeating a complete HD scan.

## Transactions

Preview, signing, and broadcast are separate steps. The signer receives the exact owner and derivation metadata for each selected UTXO. The transaction ID returned by Electrum must match the locally calculated transaction ID.

Ordinary payments compare the default funding selection, its largest-first fallback, and each individually sufficient UTXO. The baseline is the lowest estimated total miner fee (including discarded dust), with ties resolved by input count and total input value. A more proportionate selection may cost up to 25% extra, rounded down and capped at 1,000 nitoshis (0.00001 NITO). This budget is fixed against the cheapest quote, never increased as candidates are considered. Eligible alternatives cannot increase input count or total input value relative to the baseline; they are ranked by input count, then total input value, then fee. This favors a smaller sufficient UTXO across address families when the additional cost is small, without blindly accumulating small outputs or paying excessive fees.

Script-specific input and change costs are calculated by the transaction library. The search is bounded, not an exhaustive subset optimizer or a reproduction of Bitcoin Core coin selection. Preview and signing use the same deterministic policy and display the full selected fee, with no additional network requests. Pending and immature outputs remain ineligible; MAX and consolidation retain their existing funding strategy, and RBF retains the original inputs.

Accepted broadcasts are projected into the in-memory snapshot immediately and reconciled with Electrum. RBF cancellation tracks both competing transactions: the dialog confirms the replacement when it wins, or reports failure and links to the original transaction when the original confirms first.

Payment change uses the highest-priority supported recipient address family: Taproot, Bech32, P2SH, then Legacy. HD wallets derive internal change addresses; single-key wallets use the matching address of the imported key and exclude Taproot. Consolidation and RBF cancellation retain internal Taproot returns for HD wallets and Bech32 returns for single-key wallets.

## Build output

The build produces a standalone Node.js server, immutable static assets, a Rust/WASM module, and an artifact checksum manifest. Runtime responses apply restrictive security headers and disable application caching.
