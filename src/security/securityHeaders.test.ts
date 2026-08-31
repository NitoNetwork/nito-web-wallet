import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyWalletSecurityHeaders,
  createWalletContentSecurityPolicy,
  WALLET_CONTENT_SECURITY_POLICY,
  WALLET_SECURITY_HEADERS,
} from './httpHeaders';

describe('wallet security headers', () => {
  it('keeps scripts and workers local and permits only the two audited WSS origins', async () => {
    const headers = await readFile(
      resolve(process.cwd(), 'public', '_headers'),
      'utf8',
    );
    expect(headers).toContain("default-src 'self'");
    expect(headers).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(headers).toContain("worker-src 'self'");
    expect(headers).toContain(
      "connect-src 'self' wss://electrum1.nito.network:50005 wss://electrum1.nitopool.fr:50005",
    );
    expect(headers).not.toContain("'unsafe-eval'");
    expect(headers).not.toContain('https://*');
    expect(headers).not.toContain('wss://*');
    expect(headers.match(/wss:\/\//gu)).toHaveLength(2);
  });

  it('blocks framing and MIME confusion and prevents stable-name WASM caching', async () => {
    const headers = await readFile(
      resolve(process.cwd(), 'public', '_headers'),
      'utf8',
    );
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(headers).toMatch(/\/wasm\/\*[\s\S]*Cache-Control: no-store/u);
  });

  it('applies the same policy to SSR responses in the custom Worker', () => {
    const headers = applyWalletSecurityHeaders(new Headers());
    expect(headers.get('Content-Security-Policy')).toBe(
      WALLET_CONTENT_SECURITY_POLICY,
    );
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect([...headers]).toHaveLength(WALLET_SECURITY_HEADERS.length);
  });

  it('authorizes only scripts carrying the unpredictable response nonce', () => {
    const nonce = 'requestSpecificNonce';
    const policy = createWalletContentSecurityPolicy(nonce);
    const headers = applyWalletSecurityHeaders(new Headers(), nonce);
    expect(policy).toContain(
      `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}'`,
    );
    expect(policy.match(/(?:^|;)\s*script-src[^;]*/u)?.[0]).not.toContain(
      "'unsafe-inline'",
    );
    expect(headers.get('Content-Security-Policy')).toBe(policy);
  });
});
