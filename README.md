# NITO Web Wallet

[![Version](assets/version-badge.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

NITO Web Wallet is a self-custodial browser wallet for transparent NITO transactions. Wallet secrets are handled locally and are never sent to an application server.

[Open the wallet](https://wallet.nito.network/) · [Self-hosting guide](deploy/README.md)

## Features

- Create or restore 12-word and 24-word BIP39 HD wallets, with optional physical dice input during creation.
- Open a deterministic wallet from an email address and password, or import a WIF or hexadecimal private key.
- Receive with Legacy, P2SH, Bech32, or Taproot HD addresses; Taproot is the default.
- Send to multiple recipients, consolidate UTXOs, and attempt RBF cancellation.
- Track spendable, pending, and immature mining balances across supported addresses.
- Browse UTXOs with owning addresses, address types, confirmations, and local dates.
- Use nine interface languages without restarting or rescanning the wallet.

## Installation

### Prerequisites

- Git.
- Node.js 22.13 or newer, with npm.
- Rust and Cargo installed through rustup, with native build tools for your platform.
- Clang/LLVM for WebAssembly compilation on Windows.

### Quick start

```bash
git clone https://github.com/NitoNetwork/nito-web-wallet.git
cd nito-web-wallet
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser. The `dev` command builds the application and starts the local server; it does not provide hot reload. Stop the server and rerun the command after source changes.

## Build & Deployment

```bash
npm run build
npm start
```

The build produces a self-contained Node.js release in `dist/standalone`. The server defaults to `127.0.0.1:3000`; `HOST` and `PORT` can override the listener.

For public hosting, use HTTPS and keep the application behind a reverse proxy. Follow the [self-hosting guide](deploy/README.md) for the Nginx and systemd templates, required security headers, and artifact verification.

## Testing

Run the complete local validation suite:

```bash
npm run check
```

This checks version consistency, Rust/WASM, TypeScript, lint, tests, the production build, and deployment integrity. Run `npm run audit:production` separately to check production dependencies for known vulnerabilities.

## Security

Wallet credentials, recovery phrases, private keys, and wallet data are not persisted by the application. Only the inactivity and background lock preferences are saved in the browser.

Use a trusted device and keep recovery phrases offline. Browser extensions, injected scripts, or a compromised device can expose wallet secrets. Read the [security model](docs/SECURITY.md) before using real funds, and follow the [security policy](SECURITY.md) to report vulnerabilities privately.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Self-hosting](deploy/README.md)
- [Maintenance and versioning](docs/MAINTAINING.md)
- [Changelog](CHANGELOG.md)

## License

Released under the [MIT License](LICENSE).
