import {
  chmodSync,
  closeSync,
  fchmodSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

const MARKER = '<!-- lucy-generated-projection -->';
const PROJECTION_FILE_MODE = 0o600;
const PROJECTION_DIRECTORY_MODE = 0o700;
const TEMP_CREATE_ATTEMPTS = 16;

export function renderProjection({ title, memories, generatedAt }) {
  const lines = [
    MARKER,
    `# ${title}`,
    '',
    'Generated from Lucy governed memory. This file is not canonical.',
    `generated_at: ${generatedAt}`,
    '',
  ];
  for (const row of memories) {
    lines.push(`## ${row.key}`);
    lines.push('');
    lines.push(row.content);
    lines.push('');
    lines.push(`- lucy_memory_id: ${row.id}`);
    lines.push(`- lucy_version: ${row.version}`);
    lines.push(`- kind: ${row.kind}`);
    lines.push(`- scope: ${row.scope?.kind ?? 'unknown'}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function isGeneratedProjection(text) {
  return typeof text === 'string' && text.includes(MARKER);
}

export function detectStale(projectionText, memories) {
  if (!isGeneratedProjection(projectionText)) return { stale: true, reason: 'not_generated' };
  const ids = new Set((memories ?? []).map((row) => `${row.id}@${row.version}`));
  const found = [...projectionText.matchAll(/lucy_memory_id:\s+(\S+)/g)].map((m) => m[1]);
  const versions = [...projectionText.matchAll(/lucy_version:\s+(\S+)/g)].map((m) => m[1]);
  const projected = new Set(found.map((id, i) => `${id}@${versions[i]}`));
  if (ids.size !== projected.size) return { stale: true, reason: 'count_mismatch' };
  for (const item of ids) if (!projected.has(item)) return { stale: true, reason: 'version_mismatch' };
  return { stale: false, reason: 'current' };
}

export function detectConflict(localAuthoredText, memories) {
  if (isGeneratedProjection(localAuthoredText)) return { conflict: false };
  const hay = String(localAuthoredText ?? '');
  for (const row of memories ?? []) {
    if (hay.includes(row.key) && row.content && !hay.includes(row.content)) {
      return { conflict: true, winner: 'lucy', memory_id: row.id, version: row.version };
    }
  }
  return { conflict: false };
}

export function assertInsideDirectory(root, target) {
  const base = resolve(root);
  const resolved = resolve(target);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error('projection path escapes destination directory');
  }
  return resolved;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function currentUid() {
  if (typeof process.geteuid !== 'function') {
    throw new Error('secure local projection writes require POSIX ownership checks');
  }
  return process.geteuid();
}

function pathComponents(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  const paths = [root];
  let current = root;
  for (const component of components) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

function assertSafeDirectoryComponent(path, stat, { final = false } = {}) {
  if (stat.isSymbolicLink()) {
    throw new Error('projection path must not traverse a symbolic link');
  }
  if (!stat.isDirectory()) {
    throw new Error('projection parent path must contain only directories');
  }

  const mode = stat.mode & 0o7777;
  const broadlyWritable = (mode & 0o022) !== 0;
  const stickyDirectory = (mode & 0o1000) !== 0;
  const uid = currentUid();
  const filesystemOwner = lstatSync(parse(resolve(path)).root).uid;
  const trustedOwner = stat.uid === uid || stat.uid === filesystemOwner;
  if (broadlyWritable && !stickyDirectory) {
    throw new Error('projection parent path contains an unsafe writable directory');
  }
  if ((stickyDirectory || (mode & 0o200) !== 0) && !trustedOwner) {
    throw new Error('projection parent path contains a directory controlled by another user');
  }
  if (final && (stat.uid !== uid || broadlyWritable)) {
    throw new Error('projection destination directory must be private and owned by the current user');
  }
}

function ensureSecureProjectionDirectory(path) {
  const components = pathComponents(path);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    let stat = lstatIfPresent(component);
    let created = false;
    if (!stat) {
      try {
        mkdirSync(component, { mode: PROJECTION_DIRECTORY_MODE });
        created = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      stat = lstatSync(component);
      if (created) chmodSync(component, PROJECTION_DIRECTORY_MODE);
    }
    assertSafeDirectoryComponent(component, stat, { final: index === components.length - 1 });
  }
  return resolve(path);
}

function validateExistingProjectionDirectory(path) {
  const components = pathComponents(path);
  for (let index = 0; index < components.length; index += 1) {
    const stat = lstatIfPresent(components[index]);
    if (!stat) return false;
    assertSafeDirectoryComponent(components[index], stat, { final: index === components.length - 1 });
  }
  return true;
}

function assertDirectoryFdMatchesPath(fd, path) {
  const descriptor = fstatSync(fd);
  if (!descriptor.isDirectory()) throw new Error('projection destination is not a directory');
  const pathname = lstatSync(path);
  assertSafeDirectoryComponent(path, pathname, { final: true });
  if (descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino) {
    throw new Error('projection destination directory changed during write');
  }
}

function openAnchoredProjectionDirectory(path) {
  const flags = constants.O_RDONLY
    | constants.O_DIRECTORY
    | constants.O_NOFOLLOW;
  const fd = openSync(path, flags);
  try {
    assertDirectoryFdMatchesPath(fd, path);
    // Rewalk the path after opening. Subsequent file operations are anchored to
    // this descriptor, so a later rename cannot redirect them elsewhere.
    for (const component of pathComponents(path)) {
      assertSafeDirectoryComponent(component, lstatSync(component), { final: component === path });
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertRegularProjectionTarget(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error('refusing to overwrite a symlink projection');
  if (!stat.isFile()) throw new Error('refusing to overwrite a non-regular projection');
  return stat;
}

function openRandomTemporaryFile(parentFd, filename) {
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
    const temporaryName = `${filename}.${randomBytes(16).toString('hex')}.tmp`;
    const temporaryPath = `/proc/self/fd/${parentFd}/${temporaryName}`;
    try {
      const fd = openSync(temporaryPath, flags, PROJECTION_FILE_MODE);
      return { fd, temporaryPath };
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') continue;
      throw error;
    }
  }
  throw new Error('could not create an exclusive projection temporary file');
}

export function writeProjectionAtomic(path, text) {
  if (process.platform === 'win32') {
    throw new Error('secure local projection writes are not supported on Windows');
  }
  if (process.platform !== 'linux') {
    throw new Error('secure local projection writes require Linux directory-descriptor anchoring');
  }
  const resolvedPath = resolve(path);
  const parent = ensureSecureProjectionDirectory(dirname(resolvedPath));
  const filename = basename(resolvedPath);
  const parentFd = openAnchoredProjectionDirectory(parent);
  const anchoredTarget = `/proc/self/fd/${parentFd}/${filename}`;

  let fd;
  let temporaryPath;
  try {
    assertRegularProjectionTarget(anchoredTarget);
    ({ fd, temporaryPath } = openRandomTemporaryFile(parentFd, filename));
    if (!fstatSync(fd).isFile()) throw new Error('refusing to write a non-regular projection temporary file');
    fchmodSync(fd, PROJECTION_FILE_MODE);
    writeFileSync(fd, text, { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Recheck immediately before replacement. rename never follows the target,
    // so a racing symlink cannot redirect projection content to its referent.
    assertDirectoryFdMatchesPath(parentFd, parent);
    assertRegularProjectionTarget(anchoredTarget);
    renameSync(temporaryPath, anchoredTarget);
    temporaryPath = undefined;
    fsyncSync(parentFd);
    assertDirectoryFdMatchesPath(parentFd, parent);
  } finally {
    try {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original write error; unlink below is still attempted.
        }
      }
      if (temporaryPath !== undefined) {
        try {
          unlinkSync(temporaryPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } finally {
      closeSync(parentFd);
    }
  }
}

export function refreshProjections(directory, recallResponse) {
  const root = resolve(directory);
  const generatedAt = new Date().toISOString();
  const memories = recallResponse?.results ?? [];
  const user = memories.filter((row) => row.scope?.kind === 'user');
  const rest = memories.filter((row) => row.scope?.kind !== 'user');
  const files = {
    [assertInsideDirectory(root, join(root, 'USER.md'))]: renderProjection({ title: 'USER', memories: user, generatedAt }),
    [assertInsideDirectory(root, join(root, 'MEMORY.md'))]: renderProjection({ title: 'MEMORY', memories: rest.length ? rest : memories, generatedAt }),
  };
  for (const [path, text] of Object.entries(files)) writeProjectionAtomic(path, text);
  return files;
}

export function readProjection(path) {
  if (process.platform !== 'linux') {
    throw new Error('secure local projection reads require Linux directory-descriptor anchoring');
  }
  const resolvedPath = resolve(path);
  const parent = dirname(resolvedPath);
  if (!validateExistingProjectionDirectory(parent)) return '';

  const parentFd = openAnchoredProjectionDirectory(parent);
  const anchoredTarget = `/proc/self/fd/${parentFd}/${basename(resolvedPath)}`;
  let fd;
  try {
    const expected = assertRegularProjectionTarget(anchoredTarget);
    if (!expected) return '';
    fd = openSync(anchoredTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error('projection changed during read');
    }
    return readFileSync(fd, 'utf8');
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      closeSync(parentFd);
    }
  }
}
