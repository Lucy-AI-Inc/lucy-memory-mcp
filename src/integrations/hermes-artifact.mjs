import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, sep } from 'node:path';
import { acquireHermesAdvisoryLock } from './hermes-advisory-lock.mjs';
import {
  assertAbsolute,
  assertEffectiveOwner,
  assertInside,
  assertTrustedOwner,
  validateContainedDirectory,
  validateContainedParent,
  validateSafeDirectoryChain,
} from './hermes-filesystem.mjs';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = /^[a-f0-9]{40,64}$/;
const PACKAGE_NAME = '@trylucy/agent-memory';
const PACKAGE_REPOSITORY = 'https://github.com/Lucy-AI-Inc/lucy-memory-mcp.git';
const SOURCE_COPY_ROOTS = ['src', 'schemas', 'contracts', 'scripts/lib'];
const ARTIFACT_COPY_ROOTS = [...SOURCE_COPY_ROOTS, 'node_modules'];
const TRACKED_COPY_ROOTS = SOURCE_COPY_ROOTS;
const TRUSTED_GIT_PATH = '/usr/bin/git';
const SCRUBBED_TOOL_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
});

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function regular(path, label, required = true) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
  return stat;
}
function privateDirectory(path, label) {
  const absolute = assertAbsolute(path, label);
  validateSafeDirectoryChain(dirname(absolute), `${label} parent`, { allowMissing: true });
  const parts = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a directory without symbolic links.`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
    }
  }
  validateSafeDirectoryChain(absolute, label, { requireLeafOwner: true });
  chmodSync(absolute, PRIVATE_DIRECTORY_MODE);
  return absolute;
}
function privateProfile(path) {
  const absolute = assertAbsolute(path, 'Hermes profile');
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return privateDirectory(absolute, 'Hermes profile');
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Hermes profile must be a directory without symbolic links.');
  validateSafeDirectoryChain(absolute, 'Hermes profile', { requireLeafOwner: true });
  assertEffectiveOwner(stat, 'Hermes profile');
  if ((stat.mode & 0o077) !== 0) throw new Error('An existing Hermes profile must already be private; refusing to change its permissions.');
  return absolute;
}
function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY); fsyncSync(fd); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function atomicWrite(path, contents, label) {
  const parent = privateDirectory(dirname(path), `${label} parent`);
  const existingFile = regular(path, label, false);
  if (existingFile) {
    assertEffectiveOwner(existingFile, label);
    if (existingFile.nlink !== 1) throw new Error(`${label} must not be hard linked.`);
  }
  const temporary = join(parent, `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`);
  let fd; let exists = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, PRIVATE_FILE_MODE);
    exists = true; writeFileSync(fd, contents); fchmodSync(fd, PRIVATE_FILE_MODE); fsyncSync(fd); closeSync(fd); fd = undefined;
    regular(path, label, false); renameSync(temporary, path); exists = false; syncDirectory(parent);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (exists) rmSync(temporary, { force: true });
  }
}
function packageRoot(sourcePath) {
  let current = dirname(assertAbsolute(sourcePath, 'Artifact source'));
  while (dirname(current) !== current) {
    const candidate = join(current, 'package.json');
    if (regular(candidate, 'Package manifest', false)) return current;
    current = dirname(current);
  }
  throw new Error('Artifact source must be inside an official package with package.json.');
}
function trustedGit() {
  let stat;
  try { stat = lstatSync(TRUSTED_GIT_PATH); } catch { throw new Error(`Trusted Git executable is unavailable at ${TRUSTED_GIT_PATH}.`); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error('Trusted Git executable must be a non-writable regular executable.');
  }
  assertTrustedOwner(stat, 'Trusted Git executable');
  validateSafeDirectoryChain(dirname(TRUSTED_GIT_PATH), 'Trusted Git executable parent');
  return TRUSTED_GIT_PATH;
}
function git(root, args, label) {
  const result = spawnSync(trustedGit(), ['-C', root, '--no-replace-objects', ...args], { encoding: 'utf8', env: SCRUBBED_TOOL_ENV });
  if (result.status !== 0) throw new Error(`Unable to determine ${label} from the source checkout.`);
  return result.stdout.trim();
}
function gitBytes(root, args, label, input) {
  const result = spawnSync(trustedGit(), ['-C', root, '--no-replace-objects', ...args], { input, maxBuffer: 128 * 1024 * 1024, env: SCRUBBED_TOOL_ENV });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error(`Unable to determine ${label} from the source checkout.`);
  return result.stdout;
}
function commitId(root, revision, label) {
  const result = spawnSync(trustedGit(), ['-C', root, '--no-replace-objects', 'rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8', env: SCRUBBED_TOOL_ENV });
  const commit = result.status === 0 ? result.stdout.trim() : '';
  if (!SHA.test(commit)) throw new Error(`${label} must resolve to a full commit ID.`);
  return commit;
}
function canonicalRepository(value) {
  return String(value ?? '').replace(/^git\+/, '').replace(/\.git$/, '').toLowerCase();
}
function provenance(root, expectedSourceGitSha) {
  const sourceGitSha = commitId(root, 'HEAD', 'Source Git SHA');
  const remote = git(root, ['config', '--get', 'remote.origin.url'], 'source repository');
  if (canonicalRepository(remote) !== canonicalRepository(PACKAGE_REPOSITORY)) throw new Error('Source checkout remote does not match the expected Lucy MCP repository.');
  if (typeof expectedSourceGitSha !== 'string' || !SHA.test(expectedSourceGitSha)) throw new Error('expectedSourceGitSha must be an explicit full commit ID.');
  const expectedCommit = commitId(root, expectedSourceGitSha, 'expectedSourceGitSha');
  if (expectedCommit !== expectedSourceGitSha) throw new Error('expectedSourceGitSha must name a commit object directly.');
  if (sourceGitSha !== expectedCommit) throw new Error('Source checkout HEAD does not match expectedSourceGitSha.');
  return { source_repository: PACKAGE_REPOSITORY, source_git_sha: sourceGitSha };
}
function packageProvenance(manifest) {
  if (!manifest || manifest.name !== PACKAGE_NAME || canonicalRepository(manifest.repository?.url) !== canonicalRepository(PACKAGE_REPOSITORY)
      || typeof manifest.version !== 'string' || !manifest.version) throw new Error('Artifact source package identity does not match the expected Lucy MCP package.');
  return { package_name: manifest.name, package_version: manifest.version, source_repository: PACKAGE_REPOSITORY };
}
function checkedTree(root, relativePath, files) {
  const absolute = join(root, relativePath);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Artifact closure rejects symbolic link: ${relativePath}`);
  if (stat.isFile()) { files.push(relativePath); return; }
  if (!stat.isDirectory()) throw new Error(`Artifact closure rejects special file: ${relativePath}`);
  for (const name of readdirSync(absolute).sort()) {
    if (relativePath === 'node_modules' && name === '.bin') continue;
    checkedTree(root, join(relativePath, name), files);
  }
}
function closureFiles(root, roots = ARTIFACT_COPY_ROOTS) {
  const files = ['package.json', 'package-lock.json'];
  for (const file of files) regular(join(root, file), `Artifact closure ${file}`);
  for (const path of roots) {
    if (!lstatSync(join(root, path), { throwIfNoEntry: false })) throw new Error(`Artifact source closure is missing ${path}.`);
    checkedTree(root, path, files);
  }
  return files.sort();
}
function closureDigest(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file); hash.update('\0'); hash.update(readFileSync(join(root, file))); hash.update('\0');
  }
  return hash.digest('hex');
}
function trackedSourceFiles(files) { return files.filter((file) => file !== 'node_modules' && !file.startsWith('node_modules/')); }
function committedTree(root, sourceGitSha) {
  // Enumerate the pinned tree itself, never a list filtered by the live checkout.
  const output = gitBytes(root, ['ls-tree', '-r', '-z', sourceGitSha, '--', 'package.json', 'package-lock.json', ...TRACKED_COPY_ROOTS], 'immutable source tree');
  const entries = new Map(); let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset); if (end < 0) throw new Error('Invalid immutable source tree output.');
    const record = output.subarray(offset, end).toString('utf8'); offset = end + 1;
    const match = /^(100(?:644|755)) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record);
    if (!match || entries.has(match[3])) throw new Error('Artifact source tree contains an unsupported entry.');
    entries.set(match[3], match[2]);
  }
  return entries;
}
function immutableBlobBytes(root, objectIds) {
  const output = gitBytes(root, ['cat-file', '--batch'], 'immutable source blobs', `${[...new Set(objectIds)].join('\n')}\n`);
  const blobs = new Map(); let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset); if (headerEnd < 0) throw new Error('Invalid immutable source blob output.');
    const header = output.subarray(offset, headerEnd).toString('utf8'); offset = headerEnd + 1;
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header); if (!match) throw new Error('Artifact source tree references a missing non-blob object.');
    const size = Number(match[2]); const contents = output.subarray(offset, offset + size);
    if (contents.length !== size || output[offset + size] !== 0x0a) throw new Error('Invalid immutable source blob content.');
    offset += size + 1; blobs.set(match[1], Buffer.from(contents));
  }
  return blobs;
}
function digestCommittedClosure(files, blobs) {
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(blobs.get(file)); hash.update('\0'); }
  return hash.digest('hex');
}
function verifyCommittedSource(root, files, sourceGitSha) {
  const liveTracked = trackedSourceFiles(files); const tree = committedTree(root, sourceGitSha); const tracked = [...tree.keys()].sort();
  if (tree.size !== liveTracked.length || tracked.some((file, index) => file !== liveTracked[index])) throw new Error('Artifact source closure must exactly match the pinned Git tree.');
  const objects = immutableBlobBytes(root, tree.values()); const blobs = new Map();
  for (const file of tracked) {
    regular(join(root, file), `Committed source input ${file}`);
    const contents = objects.get(tree.get(file)); if (!contents) throw new Error(`Artifact source lacks immutable Git blob for ${file}.`);
    if (digest(readFileSync(join(root, file))) !== digest(contents)) throw new Error(`Artifact source working bytes differ from pinned Git blob: ${file}.`);
    blobs.set(file, contents);
  }
  return { source_git_closure_digest: digestCommittedClosure(tracked, blobs), source_blobs: blobs };
}
function parseVersion(value, label) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match) throw new Error(`${label} must be a semantic version.`);
  return { text: `${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0)}`, parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] };
}
function compareVersion(left, right) { for (let index = 0; index < 3; index += 1) if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index] ? 1 : -1; return 0; }
function satisfiesRange(version, range, label) {
  if (typeof range !== 'string' || !range.trim()) throw new Error(`${label} must be a non-empty semantic-version comparator range.`);
  return range.split('||').map((part) => part.trim()).filter(Boolean).some((alternative) => alternative.split(/\s+/).every((comparator) => {
    const match = /^(<=|>=|<|>|=)?(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator);
    if (!match) throw new Error(`${label} contains unsupported comparator ${comparator}.`);
    const comparison = compareVersion(version, parseVersion(match[2], label));
    return ({ '>': comparison > 0, '>=': comparison >= 0, '<': comparison < 0, '<=': comparison <= 0, '=': comparison === 0, undefined: comparison === 0 })[match[1]];
  }));
}
function scrubbedNodeEnvironment(node) {
  return {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    HOME: '/',
    LANG: 'C',
    LC_ALL: 'C',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  };
}
function verifyNodeRuntime(node, nodeRange) {
  if ((regular(node, 'Node executable').mode & 0o111) === 0) throw new Error('Node executable must have an execute permission bit.');
  const result = spawnSync(node, ['--version'], { encoding: 'utf8', timeout: 5_000, env: scrubbedNodeEnvironment(node) });
  if (result.error || result.status !== 0) throw new Error('Node executable did not successfully run --version.');
  const verified = parseVersion(result.stdout.trim(), 'Node --version');
  if (!satisfiesRange(verified, nodeRange, 'Package Node engines')) throw new Error(`Node version ${verified.text} does not satisfy package engines ${nodeRange}.`);
  return verified.text;
}
function npmCli(node, suppliedPath) {
  const fallback = join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const path = assertAbsolute(suppliedPath ?? fallback, 'NPM CLI path');
  regular(path, 'NPM CLI');
  const result = spawnSync(node, [path, '--version'], { encoding: 'utf8', timeout: 5_000, env: scrubbedNodeEnvironment(node) });
  if (result.error || result.status !== 0) throw new Error('NPM CLI did not successfully run --version with the selected Node executable.');
  return { path, version: parseVersion(result.stdout.trim(), 'NPM CLI version').text };
}
function installLockedDependencies(root, node, suppliedNpmPath) {
  const npm = npmCli(node, suppliedNpmPath);
  const cache = assertAbsolute(process.env.npm_config_cache ?? join(process.env.HOME ?? dirname(root), '.npm'), 'NPM cache path');
  const temporary = privateDirectory(join(root, '.npm-tmp'), 'NPM temporary directory');
  let result;
  try {
    result = spawnSync(node, [npm.path, 'ci', '--ignore-scripts', '--offline', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: {
        ...scrubbedNodeEnvironment(node),
        HOME: temporary, TMPDIR: temporary,
        npm_config_cache: cache, npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
        npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_loglevel: 'error',
        npm_config_userconfig: '/dev/null',
      },
    });
  } finally {
    if (existing(temporary)) rmSync(temporary, { recursive: true, force: false });
  }
  if (result.error || result.status !== 0) throw new Error('Offline lockfile dependency installation failed; supply a selected Node distribution with its pinned packages available in the local NPM cache.');
  const files = closureFiles(root, ARTIFACT_COPY_ROOTS);
  return {
    files,
    dependency_provenance: {
      type: 'npm_ci_offline_lockfile', lockfile: 'package-lock.json', lockfile_sha256: digest(readFileSync(join(root, 'package-lock.json'))),
      closure_digest: closureDigest(root, files.filter((file) => file === 'node_modules' || file.startsWith('node_modules/'))), npm_cli_version: npm.version,
    },
  };
}
function validDependencyProvenance(value) {
  return value && value.type === 'npm_ci_offline_lockfile' && value.lockfile === 'package-lock.json'
    && /^[a-f0-9]{64}$/.test(value.lockfile_sha256 ?? '') && /^[a-f0-9]{64}$/.test(value.closure_digest ?? '')
    && typeof value.npm_cli_version === 'string' && /^\d+\.\d+\.\d+$/.test(value.npm_cli_version);
}
function runtimeCompatibility(packageManifest, node, supplied = {}, trustedHermesVersion, allowStoredHermesPolicy = false) {
  const nodeRange = packageManifest?.engines?.node;
  const keys = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? Object.keys(supplied) : null;
  if (!keys || keys.some((key) => key !== 'hermes')) throw new Error('Compatibility accepts only an optional Hermes semantic-version range.');
  const compatibility = { node: { required_range: nodeRange, verified_version: verifyNodeRuntime(node, nodeRange) } };
  if (supplied.hermes !== undefined) {
    const verified = parseVersion(trustedHermesVersion, 'Trusted Hermes host version');
    if (!satisfiesRange(verified, supplied.hermes, 'Hermes compatibility range')) throw new Error(`Hermes version ${verified.text} does not satisfy required range ${supplied.hermes}.`);
    compatibility.hermes = { required_range: supplied.hermes, verified_host_version: verified.text };
  } else if (trustedHermesVersion !== undefined && !allowStoredHermesPolicy) throw new Error('Trusted Hermes host version requires a Hermes compatibility range.');
  return compatibility;
}
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Invalid artifact compatibility metadata.');
}
function verifyReceiptCompatibility(receipt, manifest, packageManifest, trustedHermesVersion, trustedNodePath) {
  if (canonicalJson(receipt.compatibility) !== canonicalJson(manifest.compatibility)) throw new Error('Artifact receipt compatibility does not match its build manifest.');
  const nodeRange = packageManifest.engines?.node;
  if (receipt.compatibility.node.required_range !== nodeRange) throw new Error('Artifact receipt Node range does not match the verified package manifest.');
  const receiptNode = assertAbsolute(receipt.node_path, 'Artifact receipt Node executable');
  const trustedNode = assertAbsolute(trustedNodePath === undefined ? receiptNode : trustedNodePath, 'Trusted artifact Node executable');
  if (trustedNodePath !== undefined && receiptNode !== trustedNode) {
    throw new Error('Artifact receipt Node path does not match the trusted Node executable.');
  }
  const actualNodeVersion = verifyNodeRuntime(trustedNode, nodeRange);
  if (actualNodeVersion !== receipt.compatibility.node.verified_version) throw new Error('Artifact Node runtime differs from the verified receipt version.');
  if (receipt.compatibility.hermes !== undefined) {
    const hermes = receipt.compatibility.hermes;
    if (!hermes || typeof hermes.required_range !== 'string' || typeof hermes.verified_host_version !== 'string') throw new Error('Invalid artifact Hermes compatibility receipt.');
    if (trustedHermesVersion === undefined) throw new Error('Trusted Hermes host version is required for this artifact rollback.');
    const actualHermesVersion = parseVersion(trustedHermesVersion, 'Trusted Hermes host version');
    if (!satisfiesRange(actualHermesVersion, hermes.required_range, 'Hermes compatibility range')) throw new Error(`Hermes version ${actualHermesVersion.text} does not satisfy required range ${hermes.required_range}.`);
  }
}
function copyFile(from, to) {
  const contents = readFileSync(from); atomicWrite(to, contents, 'Versioned artifact file');
}
function copyClosure(root, destination, files, sourceBlobs) {
  for (const file of files) {
    const committed = sourceBlobs.get(file);
    if (committed) atomicWrite(join(destination, file), committed, 'Versioned artifact file');
    else copyFile(join(root, file), join(destination, file));
  }
}
function readReceipt(receiptPath, profilePath, trustedHermesVersion, trustedNodePath) {
  const profile = assertAbsolute(profilePath, 'profilePath');
  const receiptFile = validateContainedParent(receiptPath, profile, 'Artifact receipt');
  const receiptStat = regular(receiptFile, 'Artifact receipt');
  assertEffectiveOwner(receiptStat, 'Artifact receipt');
  if (receiptStat.nlink !== 1) throw new Error('Artifact receipt must not be hard linked.');
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')); } catch (error) { throw new Error(`Invalid artifact receipt: ${error.message}`); }
  if (!receipt || receipt.format !== 2 || !SHA.test(receipt.source_git_sha ?? '') || !/^[a-f0-9]{64}$/.test(receipt.artifact_digest ?? '')
      || !/^[a-f0-9]{64}$/.test(receipt.source_git_closure_digest ?? '') || !validDependencyProvenance(receipt.dependency_provenance)
      || receipt.package_name !== PACKAGE_NAME || typeof receipt.package_version !== 'string' || !receipt.package_version
      || receipt.source_repository !== PACKAGE_REPOSITORY || typeof receipt.path !== 'string'
      || typeof receipt.entrypoint !== 'string' || typeof receipt.node_path !== 'string' || !receipt.compatibility?.node || typeof receipt.compatibility.node.required_range !== 'string'
      || typeof receipt.compatibility.node.verified_version !== 'string') throw new Error('Invalid artifact receipt.');
  const artifactPath = assertAbsolute(receipt.path, 'Artifact path');
  assertInside(artifactPath, profile, 'Artifact path');
  validateContainedDirectory(artifactPath, profile, 'Artifact path');
  const manifestPath = join(artifactPath, 'lucy-hermes-build-manifest.json');
  const manifestStat = regular(manifestPath, 'Artifact build manifest');
  assertEffectiveOwner(manifestStat, 'Artifact build manifest');
  if (manifestStat.nlink !== 1) throw new Error('Artifact build manifest must not be hard linked.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest || manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.source_git_closure_digest ?? '') || !validDependencyProvenance(manifest.dependency_provenance)
      || manifest.artifact_digest !== receipt.artifact_digest || manifest.source_git_sha !== receipt.source_git_sha
      || manifest.source_git_closure_digest !== receipt.source_git_closure_digest || canonicalJson(manifest.dependency_provenance) !== canonicalJson(receipt.dependency_provenance)
      || manifest.package_name !== receipt.package_name || manifest.package_version !== receipt.package_version
      || manifest.source_repository !== receipt.source_repository || manifest.entrypoint !== 'src/mcp/bin.mjs') throw new Error('Artifact receipt does not match its build manifest.');
  const expectedEntrypoint = join(artifactPath, 'src/mcp/bin.mjs');
  if (receipt.entrypoint !== expectedEntrypoint) throw new Error('Artifact receipt entrypoint does not match its artifact path.');
  const files = closureFiles(artifactPath);
  if (closureDigest(artifactPath, files) !== receipt.artifact_digest) throw new Error('Versioned artifact digest mismatch.');
  regular(expectedEntrypoint, 'Versioned artifact entrypoint');
  regular(join(artifactPath, 'package.json'), 'Versioned artifact package manifest');
  let packageManifest;
  try { packageManifest = JSON.parse(readFileSync(join(artifactPath, 'package.json'), 'utf8')); } catch (error) { throw new Error(`Invalid verified artifact package manifest: ${error.message}`); }
  const packageIdentity = packageProvenance(packageManifest);
  if (packageIdentity.package_name !== receipt.package_name || packageIdentity.package_version !== receipt.package_version || packageIdentity.source_repository !== receipt.source_repository) throw new Error('Artifact receipt package metadata does not match its verified package manifest.');
  verifyReceiptCompatibility(receipt, manifest, packageManifest, trustedHermesVersion, trustedNodePath);
  const trustedNode = trustedNodePath === undefined
    ? assertAbsolute(receipt.node_path, 'Artifact receipt Node executable')
    : assertAbsolute(trustedNodePath, 'Trusted artifact Node executable');
  return { ...receipt, path: artifactPath, node_path: trustedNode };
}

function existing(path) { return lstatSync(path, { throwIfNoEntry: false }); }
function acquirePublicationLock(profile) {
  const state = privateDirectory(join(profile, '.lucy-memory'), 'Artifact state directory');
  return acquireHermesAdvisoryLock(
    state,
    '.installer.lock',
    'Artifact publication lock',
    'Another artifact publication is active for this isolated profile.',
  );
}
function reclaimAbandonedStaging(staging, profile) {
  for (const name of readdirSync(staging).sort()) {
    if (!/^\.build-[a-f0-9]{32}$/.test(name)) continue;
    const candidate = join(staging, name);
    validateContainedDirectory(candidate, profile, 'Abandoned artifact staging build');
    rmSync(candidate, { recursive: true, force: false });
  }
  syncDirectory(staging);
}
function discardIncompletePublication(artifactRoot, receiptPath, profile) {
  const artifact = existing(artifactRoot); const receipt = existing(receiptPath);
  if (!artifact && !receipt) return;
  if (artifact) { validateContainedDirectory(artifactRoot, profile, 'Incomplete artifact'); rmSync(artifactRoot, { recursive: true, force: false }); }
  if (receipt) { validateContainedParent(receiptPath, profile, 'Incomplete artifact receipt'); regular(receiptPath, 'Incomplete artifact receipt'); rmSync(receiptPath); }
  syncDirectory(dirname(artifactRoot)); syncDirectory(dirname(receiptPath));
}

export function installHermesLucyArtifact(profilePath, { sourcePath, nodePath, npmPath, version, expectedSourceGitSha, compatibility = {}, trustedHermesVersion } = {}) {
  const profile = privateProfile(profilePath);
  const source = assertAbsolute(sourcePath, 'Artifact source');
  const node = assertAbsolute(nodePath, 'Node executable');
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Artifact version must be a simple version identifier.');
  const sourceStat = regular(source, 'Artifact source');
  assertEffectiveOwner(sourceStat, 'Artifact source');
  if (sourceStat.nlink !== 1) throw new Error('Artifact source must not be hard linked.');
  const root = packageRoot(source);
  validateSafeDirectoryChain(root, 'Artifact source package', { requireLeafOwner: true });
  const identity = provenance(root, expectedSourceGitSha); const sourceFiles = closureFiles(root, SOURCE_COPY_ROOTS);
  const { source_blobs: sourceBlobs, ...sourceProvenance } = verifyCommittedSource(root, sourceFiles, identity.source_git_sha);
  const verifiedPackageManifest = JSON.parse(sourceBlobs.get('package.json').toString('utf8'));
  const packageIdentity = packageProvenance(verifiedPackageManifest);
  verifyNodeRuntime(node, verifiedPackageManifest.engines?.node);
  const artifacts = privateDirectory(join(profile, '.lucy-memory', 'artifacts'), 'Artifact directory');
  const receipts = privateDirectory(join(profile, '.lucy-memory', 'receipts'), 'Artifact receipt directory');
  const staging = privateDirectory(join(profile, '.lucy-memory', 'staging'), 'Artifact staging directory');
  const releaseLock = acquirePublicationLock(profile);
  let stage; let artifactRoot; let receiptPath; let published = false;
  try {
    releaseLock.assertHeld();
    reclaimAbandonedStaging(staging, profile);
    stage = privateDirectory(join(staging, `.build-${randomBytes(16).toString('hex')}`), 'Artifact staging build');
    copyClosure(root, stage, sourceFiles, sourceBlobs);
    const { files, dependency_provenance: dependencyProvenance } = installLockedDependencies(stage, node, npmPath);
    const artifactDigest = closureDigest(stage, files);
    artifactRoot = join(artifacts, `${version}-${artifactDigest.slice(0, 16)}`);
    receiptPath = join(receipts, `${version}-${artifactDigest.slice(0, 16)}.json`);
    const artifactExists = Boolean(existing(artifactRoot)); const receiptExists = Boolean(existing(receiptPath));
    if (artifactExists !== receiptExists) {
      releaseLock.assertHeld();
      discardIncompletePublication(artifactRoot, receiptPath, profile);
    }
    const cachedArtifact = artifactExists && receiptExists;
    if (cachedArtifact && (compatibility?.hermes === undefined || trustedHermesVersion === undefined)) {
      throw new Error('Cached artifact reuse requires an explicit trusted Hermes compatibility policy.');
    }
    const enforcedCompatibility = runtimeCompatibility(verifiedPackageManifest, node, compatibility, trustedHermesVersion);
    const entryPath = join(artifactRoot, 'src/mcp/bin.mjs');
    const buildManifest = { format: 1, ...identity, ...packageIdentity, ...sourceProvenance, dependency_provenance: dependencyProvenance, artifact_digest: artifactDigest, compatibility: enforcedCompatibility, entrypoint: 'src/mcp/bin.mjs' };
    if (cachedArtifact) {
      const receipt = readReceipt(receiptPath, profile, trustedHermesVersion, node);
      if (receipt.artifact_digest !== artifactDigest || receipt.node_path !== node || receipt.source_git_closure_digest !== sourceProvenance.source_git_closure_digest
          || canonicalJson(receipt.dependency_provenance) !== canonicalJson(dependencyProvenance)) throw new Error('Existing artifact receipt conflicts with requested artifact.');
      if (compatibility?.hermes !== undefined && receipt.compatibility.hermes?.required_range !== compatibility.hermes) throw new Error('Existing artifact receipt conflicts with requested compatibility.');
      releaseLock.assertHeld();
      rmSync(stage, { recursive: true, force: false });
      return { ...receipt, receiptPath };
    }
    if (closureDigest(stage, files) !== artifactDigest
        || closureDigest(stage, trackedSourceFiles(files)) !== sourceProvenance.source_git_closure_digest
        || closureDigest(stage, files.filter((file) => file === 'node_modules' || file.startsWith('node_modules/'))) !== dependencyProvenance.closure_digest) {
      throw new Error('Staged artifact bytes do not match the immutable source and lockfile-built dependency closures.');
    }
    atomicWrite(join(stage, 'lucy-hermes-build-manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`, 'Artifact build manifest');
    releaseLock.assertHeld();
    renameSync(stage, artifactRoot); published = true; syncDirectory(artifacts);
    const receipt = { ...buildManifest, format: 2, version, path: artifactRoot, entrypoint: entryPath, node_path: node, created_at: new Date().toISOString() };
    releaseLock.assertHeld();
    atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'Artifact receipt');
    return { ...receipt, receiptPath };
  } catch (error) {
    // Never perform recovery writes after the lock pathname or descriptor
    // identity has changed. A later verified lease can reclaim the contained
    // staging/incomplete publication safely.
    releaseLock.assertHeld();
    if (published) discardIncompletePublication(artifactRoot, receiptPath, profile);
    else if (stage && existing(stage)) rmSync(stage, { recursive: true, force: false });
    throw error;
  } finally {
    releaseLock();
  }
}

function verifyArtifactAgainstTrustedSource(receipt, profilePath, sourcePath, expectedSourceGitSha, trustedNodePath) {
  const profile = assertAbsolute(profilePath, 'profilePath');
  const trustedNode = assertAbsolute(trustedNodePath, 'Trusted rollback Node executable');
  const source = assertAbsolute(sourcePath, 'Artifact source'); regular(source, 'Artifact source');
  const root = packageRoot(source); const identity = provenance(root, expectedSourceGitSha);
  if (receipt.source_git_sha !== identity.source_git_sha) throw new Error('Artifact receipt source Git SHA does not match the trusted rollback pin.');
  const files = closureFiles(root, SOURCE_COPY_ROOTS);
  const { source_blobs: trustedBlobs, source_git_closure_digest: trustedDigest } = verifyCommittedSource(root, files, identity.source_git_sha);
  if (trustedDigest !== receipt.source_git_closure_digest) throw new Error('Artifact receipt source closure does not match the trusted rollback source.');
  const trustedPackage = packageProvenance(JSON.parse(trustedBlobs.get('package.json').toString('utf8')));
  if (trustedPackage.package_name !== receipt.package_name || trustedPackage.package_version !== receipt.package_version || trustedPackage.source_repository !== receipt.source_repository) throw new Error('Artifact receipt package metadata does not match the trusted rollback source.');
  for (const [file, contents] of trustedBlobs) {
    const artifactFile = join(receipt.path, file); regular(artifactFile, `Trusted artifact source ${file}`);
    if (!readFileSync(artifactFile).equals(contents)) throw new Error(`Artifact source bytes do not match the trusted rollback source: ${file}.`);
  }
  const verificationRoot = privateDirectory(join(profile, '.lucy-memory', 'rollback-verification'), 'Rollback dependency verification directory');
  const verification = privateDirectory(join(verificationRoot, `.verify-${randomBytes(16).toString('hex')}`), 'Rollback dependency verification build');
  try {
    for (const [file, contents] of trustedBlobs) atomicWrite(join(verification, file), contents, 'Trusted rollback source file');
    const { files: rebuiltFiles, dependency_provenance: rebuilt } = installLockedDependencies(verification, trustedNode);
    const rebuiltDependencies = rebuiltFiles.filter((file) => file === 'node_modules' || file.startsWith('node_modules/'));
    const artifactDependencies = closureFiles(receipt.path).filter((file) => file === 'node_modules' || file.startsWith('node_modules/'));
    if (rebuilt.lockfile_sha256 !== digest(trustedBlobs.get('package-lock.json'))
        || receipt.dependency_provenance.lockfile_sha256 !== rebuilt.lockfile_sha256
        || receipt.dependency_provenance.closure_digest !== rebuilt.closure_digest
        || closureDigest(receipt.path, artifactDependencies) !== rebuilt.closure_digest
        || closureDigest(verification, rebuiltDependencies) !== rebuilt.closure_digest) {
      throw new Error('Artifact dependency closure does not match the trusted offline lockfile rebuild.');
    }
  } finally {
    if (existing(verification)) rmSync(verification, { recursive: true, force: false });
  }
}

export function verifyHermesLucyArtifact(receiptPath, profilePath, trustedHermesVersion, trustedNodePath) { return readReceipt(receiptPath, assertAbsolute(profilePath, 'profilePath'), trustedHermesVersion, trustedNodePath); }
export function verifyHermesLucyArtifactAgainstSource(receiptPath, profilePath, { sourcePath, expectedSourceGitSha, trustedHermesVersion, trustedNodePath } = {}) {
  const profile = assertAbsolute(profilePath, 'profilePath');
  if (typeof trustedNodePath !== 'string' || !trustedNodePath) throw new Error('Trusted rollback Node executable is required.');
  const receipt = readReceipt(receiptPath, profile, trustedHermesVersion, trustedNodePath);
  verifyArtifactAgainstTrustedSource(receipt, profile, sourcePath, expectedSourceGitSha, trustedNodePath);
  return receipt;
}
