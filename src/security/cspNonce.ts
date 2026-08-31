const CSP_NONCE_BYTES = 18;

export function createCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CSP_NONCE_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function nonceInlineScripts(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\bnonce=)/gu, `<script nonce="${nonce}"`);
}
