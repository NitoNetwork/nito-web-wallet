import { NITO_ELECTRUM_WSS_ORIGINS } from '../network/electrumServers';

export function createWalletContentSecurityPolicy(
  scriptNonce?: string,
): string {
  const scriptSources = ["'self'", "'wasm-unsafe-eval'"];
  if (scriptNonce) scriptSources.push(`'nonce-${scriptNonce}'`);

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${NITO_ELECTRUM_WSS_ORIGINS.join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "media-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export const WALLET_CONTENT_SECURITY_POLICY =
  createWalletContentSecurityPolicy();

export const WALLET_SECURITY_HEADERS = [
  ['Cache-Control', 'no-store'],
  ['Content-Security-Policy', WALLET_CONTENT_SECURITY_POLICY],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Origin-Agent-Cluster', '?1'],
  [
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  ],
  ['Referrer-Policy', 'no-referrer'],
  ['Strict-Transport-Security', 'max-age=31536000'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-DNS-Prefetch-Control', 'off'],
  ['X-Frame-Options', 'DENY'],
  ['X-Permitted-Cross-Domain-Policies', 'none'],
] as const;

export function applyWalletSecurityHeaders(
  headers: Headers,
  scriptNonce?: string,
): Headers {
  for (const [name, value] of WALLET_SECURITY_HEADERS) {
    headers.set(name, value);
  }
  if (scriptNonce) {
    headers.set(
      'Content-Security-Policy',
      createWalletContentSecurityPolicy(scriptNonce),
    );
  }
  return headers;
}
