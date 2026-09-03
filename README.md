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
- Use nine interface languages without restarting or rescanning the wallet.

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
- [Security model](docs/SECURITY.md)
- [Security policy](SECURITY.md)
