# NITO Web Wallet

[![Version](assets/version-badge.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

NITO Web Wallet is a self-custodial browser wallet for transparent NITO transactions. Wallet secrets are handled locally and are never sent to an application server.

## Features

- Import or create 12-word and 24-word BIP39 HD wallets.
- Add physical dice results to browser-generated entropy.
- Open a deterministic wallet from an email address and password.
- Import WIF and 32-byte hexadecimal private keys.
- Receive with Legacy, P2SH, Bech32, or Taproot HD addresses; Taproot is the default.
- Aggregate supported transparent UTXOs into one spendable balance.
- Send to multiple recipients, consolidate UTXOs, and attempt RBF cancellation.
- Track unconfirmed, confirmed, and immature coinbase balances.
- Browse unspent outputs in My UTXOs, five per page, with owning addresses, address types, live confirmations and local dates.
- Use nine interface languages without restarting or rescanning the wallet.

## UTXO details

The My UTXOs tab uses the synchronized wallet snapshot, including pending outputs and
immature mining rewards. Confirmations follow the existing block subscription.
Confirmed dates are block timestamps, not exact payment arrival times; pending
dates indicate when this browser session first observed the transaction. Missing
dates are shown as unavailable. Block headers are fetched with bounded concurrency
and cached only in memory, shared across outputs from the same block. Changing
pages or interface language does not request another wallet scan.

## Automatic change

Payments select their change address family using Bitcoin Core's automatic
recipient-matching policy: Taproot, Bech32, P2SH, then Legacy, restricted to the
families this wallet can sign. Mixed-recipient payments use the first matching
family in that order. HD change uses a fresh internal address in the selected
account; WIF/HEX uses the matching address of the imported key, without Taproot.
The choice is included in fee estimation and the unsigned preview and remains
unchanged when signing. It is not based on the type of the spent inputs.

Consolidation and RBF cancellation have no external recipients to match: these
self-transfers retain an internal Taproot return for HD wallets and Bech32 for
WIF/HEX. Receiving addresses are unchanged.

## Security model

Cryptographic operations run in a dedicated Web Worker backed by Rust/WASM. Unlocked secrets are kept in encrypted in-memory vaults and the Worker is terminated when the session locks. Wallet credentials, recovery phrases, private keys, balances, transactions, and address counters are not persisted by the application.

Browser extensions, same-origin script injection, and compromised browsers or operating systems remain outside this trust boundary. Use a trusted device, keep recovery phrases offline, and review [the security model](docs/SECURITY.md) before using real funds.

## Requirements

- Node.js 22.13 or newer
- Rust with the `wasm32-unknown-unknown` target
- Clang when building the WASM target on Windows

## Development

```bash
npm install
npm run dev
```

The complete local validation suite is:

```bash
npm run check
```

Individual checks are available through `npm run typecheck`, `npm run lint`, `npm test`, `npm run crypto:check`, and `npm run build`.

The WASM output is verified against `native/nito-wallet-crypto-web/wasm-checksum.json`. Update that checksum only after reviewing the native source diff and the rebuilt binary.

## Versioning

The public version follows [Semantic Versioning](https://semver.org/) and is defined in `package.json`. Update every version source and the README badge with:

```bash
npm run version:set -- <major.minor.patch>
```

`npm run check` rejects inconsistent application, lockfile, Rust module, or badge versions. Git tags and GitHub releases are created only for published releases.

## Deployment

`npm run build` produces a self-contained Node.js release in `dist/standalone`. Generic Nginx and systemd templates are documented in [deploy/README.md](deploy/README.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Security model](docs/SECURITY.md)
- [Security policy](SECURITY.md)
