import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireHermesAdvisoryLock } from '../../src/integrations/hermes-advisory-lock.mjs';

const linux = { skip: process.platform !== 'linux' };
const label = 'test lease';
const activeMessage = 'another lease is active';

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'lucy-hermes-lock-race-'));
  chmodSync(state, 0o700);
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return { state, lock: join(state, '.installer.lock') };
}

test('parent-held descriptor lease blocks contenders until release', linux, (t) => {
  const { state } = fixture(t);
  const release = acquireHermesAdvisoryLock(state, '.installer.lock', label, activeMessage);
  release.assertHeld();
  assert.throws(
    () => acquireHermesAdvisoryLock(state, '.installer.lock', label, activeMessage),
    /another lease is active/,
  );
  release();
  const next = acquireHermesAdvisoryLock(state, '.installer.lock', label, activeMessage);
  next.assertHeld();
  next();
});

test('ambient PATH executables are ignored by the lease protocol', linux, (t) => {
  const { state } = fixture(t);
  const prior = process.env.PATH;
  process.env.PATH = '';
  try {
    const release = acquireHermesAdvisoryLock(state, '.installer.lock', label, activeMessage);
    release.assertHeld();
    release();
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
});

test('pathname replacement invalidates a held lease and release never unlinks it', linux, (t) => {
  const { state, lock } = fixture(t);
  const release = acquireHermesAdvisoryLock(state, '.installer.lock', label, activeMessage);
  const displaced = `${lock}.displaced`;
  renameSync(lock, displaced);
  writeFileSync(lock, 'external replacement\n', { mode: 0o600 });
  assert.throws(() => release.assertHeld(), /lock path changed while held/);
  release();
  assert.equal(readFileSync(lock, 'utf8'), 'external replacement\n');
  assert.equal(existsSync(displaced), true);
});

test('symlinked and hard-linked lock leaves fail closed', linux, (t) => {
  const symlinkFixture = fixture(t);
  const target = join(symlinkFixture.state, 'target');
  writeFileSync(target, '');
  symlinkSync(target, symlinkFixture.lock);
  assert.throws(
    () => acquireHermesAdvisoryLock(symlinkFixture.state, '.installer.lock', label, activeMessage),
    /symbolic link|ELOOP/i,
  );

  const hardlinkFixture = fixture(t);
  const hardTarget = join(hardlinkFixture.state, 'target');
  writeFileSync(hardTarget, '');
  linkSync(hardTarget, hardlinkFixture.lock);
  assert.throws(
    () => acquireHermesAdvisoryLock(hardlinkFixture.state, '.installer.lock', label, activeMessage),
    /hard linked/i,
  );
});
