# Changelog

## 1.4.3 — 2026-11-14

- Ensure the approved panoramic background remains visible through the dashboard balance card by overriding its opaque component-level surface and blur.

## 1.4.2 — 2026-11-14

- Reveal the official portrait and panoramic wallet backgrounds through the interface while preserving each source image byte-for-byte and without stretching.
- Remove the synthetic CSS horizon that obscured the approved cloud, sunlight, and blue-gold line artwork.

## 1.4.1 — 2026-11-14

- Keep the desktop refresh and exit actions inside the navigation panel instead of placing them below its border.

## 1.4.0 — 2026-11-14

- Use the official mobile wallet portrait background directly on phones and a faithful panoramic companion on larger screens without distorting either artwork.
- Restore the rotating official Nito logo during wallet synchronization while respecting reduced-motion preferences.
- Show the synchronized block height in the session panel and keep desktop refresh and exit actions at the bottom of the navigation rail.
- Always show the spendable balance, reveal pending funds only when present, and report the closest immature mining reward as confirmations out of 101 with its remaining blocks.

## 1.3.2 — 2026-11-13

- Replace the CSS-only access-screen logo watermark with a native Aurora glow to prevent Vinext from rewriting the asset to an unavailable static path.
- Keep the official Nito logo in the rendered header and balance hero while eliminating the final hidden production 404.

## 1.3.1 — 2026-11-13

- Remove invalid Vinext image preloads while preserving the official Nito logo on access and synchronization screens.
- Eliminate the resulting hidden production 404 without changing wallet behavior or visual rendering.

## 1.3.0 — 2026-11-13

- Introduce the Aurora Core interface with the official Nito artwork, a luminous network horizon, and a desktop navigation rail.
- Rework the balance overview around spendable, pending, immature, and synchronization states without changing wallet behavior.
- Preserve compact mobile navigation, long-balance fitting, keyboard focus, forced-color fallbacks, and reduced-motion preferences.
- Refresh shared cards, actions, access screens, and synchronization feedback with a consistent responsive visual system.

## 1.2.3 — 2026-11-13

- Upgrade React, React DOM, and React Server Components to 19.2.9 to address the critical unauthenticated RSC vulnerability GHSA-xqc2-xf4c-x3h3.
- Keep the three React runtime packages aligned on the patched 19.2 release series.

## 1.2.2 — 2026-11-07

- Localize browser constraint messages in every wallet form according to the selected interface language.
- Prevent previously displayed transient messages from remaining in the former language after a language change.
- Complete the RBF terminology and accessibility translation audit across all nine interface languages.

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
