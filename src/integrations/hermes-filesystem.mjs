import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EFFECTIVE_UID = typeof process.geteuid === 'function' ? process.geteuid() : null;
const SYSTEM_UID = lstatSync(sep).uid;

function isStickySystemDirectory(stat) {
  return stat.uid === SYSTEM_UID && (stat.mode & 0o1000) !== 0;
}

function assertSafeDirectory(stat, path, label, { requireEffectiveOwner = false, requirePrivate = false } = {}) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  if (EFFECTIVE_UID !== null) {
    if (requireEffectiveOwner && stat.uid !== EFFECTIVE_UID) throw new Error(`${label} must be owned by the effective user.`);
    if (!requireEffectiveOwner && stat.uid !== EFFECTIVE_UID && stat.uid !== SYSTEM_UID) {
      throw new Error(`${label} has an untrusted owner at ${path}.`);
    }
  }
  if ((stat.mode & 0o022) !== 0 && !isStickySystemDirectory(stat)) {
    throw new Error(`${label} has a group- or world-writable ancestor at ${path}.`);
  }
  if (requirePrivate && (stat.mode & 0o077) !== 0) throw new Error(`${label} must already be private.`);
}

export function assertEffectiveOwner(stat, label) {
  if (EFFECTIVE_UID !== null && stat.uid !== EFFECTIVE_UID) throw new Error(`${label} must be owned by the effective user.`);
}

export function assertTrustedOwner(stat, label) {
  if (EFFECTIVE_UID !== null && stat.uid !== EFFECTIVE_UID && stat.uid !== SYSTEM_UID) {
    throw new Error(`${label} must be owned by the effective user or the trusted system owner.`);
  }
}

/**
 * Validate every existing directory from the filesystem root to `path`.
 * System-owned sticky temporary roots are allowed; other writable or
 * unexpected-owner ancestors are rejected.
 */
export function validateSafeDirectoryChain(path, label, { allowMissing = false, requireLeafOwner = false, requirePrivateLeaf = false } = {}) {
  const absolute = assertAbsolute(path, label);
  const parts = absolute.split(sep).filter(Boolean);
  let current = sep;
  const rootStat = lstatSync(current);
  assertSafeDirectory(rootStat, current, label);
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return false;
      throw error;
    }
    const leaf = index === parts.length - 1;
    assertSafeDirectory(stat, current, label, {
      requireEffectiveOwner: leaf && requireLeafOwner,
      requirePrivate: leaf && requirePrivateLeaf,
    });
  }
  return true;
}

export function assertAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  return resolve(path);
}

export function assertInside(path, parent, label) {
  const value = relative(parent, path);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) throw new Error(`${label} must stay inside the isolated profile.`);
}

function directoryChain(path, label, { allowMissing = false } = {}) {
  return validateSafeDirectoryChain(path, label, { allowMissing });
}

/** Verify every existing parent component without chmod or mkdir side effects. */
export function validateExistingParent(path, label, { allowMissing = false } = {}) {
  const absolute = assertAbsolute(path, label);
  return directoryChain(dirname(absolute), `${label} parent`, { allowMissing });
}

/** Verify an existing contained parent chain without chmod or mkdir side effects. */
export function validateContainedParent(path, profilePath, label) {
  const profile = assertAbsolute(profilePath, 'profilePath');
  const absolute = assertAbsolute(path, label);
  assertInside(absolute, profile, label);
  directoryChain(profile, 'Hermes profile');
  const parent = dirname(absolute);
  assertInside(parent, profile, `${label} parent`);
  const tail = relative(profile, parent);
  let current = profile;
  for (const part of tail ? tail.split(sep) : []) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} parent must not traverse a symbolic link.`);
    if (!stat.isDirectory()) throw new Error(`${label} parent must be a directory.`);
    assertEffectiveOwner(stat, `${label} parent`);
    if ((stat.mode & 0o022) !== 0) throw new Error(`${label} parent must not be group- or world-writable.`);
  }
  return absolute;
}

/** Verify an existing contained directory and all of its parents without writes. */
export function validateContainedDirectory(path, profilePath, label) {
  const absolute = validateContainedParent(path, profilePath, label);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  assertEffectiveOwner(stat, label);
  return absolute;
}
