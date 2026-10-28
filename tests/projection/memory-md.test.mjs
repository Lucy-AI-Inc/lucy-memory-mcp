import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  detectConflict,
  detectStale,
  isGeneratedProjection,
  readProjection,
  refreshProjections,
  renderProjection,
  writeProjectionAtomic,
} from '../../src/projection/memory-md.mjs';

const mem = {
  id: 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  version: 1,
  key: 'profile.name',
  kind: 'fact',
  scope: { kind: 'user' },
  content: 'Ada',
};

test('generated projection is marked, atomic, and stale-detectable', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  refreshProjections(dir, { results: [mem] });
  const user = readFileSync(join(dir, 'USER.md'), 'utf8');
  assert.equal(isGeneratedProjection(user), true);
  assert.match(user, /lucy_memory_id: mem_/);
  assert.equal(detectStale(user, [mem]).stale, false);
  assert.equal(detectStale(user, [{ ...mem, version: 2 }]).stale, true);
  assert.equal(detectConflict('profile.name is Bob', [mem]).conflict, true);
  assert.equal(detectConflict('profile.name is Bob', [mem]).winner, 'lucy');
  assert.equal(statSync(join(dir, 'USER.md')).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'MEMORY.md')).mode & 0o777, 0o600);
});

test('projection applies no sensitivity behavior that the frozen recall contract cannot express', () => {
  const memorySchema = JSON.parse(readFileSync(new URL('../../schemas/v1/memory.schema.json', import.meta.url), 'utf8'));
  assert.equal(memorySchema.additionalProperties, false);
  assert.equal(memorySchema.properties.sensitive, undefined);

  // Even an out-of-contract property must not silently create an authority rule.
  const unsupportedSensitivity = { ...mem, sensitive: true };
  const rendered = renderProjection({ title: 'X', generatedAt: 't', memories: [unsupportedSensitivity] });
  assert.match(rendered, /Ada/);
  assert.equal(detectStale(rendered, [unsupportedSensitivity]).stale, false);
  assert.equal(detectConflict('profile.name is Bob', [unsupportedSensitivity]).conflict, true);
});

test('atomic projection writes do not follow or consume a predictable temporary symlink', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-temp-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'USER.md');
  const victim = join(dir, 'victim.txt');
  const predictableTemp = `${target}.tmp`;
  writeFileSync(victim, 'do not overwrite');
  symlinkSync(victim, predictableTemp);

  writeProjectionAtomic(target, 'safe projection');

  assert.equal(readFileSync(victim, 'utf8'), 'do not overwrite');
  assert.equal(lstatSync(predictableTemp).isSymbolicLink(), true);
  assert.equal(lstatSync(target).isFile(), true);
  assert.equal(readFileSync(target, 'utf8'), 'safe projection');
});

test('atomic projection writes leave a predictable temporary-file collision untouched', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-temp-collision-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'MEMORY.md');
  const predictableTemp = `${target}.tmp`;
  writeFileSync(predictableTemp, 'belongs to another process');

  writeProjectionAtomic(target, 'new projection');

  assert.equal(readFileSync(predictableTemp, 'utf8'), 'belongs to another process');
  assert.equal(readFileSync(target, 'utf8'), 'new projection');
});

test('atomic projection writes reject symlink and non-regular targets', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-target-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dangling = join(dir, 'dangling.md');
  symlinkSync(join(dir, 'missing'), dangling);
  assert.throws(() => writeProjectionAtomic(dangling, 'no'), /symlink projection/);

  const nonRegular = join(dir, 'directory.md');
  mkdirSync(nonRegular);
  assert.throws(() => writeProjectionAtomic(nonRegular, 'no'), /non-regular projection/);
});

test('projection writes reject symlinked destination roots and intermediate directories before mutation', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-parent-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outside = join(dir, 'outside');
  const rootLink = join(dir, 'root-link');
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, rootLink);

  assert.throws(
    () => refreshProjections(rootLink, { results: [mem] }),
    /must not traverse a symbolic link/,
  );
  assert.deepEqual(readdirSync(outside), []);

  const safeRoot = join(dir, 'safe-root');
  mkdirSync(safeRoot, { mode: 0o700 });
  const intermediate = join(safeRoot, 'nested');
  symlinkSync(outside, intermediate);
  assert.throws(
    () => writeProjectionAtomic(join(intermediate, 'USER.md'), 'do not write'),
    /must not traverse a symbolic link/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

test('a destination-directory replacement cannot redirect a projection write', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-parent-swap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const original = join(dir, 'original-root');
  const outside = join(dir, 'outside');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  writeProjectionAtomic(join(root, 'USER.md'), 'original projection');

  renameSync(root, original);
  symlinkSync(outside, root);

  assert.throws(
    () => writeProjectionAtomic(join(root, 'USER.md'), 'redirected projection'),
    /must not traverse a symbolic link/,
  );
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readFileSync(join(original, 'USER.md'), 'utf8'), 'original projection');
});

test('projection reads reject symlinked roots and leaves', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-read-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  writeProjectionAtomic(join(root, 'USER.md'), 'safe projection');
  writeFileSync(join(outside, 'secret.txt'), 'do not ingest');

  assert.equal(readProjection(join(root, 'USER.md')), 'safe projection');
  assert.equal(readProjection(join(root, 'missing.md')), '');

  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.md'));
  assert.throws(
    () => readProjection(join(root, 'linked.md')),
    /symlink projection/,
  );

  symlinkSync(outside, join(dir, 'root-link'));
  assert.throws(
    () => readProjection(join(dir, 'root-link', 'secret.txt')),
    /must not traverse a symbolic link/,
  );
});

test('projection writes reject broadly writable destination ancestors', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-writable-parent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unsafe = join(dir, 'unsafe');
  mkdirSync(unsafe, { mode: 0o777 });
  chmodSync(unsafe, 0o777);

  assert.throws(
    () => writeProjectionAtomic(join(unsafe, 'nested', 'USER.md'), 'do not write'),
    /unsafe writable directory/,
  );
  assert.deepEqual(readdirSync(unsafe), []);
});

test('atomic projection writes replace permissive files with mode 0600 and clean temporary files on failure', {
  skip: process.platform !== 'linux',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'USER.md');
  writeFileSync(target, 'old');
  chmodSync(target, 0o644);

  writeProjectionAtomic(target, 'new');
  assert.equal(statSync(target).mode & 0o777, 0o600);

  const privateTarget = join(dir, 'private', 'nested', 'MEMORY.md');
  writeProjectionAtomic(privateTarget, 'private');
  assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'private', 'nested')).mode & 0o777, 0o700);
  assert.equal(statSync(privateTarget).mode & 0o777, 0o600);

  const failedTarget = join(dir, 'failed.md');
  assert.throws(() => writeProjectionAtomic(failedTarget, Symbol('not writable')));
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith('failed.md.')),
    [],
  );
});

test('local projection writes fail closed on Windows without changing the target', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-proj-windows-closed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'USER.md');
  writeFileSync(target, 'preserve');

  assert.throws(
    () => writeProjectionAtomic(target, 'do not write'),
    /secure local projection writes are not supported on Windows/,
  );
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
  assert.deepEqual(readdirSync(dir), ['USER.md']);
});
