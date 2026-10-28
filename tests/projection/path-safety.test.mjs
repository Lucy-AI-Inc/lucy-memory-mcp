import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertInsideDirectory } from '../../src/projection/memory-md.mjs';

test('projection paths cannot escape the destination directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-safe-'));
  assert.throws(() => assertInsideDirectory(dir, join(dir, '..', 'etc', 'passwd')));
  assert.ok(assertInsideDirectory(dir, join(dir, 'USER.md')).endsWith('USER.md'));
  rmSync(dir, { recursive: true, force: true });
});
