import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeSourceBuildId } from '../../scripts/sourceBuildId';

const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'nito-build-id-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'wallet.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n');
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('source-derived build identifier', () => {
  it('is stable for an unchanged source tree and changes with source content', () => {
    const root = fixture();
    const first = computeSourceBuildId(root);
    expect(computeSourceBuildId(root)).toBe(first);
    expect(first).toMatch(/^nito-[0-9a-f]{32}$/u);

    writeFileSync(join(root, 'src', 'wallet.ts'), 'export const value = 2;\n');
    expect(computeSourceBuildId(root)).not.toBe(first);
  });

  it('ignores generated dependency and build directories', () => {
    const root = fixture();
    const first = computeSourceBuildId(root);
    for (const directory of ['dist', 'node_modules', 'target']) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, 'generated.js'), String(Math.random()));
    }
    expect(computeSourceBuildId(root)).toBe(first);
  });
});
