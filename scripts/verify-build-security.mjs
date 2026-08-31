import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const headersPath = resolve('dist', 'client', '_headers');
const headers = readFileSync(headersPath, 'utf8');
const workerPath = resolve('dist', 'server', 'index.js');
const worker = readFileSync(workerPath, 'utf8');

const requiredFragments = [
  "default-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self'",
  'wss://electrum1.nito.network:50005',
  'wss://electrum1.nitopool.fr:50005',
  'Cross-Origin-Embedder-Policy: require-corp',
  'Cross-Origin-Opener-Policy: same-origin',
  'Referrer-Policy: no-referrer',
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
  '/wasm/*',
];

const missing = requiredFragments.filter(
  (fragment) => !headers.includes(fragment),
);
if (missing.length > 0) {
  throw new Error(
    `Built security headers are incomplete: ${missing.join(', ')}`,
  );
}

const requiredWorkerFragments = [
  "default-src 'self'",
  "'wasm-unsafe-eval'",
  "'nonce-",
  '<script nonce="',
  'crypto.getRandomValues',
  "connect-src 'self'",
  'wss://electrum1.nito.network:50005',
  'wss://electrum1.nitopool.fr:50005',
  'Content-Security-Policy',
  'Cross-Origin-Embedder-Policy',
  'require-corp',
  'Cross-Origin-Opener-Policy',
  'same-origin',
  'Referrer-Policy',
  'no-referrer',
  'X-Content-Type-Options',
  'nosniff',
  'X-Frame-Options',
  'DENY',
];
const missingFromWorker = requiredWorkerFragments.filter(
  (fragment) => !worker.includes(fragment),
);
if (missingFromWorker.length > 0) {
  throw new Error(
    `SSR Worker security headers are incomplete: ${missingFromWorker.join(', ')}`,
  );
}

const distRoot = resolve('dist');
const standaloneRoot = resolve('dist', 'standalone');
const standaloneEntry = resolve(standaloneRoot, 'server.js');
const standaloneClientHeaders = resolve(
  standaloneRoot,
  'dist',
  'client',
  '_headers',
);
const standaloneWorker = resolve(standaloneRoot, 'dist', 'server', 'index.js');
const standaloneNodeModules = resolve(standaloneRoot, 'node_modules');

const projectRequire = createRequire(import.meta.url);
const copiedRuntimePackages = new Set();
const copyRuntimePackage = (packageName, resolver = projectRequire) => {
  if (copiedRuntimePackages.has(packageName)) return;
  const packageManifestPath = resolver.resolve(`${packageName}/package.json`);
  const packageRoot = dirname(packageManifestPath);
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'));
  const destination = resolve(standaloneNodeModules, ...packageName.split('/'));
  if (!existsSync(destination)) {
    cpSync(packageRoot, destination, { dereference: true, recursive: true });
  }
  copiedRuntimePackages.add(packageName);

  const packageRequire = createRequire(packageManifestPath);
  for (const dependency of Object.keys(packageManifest.dependencies ?? {})) {
    copyRuntimePackage(dependency, packageRequire);
  }
};

for (const runtimePeer of ['react', 'react-dom', 'react-server-dom-webpack']) {
  copyRuntimePackage(runtimePeer);
}

const nonRuntimeStandaloneFile = /(?:\.d\.[cm]?ts|\.(?:map|rs|ts|tsx))$/iu;
const pruneNonRuntimeStandaloneFiles = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pruneNonRuntimeStandaloneFiles(path);
    else if (entry.isFile() && nonRuntimeStandaloneFile.test(entry.name))
      rmSync(path);
    else if (entry.isFile() && /\.(?:cjs|css|js|mjs)$/iu.test(entry.name)) {
      const contents = readFileSync(path, 'utf8');
      const withoutSourceMapLinks = contents.replace(
        /^\s*\/\/[#@]\s*sourceMappingURL=.*$/gmu,
        '',
      );
      if (withoutSourceMapLinks !== contents)
        writeFileSync(path, withoutSourceMapLinks, 'utf8');
    }
  }
};
pruneNonRuntimeStandaloneFiles(standaloneNodeModules);

for (const requiredStandaloneFile of [
  standaloneEntry,
  standaloneClientHeaders,
  standaloneWorker,
]) {
  readFileSync(requiredStandaloneFile);
}

if (readFileSync(standaloneClientHeaders, 'utf8') !== headers) {
  throw new Error(
    'Standalone static headers differ from the verified client headers.',
  );
}
if (readFileSync(standaloneWorker, 'utf8') !== worker) {
  throw new Error(
    'Standalone SSR worker differs from the verified server worker.',
  );
}

const artifactFiles = [];
const visitArtifacts = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visitArtifacts(path);
    else if (entry.isFile() && entry.name !== 'ARTIFACTS.sha256')
      artifactFiles.push(path);
  }
};
visitArtifacts(distRoot);
artifactFiles.sort((left, right) => left.localeCompare(right));

const forbiddenArtifact =
  /(?:^|\/)(?:\.env[^/]*|[^/]+\.(?:map|pem|key|ts|tsx|rs))$/iu;
const forbidden = artifactFiles
  .map((path) => relative(distRoot, path).replaceAll('\\', '/'))
  .filter((path) => forbiddenArtifact.test(path));
if (forbidden.length > 0) {
  throw new Error(`Forbidden production artifacts: ${forbidden.join(', ')}`);
}

for (const path of artifactFiles.filter((candidate) => {
  const name = relative(distRoot, candidate).replaceAll('\\', '/');
  return (
    /\.(?:js|css|json)$/iu.test(candidate) &&
    !name.startsWith('standalone/node_modules/')
  );
})) {
  if (/sourceMappingURL|"sourcesContent"/u.test(readFileSync(path, 'utf8'))) {
    throw new Error(
      `Production source map reference found in ${relative(distRoot, path)}.`,
    );
  }
}

const wasmPath = resolve(
  'dist',
  'client',
  'wasm',
  'nito_wallet_crypto_web.wasm',
);
const wasmChecksum = createHash('sha256')
  .update(readFileSync(wasmPath))
  .digest('hex');
const checksumFile = readFileSync(`${wasmPath}.sha256`, 'utf8').trim();
const wasmBaseline = JSON.parse(
  readFileSync(
    resolve('native', 'nito-wallet-crypto-web', 'wasm-checksum.json'),
    'utf8',
  ),
);
if (
  checksumFile !== `${wasmChecksum}  nito_wallet_crypto_web.wasm` ||
  wasmBaseline.sha256 !== wasmChecksum
) {
  throw new Error(
    'Built WASM does not match its checksum and reviewed baseline.',
  );
}

const artifactManifest = artifactFiles
  .map((path) => {
    const checksum = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
    const name = relative(distRoot, path).replaceAll('\\', '/');
    return `${checksum}  ${name}`;
  })
  .join('\n');
writeFileSync(
  resolve(distRoot, 'ARTIFACTS.sha256'),
  `${artifactManifest}\n`,
  'utf8',
);

const standaloneFiles = artifactFiles.filter(
  (path) =>
    path.startsWith(`${standaloneRoot}\\`) ||
    path.startsWith(`${standaloneRoot}/`),
);
const standaloneManifest = standaloneFiles
  .map((path) => {
    const checksum = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex');
    const name = relative(standaloneRoot, path).replaceAll('\\', '/');
    return `${checksum}  ${name}`;
  })
  .join('\n');
writeFileSync(
  resolve(standaloneRoot, 'ARTIFACTS.sha256'),
  `${standaloneManifest}\n`,
  'utf8',
);

console.log(
  `Static/SSR headers, standalone bundle, source-map exclusion and ${artifactFiles.length} artifact checksums verified.`,
);
