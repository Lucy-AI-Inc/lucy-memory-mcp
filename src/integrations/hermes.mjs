import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { acquireHermesAdvisoryLock, assertHermesAdvisoryLockSupport } from './hermes-advisory-lock.mjs';
import {
  assertAbsolute,
  assertEffectiveOwner,
  assertInside,
  validateContainedParent,
  validateExistingParent,
  validateSafeDirectoryChain,
} from './hermes-filesystem.mjs';
import YAML from 'yaml';
import {
  installHermesLucyArtifact as installClosedHermesLucyArtifact,
  verifyHermesLucyArtifactAgainstSource,
} from './hermes-artifact.mjs';

const BACKUP_SUFFIX = '.lucy-memory.bak';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_PERMISSIONS = ['memory:read', 'memory:propose'];

function assertSecureLocalWritesSupported() {
  if (process.platform === 'win32') throw new Error('secure Hermes config writes are not supported on Windows');
}

function assertHermesInstallerMutationSupported() {
  assertSecureLocalWritesSupported();
  assertHermesAdvisoryLockSupport('Hermes installer');
}

function statRegularFile(path, label, { required = false } = {}) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  assertEffectiveOwner(stat, label);
  if (stat.nlink !== 1) throw new Error(`${label} must not be hard linked.`);
  return stat;
}

function secureDirectory(path, label) {
  const absolute = assertAbsolute(path, label);
  validateSafeDirectoryChain(dirname(absolute), `${label} parent`, { allowMissing: true });
  const pieces = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const piece of pieces) {
    current = join(current, piece);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link.`);
      if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    }
  }
  validateSafeDirectoryChain(absolute, label, { requireLeafOwner: true });
  chmodSync(absolute, PRIVATE_DIRECTORY_MODE);
  return absolute;
}
function isolatedProfile(path, { create = false } = {}) {
  const absolute = assertAbsolute(path, 'profilePath');
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) {
    if (!create) throw new Error('Hermes profile must exist.');
    return secureDirectory(absolute, 'Hermes profile');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Hermes profile must be a directory without symbolic links.');
  validateSafeDirectoryChain(absolute, 'Hermes profile', { requireLeafOwner: true });
  assertEffectiveOwner(stat, 'Hermes profile');
  if ((stat.mode & 0o077) !== 0) throw new Error('An existing Hermes profile must already be private; refusing to change its permissions.');
  return absolute;
}
function assertConfigInside(path, profile) {
  assertInside(path, profile, 'Hermes config');
  const relativePath = relative(profile, path);
  if (!relativePath || relativePath === '.lucy-memory' || relativePath.startsWith(`.lucy-memory${sep}`)) throw new Error('Hermes config must be a file inside the isolated profile and outside installer state.');
}
function existing(path) { return lstatSync(path, { throwIfNoEntry: false }); }
function acquireConfigLock(profile) {
  const state = secureDirectory(join(profile, '.lucy-memory'), 'Hermes config state directory');
  return acquireHermesAdvisoryLock(
    state,
    '.config.lock',
    'Hermes config lock',
    'Another Hermes config update is active for this isolated profile.',
  );
}

function readRegularText(path, label) {
  statRegularFile(path, label, { required: true });
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${label} must be a regular file.`);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

function parseYamlDocument(text, label) {
  const document = YAML.parseDocument(text, { uniqueKeys: true, prettyErrors: true, strict: true, maxAliasCount: 0 });
  if (document.errors.length || document.warnings.length) throw new Error(`Invalid ${label} YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join('; ')}`);
  let forbidden = false;
  YAML.visit(document, { Node: (_key, node) => { if (node?.anchor || YAML.isAlias(node) || node?.tag) forbidden = true; } });
  if (forbidden) throw new Error(`${label} must not contain YAML anchors, aliases, or explicit tags.`);
  const value = document.toJS();
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${label} must contain a YAML mapping.`);
  }
  return document;
}

function readYamlDocument(path, label) { return parseYamlDocument(readRegularText(path, label), label); }

function yamlObject(document, label) {
  const value = document.toJS() ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a YAML mapping.`);
  return value;
}

function assertNoLegacyRawLucyToken(current) {
  const lucy = current?.mcp_servers?.lucy;
  if (!lucy || typeof lucy !== 'object' || Array.isArray(lucy)) return;
  const environment = lucy.env;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
      || !Object.hasOwn(environment, 'LUCY_MEMORY_TOKEN')) return;
  const token = environment.LUCY_MEMORY_TOKEN;
  if (typeof token !== 'string' || !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(token)) {
    throw new Error('Existing Lucy configuration contains a raw token; remove it and rotate the credential before installation.');
  }
}

function clampRegularFilePrivate(path, label) {
  statRegularFile(path, label, { required: true });
  const fd = openSync(path, constants.O_WRONLY | NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${label} must be a regular file.`);
    fchmodSync(fd, PRIVATE_FILE_MODE); fsyncSync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function atomicWritePrivate(path, contents, label) {
  assertSecureLocalWritesSupported();
  const parent = dirname(path);
  if (!validateExistingParent(path, label, { allowMissing: false })) throw new Error(`${label} parent is missing.`);
  statRegularFile(path, label);
  const temporaryPath = join(parent, `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`);
  let fd; let temporaryExists = false;
  try {
    fd = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, PRIVATE_FILE_MODE);
    temporaryExists = true;
    writeFileSync(fd, contents, 'utf8'); fchmodSync(fd, PRIVATE_FILE_MODE); fsyncSync(fd); closeSync(fd); fd = undefined;
    statRegularFile(path, label); // detect replacement with symlink/special file before rename
    renameSync(temporaryPath, path); temporaryExists = false; syncDirectory(parent);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporaryExists) rmSync(temporaryPath, { force: true });
  }
}

function removeRegularFile(path, label) {
  if (!statRegularFile(path, label)) return false;
  rmSync(path); return true;
}

function digest(text) { return createHash('sha256').update(text).digest('hex'); }

function envReference(tokenEnv, token) {
  if (token !== undefined) throw new Error('Raw token values are forbidden; use tokenEnv with an environment variable name.');
  if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) {
    throw new Error('tokenEnv is required and must be an uppercase environment variable name.');
  }
  return `\${${tokenEnv}}`;
}

function managedPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length !== REQUIRED_PERMISSIONS.length
      || permissions.some((permission, index) => permission !== REQUIRED_PERMISSIONS[index])) {
    throw new Error('Lucy requires exactly the memory:read and memory:propose permissions.');
  }
  return permissions;
}

function serializeYaml(document) { return document.toString({ lineWidth: 0 }); }

export function installHermesLucyArtifact(profilePath, options = {}) {
  assertHermesInstallerMutationSupported();
  return installClosedHermesLucyArtifact(profilePath, options);
}

function validateBaseUrl(baseUrl, allowInsecureLoopback) {
  if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('baseUrl is required');
  let url; try { url = new URL(baseUrl); } catch { throw new Error('baseUrl must be an absolute HTTPS URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error('baseUrl must not contain credentials, query parameters, or fragments.');
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:')) throw new Error('baseUrl must use HTTPS unless explicit insecure loopback is enabled.');
}

function validateLucyMcpOptions({ baseUrl, tokenEnv, token, permissions = ['memory:read', 'memory:propose'], allowInsecureLoopback = false }) {
  if (typeof allowInsecureLoopback !== 'boolean') throw new Error('allowInsecureLoopback must be a boolean');
  validateBaseUrl(baseUrl, allowInsecureLoopback);
  managedPermissions(permissions); envReference(tokenEnv, token);
}

function validateArtifactConfig(artifact) {
  const required = ['path', 'node_path', 'entrypoint', 'version', 'artifact_digest', 'source_git_sha', 'package_name', 'package_version', 'source_repository', 'receiptPath'];
  if (!artifact || required.some((key) => typeof artifact[key] !== 'string' || !artifact[key])) throw new Error('A complete versioned artifact is required.');
  if (!artifact.compatibility || typeof artifact.compatibility !== 'object' || Array.isArray(artifact.compatibility)) throw new Error('A complete versioned artifact is required.');
}

export function lucyMcpConfig({ baseUrl, tokenEnv, token, permissions = ['memory:read', 'memory:propose'], allowInsecureLoopback = false, artifact }) {
  validateLucyMcpOptions({ baseUrl, tokenEnv, token, permissions, allowInsecureLoopback });
  validateArtifactConfig(artifact);
  return {
    command: artifact.node_path,
    args: [artifact.entrypoint],
    env: {
      LUCY_MEMORY_TOKEN: envReference(tokenEnv, token),
      LUCY_MEMORY_PERMISSIONS: permissions.join(','), LUCY_MEMORY_BASE_URL: baseUrl,
      ...(allowInsecureLoopback ? { LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: 'true' } : {}),
    },
    x_lucy_memory_artifact: {
      version: artifact.version, artifact_digest: artifact.artifact_digest,
      source_git_sha: artifact.source_git_sha, package_name: artifact.package_name,
      package_version: artifact.package_version, source_repository: artifact.source_repository,
      compatibility: artifact.compatibility, receipt_path: artifact.receiptPath,
    },
  };
}

function installConfig(configPath, options) {
  assertHermesInstallerMutationSupported();
  validateLucyMcpOptions(options);
  const path = assertAbsolute(configPath, 'configPath');
  const profilePath = isolatedProfile(options.profilePath, { create: true });
  assertConfigInside(path, profilePath);
  // Refuse unsafe legacy credentials before creating lock state, publishing an
  // artifact, or copying the old configuration into a persistent backup.
  validateContainedParent(path, profilePath, 'Hermes config');
  const preflightStat = statRegularFile(path, 'Hermes config');
  if (preflightStat) {
    const preflight = yamlObject(readYamlDocument(path, 'Hermes config'), 'Hermes config');
    assertNoLegacyRawLucyToken(preflight);
  }
  const preflightBackupPath = path + BACKUP_SUFFIX;
  const preflightBackupStat = statRegularFile(preflightBackupPath, 'Hermes config backup');
  if (preflightBackupStat) {
    const preflightBackup = yamlObject(readYamlDocument(preflightBackupPath, 'Hermes config backup'), 'Hermes config backup');
    assertNoLegacyRawLucyToken(preflightBackup);
  }
  const releaseLock = acquireConfigLock(profilePath);
  try {
    validateContainedParent(path, profilePath, 'Hermes config');
    const configStat = statRegularFile(path, 'Hermes config');
    if (configStat && (configStat.mode & 0o222) === 0) throw new Error('Hermes config is read-only.');
    const backupPath = path + BACKUP_SUFFIX;
    const backupStat = statRegularFile(backupPath, 'Hermes config backup');
    const initialConfigText = configStat ? readRegularText(path, 'Hermes config') : null;
    const initialBackupText = backupStat ? readRegularText(backupPath, 'Hermes config backup') : null;
    const document = configStat ? parseYamlDocument(initialConfigText, 'Hermes config') : YAML.parseDocument('{}\n');
    const current = yamlObject(document, 'Hermes config');
    if (current.mcp_servers !== undefined && (typeof current.mcp_servers !== 'object' || Array.isArray(current.mcp_servers) || current.mcp_servers === null)) {
      throw new Error('Hermes config mcp_servers must be a mapping.');
    }
    assertNoLegacyRawLucyToken(current);
    if (backupStat) {
      const backup = yamlObject(parseYamlDocument(initialBackupText, 'Hermes config backup'), 'Hermes config backup');
      assertNoLegacyRawLucyToken(backup);
    }
    const artifact = installHermesLucyArtifact(profilePath, options.artifact);
    const trustedNode = assertAbsolute(options.artifact.nodePath, 'Node executable');
    if (artifact.node_path !== trustedNode) throw new Error('Published artifact Node path does not match the trusted Node executable.');
    const activationArtifact = { ...artifact, node_path: trustedNode };
    const activationStat = statRegularFile(path, 'Hermes config');
    if (Boolean(activationStat) !== Boolean(configStat) || (activationStat && readRegularText(path, 'Hermes config') !== initialConfigText)) {
      throw new Error('Hermes config changed during artifact publication; retry against the current config.');
    }
    const activationBackupStat = statRegularFile(backupPath, 'Hermes config backup');
    if (Boolean(activationBackupStat) !== Boolean(backupStat)
        || (activationBackupStat && readRegularText(backupPath, 'Hermes config backup') !== initialBackupText)) {
      throw new Error('Hermes config backup changed during artifact publication; retry against the current backup.');
    }
    releaseLock.assertHeld();
    // The backup contains pre-install local state and is never regenerated on updates.
    if (backupStat) clampRegularFilePrivate(backupPath, 'Hermes config backup');
    else if (configStat) atomicWritePrivate(backupPath, initialConfigText, 'Hermes config backup');
    document.setIn(['mcp_servers', 'lucy'], lucyMcpConfig({ ...options, artifact: activationArtifact }));
    releaseLock.assertHeld();
    atomicWritePrivate(path, serializeYaml(document), 'Hermes config');
    return { path, backup: existsSync(backupPath) ? backupPath : null, artifact: activationArtifact };
  } finally {
    releaseLock();
  }
}

export function installHermesLucyConfig(configPath, options = {}) { return installConfig(configPath, options); }
export function updateHermesLucyConfig(configPath, options = {}) { return installConfig(configPath, options); }

export function rollbackHermesLucyConfig(configPath, { profilePath, receiptPath, sourcePath, expectedSourceGitSha, trustedHermesVersion, trustedNodePath } = {}) {
  assertHermesInstallerMutationSupported();
  const path = assertAbsolute(configPath, 'configPath');
  const profile = isolatedProfile(profilePath);
  assertConfigInside(path, profile);
  const releaseLock = acquireConfigLock(profile);
  try {
    validateContainedParent(path, profile, 'Hermes config');
    if (typeof trustedNodePath !== 'string' || !trustedNodePath) throw new Error('Trusted rollback Node executable is required.');
    const trustedNode = assertAbsolute(trustedNodePath, 'Trusted rollback Node executable');
    const receipt = verifyHermesLucyArtifactAgainstSource(assertAbsolute(receiptPath, 'receiptPath'), profile, { sourcePath, expectedSourceGitSha, trustedHermesVersion, trustedNodePath: trustedNode });
    if (receipt.node_path !== trustedNode) throw new Error('Verified artifact Node path does not match the trusted Node executable.');
    const activationArtifact = { ...receipt, receiptPath, node_path: trustedNode };
    const configStat = statRegularFile(path, 'Hermes config', { required: true });
    if ((configStat.mode & 0o222) === 0) throw new Error('Hermes config is read-only.');
    const document = readYamlDocument(path, 'Hermes config');
    const current = yamlObject(document, 'Hermes config');
    if (!current.mcp_servers || typeof current.mcp_servers !== 'object' || Array.isArray(current.mcp_servers)) throw new Error('Hermes config has no MCP mapping.');
    const lucy = current.mcp_servers.lucy;
    if (!lucy?.env?.LUCY_MEMORY_TOKEN || !lucy?.env?.LUCY_MEMORY_BASE_URL) throw new Error('Hermes config has no managed Lucy entry.');
    const ref = lucy.env.LUCY_MEMORY_TOKEN;
    if (!/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(ref)) throw new Error('Managed Lucy token is not an environment reference.');
    document.setIn(['mcp_servers', 'lucy'], lucyMcpConfig({
      baseUrl: lucy.env.LUCY_MEMORY_BASE_URL, tokenEnv: ref.slice(2, -1),
      permissions: String(lucy.env.LUCY_MEMORY_PERMISSIONS ?? '').split(',').filter(Boolean),
      allowInsecureLoopback: lucy.env.LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK === 'true', artifact: activationArtifact,
    }));
    releaseLock.assertHeld();
    atomicWritePrivate(path, serializeYaml(document), 'Hermes config');
    return { path, artifact: activationArtifact };
  } finally {
    releaseLock();
  }
}

export function uninstallHermesLucyConfig(configPath, { profilePath } = {}) {
  assertHermesInstallerMutationSupported();
  const path = assertAbsolute(configPath, 'configPath');
  const profile = isolatedProfile(profilePath);
  assertConfigInside(path, profile);
  const releaseLock = acquireConfigLock(profile);
  try {
    validateContainedParent(path, profile, 'Hermes config');
    const backupPath = path + BACKUP_SUFFIX;
    const configStat = statRegularFile(path, 'Hermes config');
    const backupStat = statRegularFile(backupPath, 'Hermes config backup');
    if (!configStat) { if (backupStat) readYamlDocument(backupPath, 'Hermes config backup'); return { restored: false }; }
    if ((configStat.mode & 0o222) === 0) throw new Error('Hermes config is read-only.');
    const document = readYamlDocument(path, 'Hermes config');
    const current = yamlObject(document, 'Hermes config');
    if (backupStat) readYamlDocument(backupPath, 'Hermes config backup');
    let removed = false;
    if (current.mcp_servers && typeof current.mcp_servers === 'object' && !Array.isArray(current.mcp_servers) && Object.hasOwn(current.mcp_servers, 'lucy')) {
      document.deleteIn(['mcp_servers', 'lucy']); removed = true;
      releaseLock.assertHeld();
      atomicWritePrivate(path, serializeYaml(document), 'Hermes config');
    } else {
      releaseLock.assertHeld();
      clampRegularFilePrivate(path, 'Hermes config');
    }
    if (backupStat) {
      releaseLock.assertHeld();
      removeRegularFile(backupPath, 'Hermes config backup');
    }
    return { restored: false, removed };
  } finally {
    releaseLock();
  }
}

export function hermesLucyStatus(configPath) {
  const path = assertAbsolute(configPath, 'configPath');
  // Status is verification-only: validate existing parents but never create or clamp them.
  if (!validateExistingParent(path, 'Hermes config', { allowMissing: true })) return { installed: false };
  if (!statRegularFile(path, 'Hermes config')) return { installed: false };
  const lucy = yamlObject(readYamlDocument(path, 'Hermes config'), 'Hermes config').mcp_servers?.lucy;
  return { installed: Boolean(lucy), hasToken: /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(lucy?.env?.LUCY_MEMORY_TOKEN ?? ''), baseUrl: lucy?.env?.LUCY_MEMORY_BASE_URL ?? null, permissions: lucy?.env?.LUCY_MEMORY_PERMISSIONS ?? null, artifact: lucy?.x_lucy_memory_artifact?.artifact_digest ?? null };
}

/** Removes only the private pre-install YAML backup. Artifact and receipt caches are retained. */
export function resetHermesLucyBackup(configPath, { profilePath } = {}) {
  assertHermesInstallerMutationSupported();
  const path = assertAbsolute(configPath, 'configPath');
  const profile = isolatedProfile(profilePath);
  assertConfigInside(path, profile);
  const releaseLock = acquireConfigLock(profile);
  try {
    validateContainedParent(path, profile, 'Hermes config');
    releaseLock.assertHeld();
    removeRegularFile(path + BACKUP_SUFFIX, 'Hermes config backup');
  } finally {
    releaseLock();
  }
}

/** @deprecated Use resetHermesLucyBackup; this legacy alias retains artifact and receipt caches. */
export const resetHermesLucyArtifacts = resetHermesLucyBackup;
