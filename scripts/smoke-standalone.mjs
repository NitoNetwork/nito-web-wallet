import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const temporaryRoot = realpathSync(tmpdir());
const smokeRoot = mkdtempSync(
  join(temporaryRoot, 'nito-wallet-standalone-smoke-'),
);
const relativeSmokeRoot = relative(temporaryRoot, smokeRoot);
if (relativeSmokeRoot.startsWith('..') || relativeSmokeRoot === '') {
  throw new Error(
    'The isolated smoke directory escaped the operating-system temp directory.',
  );
}

const reservePort = async () =>
  new Promise((resolvePort, reject) => {
    const reservation = createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address();
      if (!address || typeof address === 'string') {
        reservation.close();
        reject(new Error('Unable to reserve an isolated local port.'));
        return;
      }
      reservation.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });

const port = await reservePort();
const source = resolve('dist', 'standalone');
cpSync(source, smokeRoot, { dereference: true, recursive: true });

let output = '';
const server = spawn(process.execPath, ['server.js'], {
  cwd: smokeRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => {
  output = `${output}${chunk}`.slice(-8_000);
});
server.stderr.on('data', (chunk) => {
  output = `${output}${chunk}`.slice(-8_000);
});

const origin = `http://127.0.0.1:${port}`;
const waitForReady = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Isolated standalone server exited early.\n${output}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.status === 200 && (await response.text()) === 'ok\n') return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `Isolated standalone server did not become ready.\n${output}`,
  );
};

try {
  await waitForReady();
  const rootResponse = await fetch(`${origin}/`);
  if (rootResponse.status !== 200)
    throw new Error(`Root returned ${rootResponse.status}.`);
  for (const [name, value] of [
    ['cache-control', 'no-store'],
    ['cross-origin-embedder-policy', 'require-corp'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
  ]) {
    if (rootResponse.headers.get(name) !== value) {
      throw new Error(
        `Isolated standalone response has an invalid ${name} header.`,
      );
    }
  }
  const contentSecurityPolicy =
    rootResponse.headers.get('content-security-policy') ?? '';
  const scriptDirective = contentSecurityPolicy.match(
    /(?:^|;)\s*script-src[^;]*/u,
  )?.[0];
  const nonceMatch = scriptDirective?.match(
    /(?:^|;)\s*script-src[^;]*'nonce-([^']+)'/u,
  );
  if (!nonceMatch || scriptDirective?.includes("'unsafe-inline'")) {
    throw new Error(
      'The standalone HTML response does not carry a strict nonce CSP.',
    );
  }
  const responseNonce = nonceMatch[1];
  const rootHtml = await rootResponse.text();
  const scriptTags = rootHtml.match(/<script\b[^>]*>/gu) ?? [];
  if (scriptTags.length === 0)
    throw new Error('The standalone HTML has no scripts to verify.');
  if (scriptTags.some((tag) => !tag.includes(`nonce="${responseNonce}"`))) {
    throw new Error(
      'At least one standalone HTML script is missing the response nonce.',
    );
  }
  if (/<link\b[^>]*\bas=["']font["']/u.test(rootHtml)) {
    throw new Error(
      'The standalone HTML still preloads fonts that may remain unused.',
    );
  }
  if (
    !/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*favicon\.svg/u.test(
      rootHtml,
    )
  ) {
    throw new Error('The standalone HTML does not declare the SVG favicon.');
  }

  const secondRootResponse = await fetch(`${origin}/`);
  const secondPolicy =
    secondRootResponse.headers.get('content-security-policy') ?? '';
  if (secondPolicy.includes(`'nonce-${responseNonce}'`)) {
    throw new Error('Two HTML responses reused the same CSP nonce.');
  }

  const wasmResponse = await fetch(
    `${origin}/wasm/nito_wallet_crypto_web.wasm`,
  );
  if (wasmResponse.status !== 200)
    throw new Error(`WASM returned ${wasmResponse.status}.`);
  const servedWasmChecksum = createHash('sha256')
    .update(Buffer.from(await wasmResponse.arrayBuffer()))
    .digest('hex');
  const wasmBaseline = JSON.parse(
    readFileSync(
      resolve('native', 'nito-wallet-crypto-web', 'wasm-checksum.json'),
      'utf8',
    ),
  );
  if (servedWasmChecksum !== wasmBaseline.sha256) {
    throw new Error(
      'The isolated standalone server returned an unexpected WASM binary.',
    );
  }

  const workerDirectory = resolve(
    source,
    'dist',
    'client',
    '_next',
    'static',
    'workers',
  );
  const workerFiles = readdirSync(workerDirectory).filter((file) =>
    /^crypto\.worker-[A-Za-z0-9_-]+\.js$/u.test(file),
  );
  if (workerFiles.length !== 1) {
    throw new Error(
      `Expected one built cryptographic Worker, found ${workerFiles.length}.`,
    );
  }
  const workerResponse = await fetch(
    `${origin}/_next/static/workers/${workerFiles[0]}`,
  );
  if (workerResponse.status !== 200) {
    throw new Error(`Cryptographic Worker returned ${workerResponse.status}.`);
  }
  const workerPolicy =
    workerResponse.headers.get('content-security-policy') ?? '';
  const workerConnectDirective = workerPolicy.match(
    /(?:^|;)\s*connect-src[^;]*/u,
  )?.[0];
  // The standalone static server may leave asset CSP enforcement to its
  // reverse proxy. If it does emit a Worker CSP, it must allow same-origin
  // loading of the audited WASM module.
  if (
    workerPolicy &&
    (!workerConnectDirective?.includes("'self'") ||
      workerConnectDirective.includes("'none'"))
  ) {
    throw new Error(
      'The cryptographic Worker CSP prevents loading its same-origin WASM module.',
    );
  }
  const workerBody = await workerResponse.text();
  if (!workerBody.includes('/wasm/nito_wallet_crypto_web.wasm')) {
    throw new Error(
      'The built cryptographic Worker no longer references the audited WASM module.',
    );
  }

  const rejectedPost = await fetch(`${origin}/`, { method: 'POST' });
  if (rejectedPost.status !== 405) {
    throw new Error(
      `The isolated standalone server accepted POST with ${rejectedPost.status}.`,
    );
  }

  console.log(`Isolated standalone runtime verified on 127.0.0.1:${port}.`);
} finally {
  server.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (server.exitCode !== null) resolveExit();
    else server.once('exit', resolveExit);
  });
  rmSync(smokeRoot, { force: true, recursive: true });
}
