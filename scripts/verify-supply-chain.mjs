import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageManifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

if (lock.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfile v3.');
const root = lock.packages?.[''];
if (!root) throw new Error('package-lock.json has no root package record.');

for (const group of ['dependencies', 'devDependencies']) {
  const declared = packageManifest[group] ?? {};
  const locked = root[group] ?? {};
  for (const [name, version] of Object.entries(declared)) {
    if (typeof version !== 'string' || !exactVersion.test(version)) {
      throw new Error(`${group}.${name} is not pinned to one exact version.`);
    }
    if (locked[name] !== version) {
      throw new Error(`${group}.${name} differs between package.json and package-lock.json.`);
    }
  }
}

const allowedLifecycleScripts = new Map([
  ['node_modules/esbuild', '0.28.1'],
  ['node_modules/fsevents', '2.3.3'],
  ['node_modules/workerd', '1.20260828.1'],
]);
let packageCount = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  packageCount += 1;
  if (!exactVersion.test(entry.version ?? '')) {
    throw new Error(`${path} has a non-exact locked version.`);
  }
  if (
    typeof entry.resolved !== 'string' ||
    !entry.resolved.startsWith('https://registry.npmjs.org/')
  ) {
    throw new Error(`${path} is not resolved from the allowed npm registry.`);
  }
  if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
    throw new Error(`${path} has no SHA-512 package integrity.`);
  }
  if (entry.hasInstallScript && allowedLifecycleScripts.get(path) !== entry.version) {
    throw new Error(`${path}@${entry.version} has an unreviewed lifecycle script.`);
  }
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable; run this verifier through npm.');
const sbomRaw = execFileSync(
  process.execPath,
  [npmCli, 'sbom', '--sbom-format=cyclonedx'],
  { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
const sbom = JSON.parse(sbomRaw);
if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
  throw new Error('npm did not produce the expected CycloneDX 1.5 SBOM.');
}
for (const [name, version] of Object.entries(packageManifest.dependencies ?? {})) {
  if (!sbom.components?.some((component) => component.name === name && component.version === version)) {
    throw new Error(`Production SBOM is missing ${name}@${version}.`);
  }
}

console.log(
  `Supply chain verified: ${packageCount} locked packages, ${sbom.components.length} SBOM components, ${allowedLifecycleScripts.size} reviewed lifecycle scripts.`,
);
