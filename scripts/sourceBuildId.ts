import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.vinext',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'outputs',
  'target',
  'work',
]);

const normalizedRelativePath = (root: string, path: string) =>
  relative(root, path).replaceAll('\\', '/');

const sourceFiles = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = normalizedRelativePath(root, path);
      if (entry.isSymbolicLink()) {
        throw new Error(`A source-tree symlink is not allowed in the build input: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (
          IGNORED_DIRECTORY_NAMES.has(entry.name) ||
          relativePath === 'public/wasm'
        ) {
          continue;
        }
        visit(path);
        continue;
      }
      if (entry.isFile() && !entry.name.endsWith('.tsbuildinfo')) files.push(path);
    }
  };
  visit(root);
  return files.sort((left, right) =>
    normalizedRelativePath(root, left).localeCompare(normalizedRelativePath(root, right)),
  );
};

export const computeSourceBuildId = (root = process.cwd()): string => {
  const hash = createHash('sha256');
  for (const path of sourceFiles(root)) {
    hash.update(normalizedRelativePath(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `nito-${hash.digest('hex').slice(0, 32)}`;
};
