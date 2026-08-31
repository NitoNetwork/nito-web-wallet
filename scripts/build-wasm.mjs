import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateRoot = join(projectRoot, 'native', 'nito-wallet-crypto-web');
const manifestPath = join(crateRoot, 'Cargo.toml');
const wasmSource = join(
  crateRoot,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'nito_wallet_crypto_web.wasm',
);
const wasmOutputDirectory = join(projectRoot, 'public', 'wasm');
const wasmOutput = join(wasmOutputDirectory, 'nito_wallet_crypto_web.wasm');
const checksumOutput = `${wasmOutput}.sha256`;
const wasmChecksumPath = join(
  crateRoot,
  'wasm-checksum.json',
);

function executableWorks(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function findClangOnWindows() {
  const explicit = process.env.CC_wasm32_unknown_unknown;
  if (executableWorks(explicit)) return explicit;

  const pathProbe = spawnSync('where.exe', ['clang.exe'], { encoding: 'utf8' });
  if (pathProbe.status === 0) {
    const candidate = pathProbe.stdout.split(/\r?\n/u).find(Boolean);
    if (executableWorks(candidate)) return candidate;
  }

  const fixedCandidates = [
    join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Microsoft Visual Studio',
      '2022',
      'BuildTools',
      'VC',
      'Tools',
      'Llvm',
      'x64',
      'bin',
      'clang.exe',
    ),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LLVM', 'bin', 'clang.exe'),
  ];
  for (const candidate of fixedCandidates) {
    if (executableWorks(candidate)) return candidate;
  }

  const ndkRoot = join(
    process.env.LOCALAPPDATA ?? '',
    'Android',
    'Sdk',
    'ndk',
  );
  if (existsSync(ndkRoot)) {
    const versions = readdirSync(ndkRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = join(
        ndkRoot,
        version,
        'toolchains',
        'llvm',
        'prebuilt',
        'windows-x86_64',
        'bin',
        'clang.exe',
      );
      if (executableWorks(candidate)) return candidate;
    }
  }

  return undefined;
}

const buildEnvironment = { ...process.env };
if (process.platform === 'win32') {
  const clang = findClangOnWindows();
  if (!clang) {
    throw new Error(
      'clang is required to build libsecp256k1 for wasm32. Install LLVM or set CC_wasm32_unknown_unknown.',
    );
  }
  buildEnvironment.CC_wasm32_unknown_unknown = clang;
}

execFileSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    manifestPath,
    '--target',
    'wasm32-unknown-unknown',
    '--release',
    '--locked',
  ],
  { cwd: projectRoot, env: buildEnvironment, stdio: 'inherit' },
);

mkdirSync(wasmOutputDirectory, { recursive: true });
copyFileSync(wasmSource, wasmOutput);
const checksum = createHash('sha256').update(readFileSync(wasmOutput)).digest('hex');
const reviewedChecksum = JSON.parse(readFileSync(wasmChecksumPath, 'utf8'));
if (reviewedChecksum.schemaVersion !== 1 || reviewedChecksum.sha256 !== checksum) {
  throw new Error(
    `WASM output drifted from the reviewed checksum (${checksum}). Review the native diff and update native/nito-wallet-crypto-web/wasm-checksum.json explicitly.`,
  );
}
writeFileSync(checksumOutput, `${checksum}  nito_wallet_crypto_web.wasm\n`, 'utf8');
console.log(`WASM crypto core: ${checksum}`);
