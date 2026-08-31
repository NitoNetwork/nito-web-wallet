import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const projectRoot = resolve('.');
const clientRoot = resolve('dist', 'client');

const filesBelow = (directory) => {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
};

const publicArtifactSnapshot = () => {
  const entries = filesBelow(clientRoot).map((path) => [
    relative(clientRoot, path).replaceAll('\\', '/'),
    createHash('sha256').update(readFileSync(path)).digest('hex'),
  ]);
  entries.push(['../server/BUILD_ID', readFileSync(resolve('dist', 'server', 'BUILD_ID'), 'utf8').trim()]);
  return new Map(entries);
};

const build = () => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is unavailable; run this verifier through npm.');
  execFileSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, NITO_REPRODUCIBILITY_CHECK: '1' },
  });
  return publicArtifactSnapshot();
};

const first = build();
const second = build();
const keys = new Set([...first.keys(), ...second.keys()]);
const differences = [...keys].filter((key) => first.get(key) !== second.get(key));
if (differences.length > 0) {
  throw new Error(`Public build is not reproducible: ${differences.slice(0, 20).join(', ')}`);
}

console.log(`Reproducible public build verified across ${second.size - 1} files (build ${second.get('../server/BUILD_ID')}).`);
