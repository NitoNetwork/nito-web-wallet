# Maintenance

## Versioning

The project follows Semantic Versioning. The application version is defined in `package.json`.

To update the application, lockfiles, Rust module, and README badge together, replace `<major.minor.patch>` with the intended version:

```bash
npm run version:set -- <major.minor.patch>
```

Document user-facing changes in [CHANGELOG.md](../CHANGELOG.md) and run `npm run check`. The version check rejects inconsistent version sources.

Keep Git tags tied to the exact published source revision. Documentation-only changes do not require an application version bump or a site redeployment; do not move an existing release tag.

## Rust/WASM integrity

Builds verify the compiled WASM output against `native/nito-wallet-crypto-web/wasm-checksum.json`. A mismatch stops the build.

Review the native source, dependency, and toolchain changes before updating the expected checksum. Package version changes can also affect the binary. Do not bypass this check or automatically accept an unexpected hash.

After an intentional checksum update, run `npm run check` and `npm run build:reproducible`. See the [self-hosting guide](../deploy/README.md) for release artifact verification.
