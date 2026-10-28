import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEffectiveOwner, assertTrustedOwner, validateSafeDirectoryChain } from './hermes-filesystem.mjs';

const PRIVATE_FILE_MODE = 0o600;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const READY_TIMEOUT_MILLISECONDS = 2_000;
const TRUSTED_FLOCK_PATH = '/usr/bin/flock';

function trustedFlockPath() {
  let stat;
  try { stat = lstatSync(TRUSTED_FLOCK_PATH); } catch { return null; }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) return null;
  try { assertTrustedOwner(stat, 'util-linux flock executable'); } catch { return null; }
  try { validateSafeDirectoryChain('/usr/bin', 'util-linux flock executable parent'); } catch { return null; }
  return TRUSTED_FLOCK_PATH;
}

function flockFd(flockPath, fd) {
  return spawnSync(flockPath, ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'ignore', fd],
    timeout: READY_TIMEOUT_MILLISECONDS,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
}

function openPrivateLock(path, label, { exclusiveCreate = false } = {}) {
  const flags = constants.O_RDWR | constants.O_CREAT | NOFOLLOW | (exclusiveCreate ? constants.O_EXCL : 0);
  const fd = openSync(path, flags, PRIVATE_FILE_MODE);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
    assertEffectiveOwner(stat, label);
    if (stat.nlink !== 1) throw new Error(`${label} must not be hard linked.`);
    fchmodSync(fd, PRIVATE_FILE_MODE);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Prove the fixed util-linux executable supports locking an already-open file
 * descriptor. The parent keeps the same open-file description after the
 * one-shot flock process exits, so the kernel lease has no helper lifecycle.
 */
function flockAvailable() {
  const flockPath = trustedFlockPath();
  if (!flockPath) return false;
  const version = spawnSync(flockPath, ['--version'], {
    encoding: 'utf8', timeout: READY_TIMEOUT_MILLISECONDS,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  const identity = `${version.stdout ?? ''}\n${version.stderr ?? ''}`;
  if (version.error || version.status !== 0 || !/^flock from util-linux\b/m.test(identity)) return false;

  let probeRoot; let ownerFd; let contenderFd;
  try {
    probeRoot = mkdtempSync(join(tmpdir(), 'lucy-hermes-flock-probe-'));
    validateSafeDirectoryChain(probeRoot, 'Hermes flock probe', { requireLeafOwner: true });
    const probeLock = join(probeRoot, 'probe.lock');
    ownerFd = openPrivateLock(probeLock, 'Hermes flock probe lock', { exclusiveCreate: true });
    const acquired = flockFd(flockPath, ownerFd);
    if (acquired.error || acquired.status !== 0) return false;

    contenderFd = openPrivateLock(probeLock, 'Hermes flock probe lock');
    const blocked = flockFd(flockPath, contenderFd);
    if (blocked.error || blocked.status === 0) return false;

    closeSync(ownerFd); ownerFd = undefined;
    const released = flockFd(flockPath, contenderFd);
    return !released.error && released.status === 0;
  } catch {
    return false;
  } finally {
    if (ownerFd !== undefined) closeSync(ownerFd);
    if (contenderFd !== undefined) closeSync(contenderFd);
    if (probeRoot) {
      try { rmSync(probeRoot, { recursive: true, force: true }); } catch { /* private probe cleanup is best effort */ }
    }
  }
}

/** Fail before any caller creates installer-owned profile/artifact state. */
export function assertHermesAdvisoryLockSupport(label) {
  if (process.platform !== 'linux') throw new Error(`${label} requires Linux advisory locking support.`);
  if (!flockAvailable()) throw new Error(`${label} requires the trusted util-linux flock executable at ${TRUSTED_FLOCK_PATH}.`);
}

/**
 * Acquire a kernel advisory lease on the exact O_NOFOLLOW descriptor verified
 * by this process. util-linux applies flock(2) to the inherited descriptor and
 * exits; the parent retains the locked open-file description until release.
 */
export function acquireHermesAdvisoryLock(state, name, label, activeMessage) {
  assertHermesAdvisoryLockSupport(label);
  validateSafeDirectoryChain(state, `${label} state directory`, { requireLeafOwner: true, requirePrivateLeaf: true });
  const lockPath = join(state, name);
  const fd = openPrivateLock(lockPath, label);
  const flockPath = trustedFlockPath();
  const acquired = flockFd(flockPath, fd);
  if (acquired.error || acquired.status !== 0) {
    closeSync(fd);
    throw new Error(activeMessage);
  }

  const locked = fstatSync(fd);
  let released = false;
  const assertHeld = () => {
    if (released) throw new Error(`${label} advisory lease is no longer held.`);
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== locked.dev || current.ino !== locked.ino || current.nlink !== 1) {
      throw new Error(`${label} advisory lease identity changed.`);
    }
    const pathname = lstatSync(lockPath, { throwIfNoEntry: false });
    if (!pathname || pathname.isSymbolicLink() || !pathname.isFile()
        || pathname.dev !== locked.dev || pathname.ino !== locked.ino) {
      throw new Error(`${label} advisory lock path changed while held.`);
    }
  };
  const release = () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
  Object.defineProperty(release, 'assertHeld', { value: assertHeld, enumerable: false });
  return release;
}
