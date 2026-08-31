# Self-Hosted Deployment

`npm run build` creates an immutable standalone release in `dist/standalone`. The directory contains the Node.js server, public assets, runtime dependencies, and `ARTIFACTS.sha256`.

The templates in this directory use the following example layout:

- public hostname: `wallet.example.com`;
- private listener: `127.0.0.1:8787`;
- service account: `nito-wallet`;
- releases: `/opt/nito-wallet/releases/<revision>`;
- active symlink: `/opt/nito-wallet/current`.

Replace the example hostname before installation.

## Build and install

```bash
npm ci
npm run check
sudo install -d -o nito-wallet -g nito-wallet /opt/nito-wallet/releases/<revision>
sudo cp -a dist/standalone/. /opt/nito-wallet/releases/<revision>/
sudo ln -sfn /opt/nito-wallet/releases/<revision> /opt/nito-wallet/current
```

Verify `ARTIFACTS.sha256` before activating a release.

## TLS bootstrap

Install `nginx/nito-wallet.bootstrap.conf` only while obtaining the first ACME certificate. After the certificate exists, replace it with `nginx/nito-wallet.conf`, test the configuration, and reload Nginx.

## Service

Install `systemd/nito-wallet.service`, create the unprivileged `nito-wallet` account, then enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nito-wallet.service
```

The final Nginx template restricts methods, response caching, framing, browser capabilities, and network destinations. Keep the application bound to the loopback interface.
