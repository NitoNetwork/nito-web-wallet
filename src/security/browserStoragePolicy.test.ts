import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const productionRoots = ['app', 'components', 'lib', 'src'];

function productionSourceFiles(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const absolute = resolve(path, entry);
    if (statSync(absolute).isDirectory())
      return productionSourceFiles(absolute);
    if (!/\.(?:ts|tsx)$/u.test(entry) || entry.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

describe('browser storage policy', () => {
  it('allows persistent browser storage only in the lock preference module', () => {
    const filesUsingPersistentStorage = productionRoots
      .flatMap((root) => productionSourceFiles(resolve(projectRoot, root)))
      .filter((file) =>
        /localStorage|sessionStorage|indexedDB|document\.cookie/u.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(projectRoot, file).replaceAll('\\', '/'));

    expect(filesUsingPersistentStorage).toEqual([
      'src/security/lockPreferenceStorage.ts',
    ]);
  });
});
