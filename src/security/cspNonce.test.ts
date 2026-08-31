import { describe, expect, it } from 'vitest';

import { createCspNonce, nonceInlineScripts } from './cspNonce';

describe('CSP nonces', () => {
  it('creates independent browser-safe nonces', () => {
    const nonces = new Set(Array.from({ length: 32 }, createCspNonce));

    expect(nonces.size).toBe(32);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/u);
    }
  });

  it('adds the request nonce to every script without duplicating one', () => {
    expect(
      nonceInlineScripts(
        '<script>first()</script><script src="/app.js"></script><script nonce="kept">last()</script>',
        'requestNonce',
      ),
    ).toBe(
      '<script nonce="requestNonce">first()</script><script nonce="requestNonce" src="/app.js"></script><script nonce="kept">last()</script>',
    );
  });
});
