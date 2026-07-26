import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256RegularFile } from './evidence-hash.mjs';

const temporaryRoots = [];

function makeTemporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'okpgui-evidence-hash-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sha256RegularFile', () => {
  it('hashes regular files', () => {
    const root = makeTemporaryRoot();
    const filePath = path.join(root, 'artifact');
    writeFileSync(filePath, 'ok');

    const expected = createHash('sha256').update('ok').digest('hex');
    expect(sha256RegularFile(filePath)).toBe(expected);
  });

  it('does not read package directories as files', () => {
    const root = makeTemporaryRoot();
    const appBundlePath = path.join(root, 'okpgui-next.app');
    mkdirSync(appBundlePath);

    expect(sha256RegularFile(appBundlePath)).toBeNull();
    expect(sha256RegularFile(path.join(root, 'missing.dmg'))).toBeNull();
  });
});
