import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const files = {
  badge: path.join(repositoryRoot, 'assets', 'version-badge.svg'),
  cargoLock: path.join(
    repositoryRoot,
    'native',
    'nito-wallet-crypto-web',
    'Cargo.lock',
  ),
  cargoManifest: path.join(
    repositoryRoot,
    'native',
    'nito-wallet-crypto-web',
    'Cargo.toml',
  ),
  packageLock: path.join(repositoryRoot, 'package-lock.json'),
  packageManifest: path.join(repositoryRoot, 'package.json'),
};
const strictSemanticVersion = /^\d+\.\d+\.\d+$/;

const readText = (file) => readFile(file, 'utf8');
const writeText = (file, value) => writeFile(file, value, 'utf8');

function assertSemanticVersion(version) {
  if (!strictSemanticVersion.test(version)) {
    throw new Error(
      `Invalid version "${version}". Expected major.minor.patch without a prefix.`,
    );
  }
}

function cargoVersion(source, filename) {
  const match = source.match(
    /\[package\]\s+name = "nito-wallet-crypto-web"\s+version = "([^"]+)"/,
  );
  if (!match?.[1]) throw new Error(`Cannot read the version from ${filename}.`);
  return match[1];
}

function cargoLockVersion(source) {
  const match = source.match(
    /\[\[package\]\]\s+name = "nito-wallet-crypto-web"\s+version = "([^"]+)"/,
  );
  if (!match?.[1]) throw new Error('Cannot read the version from Cargo.lock.');
  return match[1];
}

function createBadge(version) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20" role="img" aria-label="version: ${version}">
  <title>version: ${version}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="100" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="57" height="20" fill="#555"/>
    <rect x="57" width="43" height="20" fill="#1674d1"/>
    <rect width="100" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="28.5" y="15" fill="#010101" fill-opacity=".3">version</text>
    <text x="28.5" y="14">version</text>
    <text x="78.5" y="15" fill="#010101" fill-opacity=".3">${version}</text>
    <text x="78.5" y="14">${version}</text>
  </g>
</svg>
`;
}

async function verifyVersions() {
  const [packageSource, lockSource, cargoSource, cargoLockSource, badgeSource] =
    await Promise.all([
      readText(files.packageManifest),
      readText(files.packageLock),
      readText(files.cargoManifest),
      readText(files.cargoLock),
      readText(files.badge),
    ]);
  const packageManifest = JSON.parse(packageSource);
  const packageLock = JSON.parse(lockSource);
  const expected = packageManifest.version;
  assertSemanticVersion(expected);
  const versions = {
    'Cargo.lock': cargoLockVersion(cargoLockSource),
    'Cargo.toml': cargoVersion(cargoSource, 'Cargo.toml'),
    'package-lock.json': packageLock.version,
    'package-lock.json root package': packageLock.packages?.['']?.version,
  };
  for (const [source, version] of Object.entries(versions)) {
    if (version !== expected) {
      throw new Error(`${source} is ${version ?? 'missing'}; expected ${expected}.`);
    }
  }
  if (
    !badgeSource.includes(`aria-label="version: ${expected}"`) ||
    !badgeSource.includes(`>${expected}</text>`)
  ) {
    throw new Error(`The README badge does not display version ${expected}.`);
  }
  console.log(`Version ${expected} is synchronized across all public sources.`);
}

async function setVersion(version) {
  assertSemanticVersion(version);
  const [packageSource, lockSource, cargoSource, cargoLockSource] =
    await Promise.all([
      readText(files.packageManifest),
      readText(files.packageLock),
      readText(files.cargoManifest),
      readText(files.cargoLock),
    ]);
  const packageManifest = JSON.parse(packageSource);
  const packageLock = JSON.parse(lockSource);
  packageManifest.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.['']) {
    throw new Error('The root package is missing from package-lock.json.');
  }
  packageLock.packages[''].version = version;
  const nextCargo = cargoSource.replace(
    /(\[package\]\s+name = "nito-wallet-crypto-web"\s+version = ")[^"]+(")/,
    `$1${version}$2`,
  );
  const nextCargoLock = cargoLockSource.replace(
    /(\[\[package\]\]\s+name = "nito-wallet-crypto-web"\s+version = ")[^"]+(")/,
    `$1${version}$2`,
  );
  await Promise.all([
    writeText(files.packageManifest, `${JSON.stringify(packageManifest, null, 2)}\n`),
    writeText(files.packageLock, `${JSON.stringify(packageLock, null, 2)}\n`),
    writeText(files.cargoManifest, nextCargo),
    writeText(files.cargoLock, nextCargoLock),
    writeText(files.badge, createBadge(version)),
  ]);
  await verifyVersions();
}

const [command = 'verify', version] = process.argv.slice(2);
if (command === 'verify') {
  await verifyVersions();
} else if (command === 'set' && version) {
  await setVersion(version);
} else {
  throw new Error('Usage: node scripts/version.mjs verify | set <major.minor.patch>');
}
