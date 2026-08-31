import vinextHandler from 'vinext/server/fetch-handler';

import { createCspNonce, nonceInlineScripts } from './src/security/cspNonce';
import { applyWalletSecurityHeaders } from './src/security/httpHeaders';

type VinextFetchArguments = Parameters<typeof vinextHandler.fetch>;

const walletWorker = {
  async fetch(...arguments_: VinextFetchArguments): Promise<Response> {
    const response = await vinextHandler.fetch(...arguments_);
    const isHtml = response.headers
      .get('Content-Type')
      ?.toLowerCase()
      .includes('text/html');
    if (!isHtml) {
      const headers = applyWalletSecurityHeaders(new Headers(response.headers));
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const nonce = createCspNonce();
    const headers = applyWalletSecurityHeaders(
      new Headers(response.headers),
      nonce,
    );
    headers.delete('Content-Length');
    const html = nonceInlineScripts(await response.text(), nonce);

    return new Response(html, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  },
};

export default walletWorker;
