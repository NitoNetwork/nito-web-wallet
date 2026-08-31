import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const nginx = readFileSync(
  resolve('deploy', 'nginx', 'nito-wallet.conf'),
  'utf8',
);
const nginxBootstrap = readFileSync(
  resolve('deploy', 'nginx', 'nito-wallet.bootstrap.conf'),
  'utf8',
);
const systemd = readFileSync(
  resolve('deploy', 'systemd', 'nito-wallet.service'),
  'utf8',
);
const packageManifest = JSON.parse(
  readFileSync(resolve('package.json'), 'utf8'),
);
const nextConfig = readFileSync(resolve('next.config.ts'), 'utf8');

const requireFragments = (label, contents, fragments) => {
  const missing = fragments.filter((fragment) => !contents.includes(fragment));
  if (missing.length > 0)
    throw new Error(`${label} is incomplete: ${missing.join(', ')}`);
};

requireFragments('Nginx vhost', nginx, [
  'server_name wallet.example.com;',
  'proxy_pass http://127.0.0.1:8787;',
  'Content-Security-Policy',
  'map $upstream_http_content_security_policy $nito_wallet_csp',
  'default $upstream_http_content_security_policy',
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' wss://electrum1.nito.network:50005 wss://electrum1.nitopool.fr:50005",
  'add_header Content-Security-Policy $nito_wallet_csp always',
  'Cross-Origin-Embedder-Policy "require-corp"',
  'Cross-Origin-Opener-Policy "same-origin"',
  'Cache-Control "no-store"',
  'X-Frame-Options "DENY"',
  'if ($request_method !~ ^(GET|HEAD)$)',
]);

if (nginx.includes("connect-src 'none'")) {
  throw new Error(
    'Nginx must not block the crypto Worker from loading its local WASM.',
  );
}

requireFragments('Nginx ACME bootstrap vhost', nginxBootstrap, [
  'listen 80;',
  'server_name wallet.example.com;',
  'location ^~ /.well-known/acme-challenge/',
  'root /var/lib/letsencrypt;',
  'return 503;',
]);

for (const forbidden of ["script-src 'self' 'unsafe-eval'", 'includeSubDomains']) {
  if (nginx.includes(forbidden)) {
    throw new Error(
      `Nginx vhost contains a forbidden fragment: ${forbidden}`,
    );
  }
}

requireFragments('Systemd unit', systemd, [
  'User=nito-wallet',
  'Group=nito-wallet',
  'Environment=HOST=127.0.0.1',
  'Environment=PORT=8787',
  'NoNewPrivileges=true',
  'PrivateTmp=true',
  'ProtectSystem=strict',
  'ProtectHome=true',
  'CapabilityBoundingSet=',
  'Restart=on-failure',
  'WantedBy=multi-user.target',
]);

if (packageManifest.scripts?.start !== 'node scripts/start-production.mjs') {
  throw new Error(
    'The production start command does not use the standalone server.',
  );
}
if (!nextConfig.includes("output: 'standalone'")) {
  throw new Error('Vinext standalone output is not enabled.');
}

console.log(
  'Standalone runtime, Nginx vhost and Systemd hardening verified.',
);
