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

Accepted broadcasts are projected into the in-memory snapshot immediately and reconciled with Electrum. RBF cancellation tracks both competing transactions: the dialog confirms the replacement when it wins, or reports failure and links to the original transaction when the original confirms first.

HD change, consolidation, and RBF return outputs use internal Taproot addresses. Single-key wallets use Bech32 return outputs because Taproot is intentionally unavailable for that source.

## Build output

The build produces a standalone Node.js server, immutable static assets, a Rust/WASM module, and an artifact checksum manifest. Runtime responses apply restrictive security headers and disable application caching.
