# Security Policy

Do not disclose a suspected vulnerability in a public issue.

Use GitHub private vulnerability reporting for the repository when it is available. Include the affected commit, reproduction steps, expected impact, and any relevant browser, operating system, Node.js, or Rust versions. Never include a real recovery phrase, private key, password, or transaction-signing secret in a report.

Only the latest published revision is supported with security fixes.

## Optional BIP39 passphrase

A BIP39 passphrase is a separate secret from the recovery phrase and from any
wallet password. It is not an extra recovery word. Every passphrase opens a
valid wallet, so the application cannot detect a typo or recover a forgotten
value. Back it up exactly and separately.

The Web Wallet normalizes the passphrase according to BIP39 (Unicode NFKD),
then keeps it only inside the active Worker's encrypted, ephemeral session
vault together with the recovery phrase. It is never persisted in browser
storage, URLs, logs, telemetry, or error reports, and it is destroyed when the
secure session ends. Existing wallets use the standard empty BIP39 passphrase.
