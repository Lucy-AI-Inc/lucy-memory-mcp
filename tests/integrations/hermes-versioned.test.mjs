import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { acquireHermesAdvisoryLock } from '../../src/integrations/hermes-advisory-lock.mjs';
import {
  hermesLucyStatus,
  installHermesLucyConfig,
  installHermesLucyArtifact,
  lucyMcpConfig,
  rollbackHermesLucyConfig,
  updateHermesLucyConfig,
} from '../../src/integrations/hermes.mjs';
import { cleanHermesSource, cleanHermesSourceGitSha } from '../helpers/hermes-clean-source.mjs';
import YAML from 'yaml';

const NODE = process.execPath;
const NPM = join(dirname(NODE), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const TRUSTED_HERMES_VERSION = '2026.9.10';
const HERMES_COMPATIBILITY = '>=2026.9.0 <2027.0.0';
const options = (sourcePath, version = '1.0.0') => ({
  profilePath: undefined,
  artifact: { sourcePath, nodePath: NODE, npmPath: NPM, version, expectedSourceGitSha: cleanHermesSourceGitSha(), compatibility: { hermes: HERMES_COMPATIBILITY }, trustedHermesVersion: TRUSTED_HERMES_VERSION },
  baseUrl: 'https://memory.example.test',
  tokenEnv: 'LUCY_MEMORY_TOKEN',
});
const sourceTree = (sourcePath) => execFileSync('git', ['-C', dirname(sourcePath), 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();

async function holdKernelLock(t, lockPath) {
  const program = `
    import { closeSync, constants, openSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const fd = openSync(process.env.HERMES_TEST_LOCK_PATH, constants.O_RDWR | constants.O_CREAT, 0o600);
    const locked = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    if (locked.error || locked.status !== 0) { closeSync(fd); process.exit(73); }
    process.stdout.write('ready');
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(NODE, ['--input-type=module', '--eval', program], {
    env: { HERMES_TEST_LOCK_PATH: lockPath },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lock holder exited before readiness: ${code}`)));
    child.stdout.once('data', (data) => data.toString() === 'ready' ? resolve() : reject(new Error('lock holder did not attest readiness')));
  });
  t.after(() => { try { child.kill('SIGTERM'); } catch { /* already exited */ } });
  return child;
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-hermes-versioned-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile');
  mkdirSync(profilePath, { mode: 0o700 });
  const configPath = join(profilePath, 'config.yaml');
  return { dir, profilePath, configPath, sourcePath: cleanHermesSource() };
}

function mode(path) { return lstatSync(path).mode & 0o777; }
function artifactPath(profilePath, version, artifactDigest) { return join(profilePath, '.lucy-memory', 'artifacts', `${version}-${artifactDigest.slice(0, 16)}`); }
function receiptPath(profilePath, version, artifactDigest) { return join(profilePath, '.lucy-memory', 'receipts', `${version}-${artifactDigest.slice(0, 16)}.json`); }
function artifactClosure(root, dependencyOnly = false) {
  const files = dependencyOnly ? [] : ['package.json', 'package-lock.json'];
  const visit = (relative) => {
    const stat = lstatSync(join(root, relative));
    if (stat.isFile()) { files.push(relative); return; }
    assert.equal(stat.isDirectory(), true, `fixture artifact entry must be a directory or file: ${relative}`);
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (relative === 'node_modules' && name === '.bin') continue;
      visit(join(relative, name));
    }
  };
  for (const rootPath of dependencyOnly ? ['node_modules'] : ['src', 'schemas', 'contracts', 'scripts/lib', 'node_modules']) visit(rootPath);
  const hash = createHash('sha256');
  for (const file of files.sort()) { hash.update(file); hash.update('\0'); hash.update(readFileSync(join(root, file))); hash.update('\0'); }
  return { digest: hash.digest('hex'), files };
}
function forgeMutableArtifactMetadata(receiptPath) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const manifestPath = join(receipt.path, 'lucy-hermes-build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const artifact = artifactClosure(receipt.path); const dependencies = artifactClosure(receipt.path, true);
  receipt.artifact_digest = artifact.digest; manifest.artifact_digest = artifact.digest;
  receipt.dependency_provenance.closure_digest = dependencies.digest;
  manifest.dependency_provenance.closure_digest = dependencies.digest;
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return { receipt, dependencyFiles: dependencies.files };
}

function injectArtifactPublicationFailure({ configPath, artifactRoot, receipt, updateOptions, stage }) {
  // A separate Node process keeps the builtin-FS mutation isolated from this test worker.
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.renameSync;
    const stage = process.env.HERMES_FAULT_STAGE;
    const artifactRoot = process.env.HERMES_ARTIFACT_ROOT;
    const receiptPath = process.env.HERMES_RECEIPT_PATH;
    let interrupted = false;
    let artifactRootExistedAtFault = false;
    fs.renameSync = (from, to) => {
      const destination = String(to);
      const copy = destination.endsWith('/package-lock.json');
      const manifest = destination.endsWith('/lucy-hermes-build-manifest.json');
      const receipt = destination === receiptPath;
      if (!interrupted && ((stage === 'copy' && copy) || (stage === 'manifest' && manifest) || (stage === 'receipt' && receipt))) {
        interrupted = true; artifactRootExistedAtFault = fs.existsSync(artifactRoot);
        const error = new Error('injected ' + stage + ' publication interruption'); error.code = 'EIO'; throw error;
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try {
      const { updateHermesLucyConfig } = await import(process.env.HERMES_MODULE_URL);
      updateHermesLucyConfig(process.env.HERMES_CONFIG_PATH, JSON.parse(process.env.HERMES_UPDATE_OPTIONS));
      process.stdout.write(JSON.stringify({ interrupted, unexpectedlySucceeded: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ interrupted, message: error.message, artifactRootExisted: artifactRootExistedAtFault }));
    } finally {
      fs.renameSync = originalRename; syncBuiltinESMExports();
    }
  `;
  return JSON.parse(execFileSync(NODE, ['--input-type=module', '--eval', program], {
    encoding: 'utf8', env: {
      ...process.env,
      HERMES_ARTIFACT_ROOT: artifactRoot,
      HERMES_CONFIG_PATH: configPath,
      HERMES_FAULT_STAGE: stage,
      HERMES_MODULE_URL: new URL('../../src/integrations/hermes.mjs', import.meta.url).href,
      HERMES_RECEIPT_PATH: receipt,
      HERMES_UPDATE_OPTIONS: JSON.stringify(updateOptions),
    },
  }));
}

test('installs real YAML without raw secrets and preserves comments/unrelated values', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  writeFileSync(configPath, '# existing comment\ntheme: dark\nmcp_servers:\n  other:\n    command: keep-me\n');
  const result = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const status = hermesLucyStatus(configPath);
  const text = readFileSync(configPath, 'utf8');
  assert.deepEqual({
    digest: status.artifact,
    version: result.artifact.version,
    source: result.artifact.source_git_sha,
    node: result.artifact.node_path,
  }, {
    digest: result.artifact.artifact_digest,
    version: '1.0.0',
    source: cleanHermesSourceGitSha(),
    node: NODE,
  });
  assert.match(text, /# existing comment/);
  assert.match(text, /theme: dark/);
  assert.match(text, /command: keep-me/);
  assert.match(text, /LUCY_MEMORY_TOKEN: \$\{LUCY_MEMORY_TOKEN\}/);
  assert.doesNotMatch(text, /Raw token values/);
  assert.equal(lstatSync(profilePath).mode & 0o777, 0o700);
  assert.equal(lstatSync(configPath).mode & 0o777, 0o600);
  assert.ok(result.artifact.receiptPath.startsWith(profilePath + '/'));
  assert.equal(lstatSync(result.artifact.path).mode & 0o777, 0o700);
  assert.equal(lstatSync(result.artifact.entrypoint).mode & 0o777, 0o600);
});

test('rejects a valid Git tree object where a source commit pin is required', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  const tree = sourceTree(sourcePath);
  assert.equal(execFileSync('git', ['-C', dirname(sourcePath), 'cat-file', '-t', tree], { encoding: 'utf8' }).trim(), 'tree');
  assert.throws(() => installHermesLucyConfig(configPath, {
    ...options(sourcePath), profilePath, artifact: { ...options(sourcePath).artifact, expectedSourceGitSha: tree },
  }), /expectedSourceGitSha must resolve to a full commit ID/);
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  assert.throws(() => rollbackHermesLucyConfig(configPath, {
    profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: tree,
    trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION,
  }), /expectedSourceGitSha must resolve to a full commit ID/);
});

test('versioned update and rollback retain prior config if publication fails', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath, dir } = fixture(t);
  const first = installHermesLucyConfig(configPath, { ...options(sourcePath, '1.0.0'), profilePath });
  const before = readFileSync(configPath, 'utf8');
  const second = updateHermesLucyConfig(configPath, { ...options(sourcePath, '2.0.0'), profilePath });
  assert.equal(first.artifact.artifact_digest, second.artifact.artifact_digest);
  assert.match(readFileSync(configPath, 'utf8'), /2\.0\.0/);
  assert.throws(() => updateHermesLucyConfig(configPath, {
    ...options(join(dir, 'missing.mjs'), '3.0.0'), profilePath,
  }));
  assert.match(readFileSync(configPath, 'utf8'), /2\.0\.0/);
  const rollback = rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: first.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha(), trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION });
  assert.equal(rollback.artifact.artifact_digest, first.artifact.artifact_digest);
  assert.equal(rollback.artifact.receiptPath, first.artifact.receiptPath);
  assert.equal(rollback.artifact.entrypoint, first.artifact.entrypoint);
  assert.equal(rollback.artifact.source_git_sha, first.artifact.source_git_sha);
  assert.match(readFileSync(configPath, 'utf8'), /1\.0\.0/);
  assert.doesNotMatch(before, /2\.0\.0/);
});

test('interrupted artifact copy and publication remove every partial artifact without touching prior config state', { skip: process.platform !== 'linux' }, (t) => {
  for (const stage of ['copy', 'manifest', 'receipt']) {
    const { dir, profilePath, configPath, sourcePath } = fixture(t);
    writeFileSync(configPath, 'theme: stable\n', { mode: 0o640 }); chmodSync(configPath, 0o640);
    const first = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
    const backupPath = configPath + '.lucy-memory.bak';
    const outside = join(dir, `outside-${stage}.txt`); writeFileSync(outside, `outside ${stage}\n`, { mode: 0o644 }); chmodSync(outside, 0o644);
    const before = {
      backupBytes: readFileSync(backupPath, 'utf8'), backupMode: mode(backupPath), configBytes: readFileSync(configPath, 'utf8'), configMode: mode(configPath),
      outsideBytes: readFileSync(outside, 'utf8'), outsideMode: mode(outside),
    };
    const version = `fault-${stage}`;
    const destinationArtifact = artifactPath(profilePath, version, first.artifact.artifact_digest);
    const destinationReceipt = receiptPath(profilePath, version, first.artifact.artifact_digest);
    const result = injectArtifactPublicationFailure({
      configPath, artifactRoot: destinationArtifact, receipt: destinationReceipt,
      updateOptions: { ...options(sourcePath, version), profilePath }, stage,
    });
    assert.equal(result.interrupted, true, `${stage} injection reached its destination-scoped publish operation`);
    assert.equal(result.artifactRootExisted, stage === 'receipt', `${stage} either stays in private staging or faults after final publication`);
    assert.match(result.message, new RegExp(`injected ${stage} publication interruption`));
    assert.equal(readFileSync(configPath, 'utf8'), before.configBytes); assert.equal(mode(configPath), before.configMode);
    assert.equal(readFileSync(backupPath, 'utf8'), before.backupBytes); assert.equal(mode(backupPath), before.backupMode);
    assert.equal(readFileSync(outside, 'utf8'), before.outsideBytes); assert.equal(mode(outside), before.outsideMode);
    assert.equal(existsSync(destinationArtifact), false, `${stage} failure removes its artifact root`);
    assert.equal(existsSync(destinationReceipt), false, `${stage} failure leaves no final receipt`);
    assert.deepEqual(readdirSync(join(profilePath, '.lucy-memory'), { recursive: true }).filter((name) => String(name).endsWith('.tmp')), [], `${stage} failure leaves no temporary publication file`);
  }
});

test('a contained artifact left without its receipt is discarded and rebuilt on the same retry', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t);
  const artifactOptions = options(sourcePath, 'orphan-retry').artifact;
  const first = installHermesLucyArtifact(profilePath, artifactOptions);
  const marker = join(first.path, 'incomplete-publication-marker');
  writeFileSync(marker, 'must not survive recovery\n');
  rmSync(first.receiptPath);
  const recovered = installHermesLucyArtifact(profilePath, artifactOptions);
  assert.equal(recovered.path, first.path);
  assert.equal(existsSync(recovered.receiptPath), true);
  assert.equal(existsSync(marker), false, 'retry removed the contained incomplete cache before rebuilding it');
});

test('cached artifact verification never executes a receipt-selected Node path', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, sourcePath } = fixture(t);
  const marker = join(dir, 'receipt-node-executed');
  const receiptNode = join(dir, 'receipt-node');
  writeFileSync(receiptNode, `#!/bin/sh\nprintf executed > ${marker}\nexec ${NODE} "$@"\n`, { mode: 0o700 }); chmodSync(receiptNode, 0o700);
  const artifactOptions = options(sourcePath, 'cached-node-authority').artifact;
  const installed = installHermesLucyArtifact(profilePath, artifactOptions);
  const receipt = JSON.parse(readFileSync(installed.receiptPath, 'utf8'));
  receipt.node_path = receiptNode;
  writeFileSync(installed.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => installHermesLucyArtifact(profilePath, artifactOptions), /conflicts with requested artifact|does not match the trusted Node executable/);
  assert.equal(existsSync(marker), false, 'cache verification must execute only the caller-selected Node path');
});

test('cached artifact reuse requires an external Hermes policy and rejects stripped matching metadata', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t);
  const artifactOptions = options(sourcePath, 'cached-hermes-policy').artifact;
  const installed = installHermesLucyArtifact(profilePath, artifactOptions);
  const receipt = JSON.parse(readFileSync(installed.receiptPath, 'utf8'));
  const manifestPath = join(installed.path, 'lucy-hermes-build-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete receipt.compatibility.hermes; delete manifest.compatibility.hermes;
  writeFileSync(installed.receiptPath, `${JSON.stringify(receipt)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(() => installHermesLucyArtifact(profilePath, { ...artifactOptions, compatibility: {}, trustedHermesVersion: undefined }), /Cached artifact reuse requires an explicit trusted Hermes compatibility policy/);
  assert.throws(() => installHermesLucyArtifact(profilePath, artifactOptions), /conflicts with requested compatibility/);
});

test('reclaims a dead-owner staging build under a kernel-held publication lease', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t);
  const state = join(profilePath, '.lucy-memory'); const staging = join(state, 'staging');
  const orphan = join(staging, `.build-${'a'.repeat(32)}`); mkdirSync(orphan, { recursive: true, mode: 0o700 }); writeFileSync(join(orphan, 'partial'), 'incomplete\n');
  const lock = join(state, '.installer.lock'); writeFileSync(lock, JSON.stringify({ pid: 999999 }) + '\n', { mode: 0o600 });
  const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'staging-recovery').artifact);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(lock), true, 'the persistent advisory-lock pathname is never reclaimed by unlink');
  assert.equal(existsSync(artifact.receiptPath), true);
});

test('uses a persistent regular artifact lock file even with torn legacy contents', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t); const state = join(profilePath, '.lucy-memory'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, '.installer.lock'); writeFileSync(lock, '', { mode: 0o600 });
  const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'torn-lock').artifact);
  assert.equal(existsSync(lock), true); assert.equal(mode(lock), 0o600); assert.equal(existsSync(artifact.receiptPath), true);
});

test('rejects a broad existing profile before changing its permissions or children', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, sourcePath } = fixture(t); const shared = join(dir, 'shared-profile'); mkdirSync(shared, { mode: 0o755 }); chmodSync(shared, 0o755);
  assert.throws(() => installHermesLucyArtifact(shared, options(sourcePath, 'broad-profile').artifact), /already be private/);
  assert.equal(mode(shared), 0o755); assert.deepEqual(readdirSync(shared), []);
});

test('rejects a config path equal to the profile before changing its parent or state', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, sourcePath } = fixture(t); chmodSync(dir, 0o755);
  assert.throws(() => installHermesLucyConfig(profilePath, { ...options(sourcePath), profilePath }), /file inside the isolated profile/);
  assert.equal(mode(dir), 0o755); assert.equal(existsSync(join(profilePath, '.lucy-memory')), false);
});

test('an empty ambient PATH cannot disable or redirect trusted flock', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, sourcePath } = fixture(t);
  const profilePath = join(dir, 'uncreated-profile');
  const installOptions = { ...options(sourcePath), profilePath };
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const installed = installHermesLucyConfig(join(profilePath, 'config.yaml'), installOptions);
    assert.ok(installed.artifact.receiptPath.startsWith(profilePath + '/'));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(existsSync(profilePath), true);
});

test('a PATH-injected fake flock is never executed', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, sourcePath } = fixture(t);
  const profilePath = join(dir, 'uncreated-false-positive-profile');
  const tools = join(dir, 'fake-tools'); mkdirSync(tools, { mode: 0o700 });
  const fakeFlock = join(tools, 'flock');
  const invoked = join(dir, 'fake-flock-invoked');
  writeFileSync(fakeFlock, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invoked)}\nexit 73\n`, { mode: 0o700 });
  chmodSync(fakeFlock, 0o700);
  const installOptions = { ...options(sourcePath), profilePath };
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = tools;
    const installed = installHermesLucyConfig(join(profilePath, 'config.yaml'), installOptions);
    assert.ok(installed.artifact.receiptPath.startsWith(profilePath + '/'));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(existsSync(invoked), false);
});

test('a PATH-injected fake git is never executed for artifact provenance', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, sourcePath } = fixture(t);
  const artifactOptions = options(sourcePath, 'trusted-git-path').artifact;
  const tools = join(dir, 'fake-git-tools'); mkdirSync(tools, { mode: 0o700 });
  const invoked = join(dir, 'fake-git-invoked');
  const fakeGit = join(tools, 'git');
  writeFileSync(fakeGit, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invoked)}\nexit 73\n`, { mode: 0o700 });
  chmodSync(fakeGit, 0o700);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = tools;
    const artifact = installHermesLucyArtifact(profilePath, artifactOptions);
    assert.ok(artifact.receiptPath.startsWith(profilePath + '/'));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  assert.equal(existsSync(invoked), false);
});

test('ambient Node preload options are ignored by runtime and npm probes', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, sourcePath } = fixture(t);
  const invoked = join(dir, 'node-options-invoked');
  const preload = join(dir, 'ambient-preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(invoked)}, 'invoked')\n`, { mode: 0o600 });
  const previousNodeOptions = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--require ${preload}`;
    const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'scrubbed-node-env').artifact);
    assert.ok(artifact.receiptPath.startsWith(profilePath + '/'));
  } finally {
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
  assert.equal(existsSync(invoked), false);
});

test('unrelated exclusive /dev/null holders cannot make the flock support probe fail', { skip: process.platform !== 'linux' }, async (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  writeFileSync(configPath, 'theme: shared-null\n');
  await holdKernelLock(t, '/dev/null');
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath, 'devnull-contention'), profilePath });
  assert.ok(installed.artifact.receiptPath.startsWith(profilePath + '/'));
  assert.match(readFileSync(configPath, 'utf8'), /lucy-memory/);
});

test('independent profiles can mutate concurrently under separate advisory leases', { skip: process.platform !== 'linux' }, async (t) => {
  const { dir, sourcePath } = fixture(t);
  const left = join(dir, 'left'); const right = join(dir, 'right');
  mkdirSync(left, { mode: 0o700 }); mkdirSync(right, { mode: 0o700 });
  const leftConfig = join(left, 'config.yaml'); const rightConfig = join(right, 'config.yaml');
  writeFileSync(leftConfig, 'theme: left\n'); writeFileSync(rightConfig, 'theme: right\n');
  const moduleUrl = new URL('../../src/integrations/hermes.mjs', import.meta.url).href;
  const run = (profilePath, version) => new Promise((resolve, reject) => {
    const configPath = join(profilePath, 'config.yaml');
    const program = `
      const { installHermesLucyConfig } = await import(${JSON.stringify(moduleUrl)});
      const result = installHermesLucyConfig(process.env.HERMES_CONFIG_PATH, JSON.parse(process.env.HERMES_OPTIONS));
      process.stdout.write(JSON.stringify({ ok: true, receipt: result.artifact.receiptPath }));
    `;
    const child = spawn(NODE, ['--input-type=module', '--eval', program], {
      env: {
        ...process.env,
        HERMES_CONFIG_PATH: configPath,
        HERMES_OPTIONS: JSON.stringify({ ...options(sourcePath, version), profilePath }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`concurrent installer exited ${code}: ${stderr || stdout}`));
      else resolve(JSON.parse(stdout));
    });
  });
  const results = await Promise.all([run(left, 'concurrent-0'), run(right, 'concurrent-1')]);
  assert.equal(results[0].ok, true); assert.equal(results[1].ok, true);
  assert.ok(results[0].receipt.startsWith(left + '/'));
  assert.ok(results[1].receipt.startsWith(right + '/'));
  assert.match(readFileSync(leftConfig, 'utf8'), /lucy-memory/);
  assert.match(readFileSync(rightConfig, 'utf8'), /lucy-memory/);
});

test('an incompatible PATH-injected flock cannot influence the isolated probe', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, sourcePath } = fixture(t);
  const profilePath = join(dir, 'uncreated-incompatible-protocol-profile');
  const tools = join(dir, 'incompatible-tools'); mkdirSync(tools, { mode: 0o700 });
  const fakeFlock = join(tools, 'flock');
  // Advertise util-linux identity, but reject the exclusive nonblock protocol used by the isolated probe.
  writeFileSync(fakeFlock, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' 'flock from util-linux 99.0'; exit 0; fi
# Accept only --version; any lock protocol attempt fails closed.
exit 41
`, { mode: 0o700 });
  chmodSync(fakeFlock, 0o700);
  const probeTmpdir = join(dir, 'isolated-flock-probe-tmp'); mkdirSync(probeTmpdir, { mode: 0o700 });
  const beforeProbe = new Set(readdirSync(probeTmpdir).filter((name) => String(name).startsWith('lucy-hermes-flock-probe-')));
  const installOptions = { ...options(sourcePath), profilePath };
  const previousPath = process.env.PATH;
  const previousTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = probeTmpdir;
    process.env.PATH = tools;
    const installed = installHermesLucyConfig(join(profilePath, 'config.yaml'), installOptions);
    assert.ok(installed.artifact.receiptPath.startsWith(profilePath + '/'));
    const afterProbe = readdirSync(probeTmpdir).filter((name) => String(name).startsWith('lucy-hermes-flock-probe-'));
    assert.deepEqual(afterProbe.filter((name) => !beforeProbe.has(name)), [], 'failed probes must clean up owned temporary probe resources');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
});

test('a live kernel config lease prevents a competing first install from changing config or backup', { skip: process.platform !== 'linux' }, async (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t); writeFileSync(configPath, 'theme: stable\n');
  const state = join(profilePath, '.lucy-memory'); mkdirSync(state, { recursive: true, mode: 0o700 });
  await holdKernelLock(t, join(state, '.config.lock'));
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /Another Hermes config update is active/);
  assert.equal(readFileSync(configPath, 'utf8'), 'theme: stable\n'); assert.equal(existsSync(configPath + '.lucy-memory.bak'), false);
});

test('legacy PID-reuse and stale-recovery records cannot block a kernel lease', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t); writeFileSync(configPath, 'theme: stale\n');
  const state = join(profilePath, '.lucy-memory'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, '.config.lock'); writeFileSync(lock, `${JSON.stringify({ pid: process.pid, pid_start_time: '0' })}\n`, { mode: 0o600 });
  const legacyRecovery = join(state, '.config.recovery.lock'); writeFileSync(legacyRecovery, `${JSON.stringify({ pid: 999999 })}\n`, { mode: 0o600 });
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath, 'config-lock-recovery'), profilePath });
  assert.equal(existsSync(lock), true); assert.equal(existsSync(legacyRecovery), true);
  assert.ok(installed.artifact.receiptPath.startsWith(profilePath + '/'));
});

test('a crashed kernel artifact lease is released without stale-path recovery', { skip: process.platform !== 'linux' }, async (t) => {
  const { profilePath, sourcePath } = fixture(t); const state = join(profilePath, '.lucy-memory'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const holder = await holdKernelLock(t, join(state, '.installer.lock'));
  holder.kill('SIGKILL'); await waitForExit(holder);
  const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'artifact-crash-recovery').artifact);
  assert.equal(existsSync(join(state, '.installer.lock')), true); assert.equal(existsSync(artifact.receiptPath), true);
});

test('releasing a config lease does not unlink a pathname replacement', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath } = fixture(t); const state = join(profilePath, '.lucy-memory'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, '.config.lock'); const release = acquireHermesAdvisoryLock(state, '.config.lock', 'test config lock', 'active');
  const displaced = join(state, '.config.lock.displaced');
  fs.renameSync(lock, displaced); writeFileSync(lock, 'external replacement\n', { mode: 0o600 });
  release();
  assert.equal(readFileSync(lock, 'utf8'), 'external replacement\n'); assert.equal(existsSync(displaced), true);
});

test('lucyMcpConfig rejects incomplete artifacts before emitting an invalid JavaScript configuration', () => {
  assert.throws(() => lucyMcpConfig({
    baseUrl: 'https://memory.example.test', tokenEnv: 'LUCY_MEMORY_TOKEN', artifact: { path: '/tmp/closure', node_path: NODE },
  }), /complete versioned artifact/);
});

test('artifact dependencies come from the immutable lockfile build, not arbitrary source node_modules bytes', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t);
  const sourceRoot = join(sourcePath, '../../..');
  const marker = join(sourceRoot, 'node_modules', 'lucy-untrusted-source-marker.js');
  writeFileSync(marker, 'untrusted source dependency bytes\n');
  try {
    const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'locked-deps').artifact);
    assert.equal(existsSync(join(artifact.path, 'node_modules', 'lucy-untrusted-source-marker.js')), false);
  } finally {
    rmSync(marker, { force: true });
  }
});

test('rejects raw secrets, relative paths, duplicate keys, and aliases before writes', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  const raw = { ...options(sourcePath), profilePath, token: 'actual-secret' };
  assert.throws(() => installHermesLucyConfig(configPath, raw), /tokenEnv|required|environment variable/i);
  assert.equal(existsSync(join(profilePath, '.lucy-memory')), false);
  assert.equal(existsSync(configPath + '.lucy-memory.bak'), false);
  assert.equal(existsSync(configPath), false);
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath, baseUrl: 'https://a:b@memory.example.test' }), /credentials|query|fragments/i);
  assert.throws(() => installHermesLucyConfig(join(profilePath, '.lucy-memory', '.config.lock'), { ...options(sourcePath), profilePath }), /outside installer state/i);
  assert.equal(existsSync(join(profilePath, '.lucy-memory')), false);
  assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: 'node', version: '1.0.0' }), /absolute/i);
  writeFileSync(configPath, 'theme: one\ntheme: two\n');
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /duplicate|unique/i);
  writeFileSync(configPath, 'shared: &a { command: keep }\nmcp_servers: *a\n');
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /anchor|alias/i);
  writeFileSync(configPath, 'shared: &foo.bar { command: keep }\nmcp_servers: *foo.bar\n');
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /anchor|alias/i);
  writeFileSync(configPath, 'theme: !custom text\n');
  assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /Invalid.*YAML|explicit tags/i);
});

test('failed config replacement leaves previous YAML unchanged', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const previous = readFileSync(configPath, 'utf8');
  chmodSync(configPath, 0o444);
  assert.throws(() => updateHermesLucyConfig(configPath, { ...options(sourcePath, '2.0.0'), profilePath }), /read-only/i);
  assert.equal(readFileSync(configPath, 'utf8'), previous);
});

test('detects an external config edit during artifact publication instead of overwriting it', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t); writeFileSync(configPath, 'theme: before\n');
  const originalRename = fs.renameSync; let edited = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = originalRename(from, to);
    if (!edited && String(to).includes('/.lucy-memory/staging/') && String(to).endsWith('/package.json')) { edited = true; writeFileSync(configPath, 'theme: external\n'); }
    return result;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }), /changed during artifact publication/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(edited, true); assert.equal(readFileSync(configPath, 'utf8'), 'theme: external\n'); assert.equal(existsSync(configPath + '.lucy-memory.bak'), false);
});

test('detects a raw-token backup replacement during artifact publication before activation', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  const backupPath = `${configPath}.lucy-memory.bak`;
  writeFileSync(configPath, 'theme: current\n');
  writeFileSync(backupPath, 'theme: original\n', { mode: 0o600 });
  const rawBackup = 'mcp_servers:\n  lucy:\n    env:\n      LUCY_MEMORY_TOKEN: externally-inserted-raw-token\n';
  const originalRename = fs.renameSync; let edited = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = originalRename(from, to);
    if (!edited && String(to).includes('/.lucy-memory/staging/') && String(to).endsWith('/package.json')) {
      edited = true;
      writeFileSync(backupPath, rawBackup, { mode: 0o600 });
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }),
      /backup changed during artifact publication/,
    );
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(edited, true);
  assert.equal(readFileSync(configPath, 'utf8'), 'theme: current\n');
  assert.equal(readFileSync(backupPath, 'utf8'), rawBackup);
});

test('a rename failure during config activation preserves the published installation', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t); const first = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath }); const stable = readFileSync(configPath, 'utf8');
  const originalRename = fs.renameSync; t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === configPath) { const error = new Error('forced config rename failure'); error.code = 'EIO'; throw error; }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => updateHermesLucyConfig(configPath, { ...options(sourcePath, '2.0.0'), profilePath }), /forced config rename failure/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  assert.equal(first.artifact.entrypoint.startsWith(first.artifact.path + '/'), true);
});

test('rejects dirty tracked source bytes rather than attributing them to HEAD', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t);
  const original = readFileSync(sourcePath, 'utf8');
  writeFileSync(sourcePath, `${original}\n// dirty fixture\n`);
  assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: NODE, version: 'dirty-source', expectedSourceGitSha: cleanHermesSourceGitSha() }), /working bytes|pinned Git blob/i);
  writeFileSync(sourcePath, original);
});

test('rejects deletion of a tracked closure member from the pinned tree', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t); const deleted = join(sourcePath, '..', 'config.mjs'); const original = readFileSync(deleted);
  try {
    rmSync(deleted);
    assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: NODE, version: 'missing-tracked', expectedSourceGitSha: cleanHermesSourceGitSha() }), /closure.*pinned Git tree/i);
  } finally { writeFileSync(deleted, original); }
});

test('rejects assume-unchanged substitutions and a mismatched commit source identity', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t); const sourceRoot = join(sourcePath, '../../..'); const original = readFileSync(sourcePath, 'utf8');
  const alternateCommit = execFileSync('git', ['commit-tree', sourceTree(sourcePath), '-m', 'alternate trusted source pin'], {
    cwd: sourceRoot, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  }).trim();
  assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: NODE, version: 'untrusted', expectedSourceGitSha: alternateCommit }), /HEAD.*expectedSourceGitSha/i);
  try {
    writeFileSync(sourcePath, `${original}\n// assume unchanged substitution\n`);
    execFileSync('git', ['update-index', '--assume-unchanged', 'src/mcp/bin.mjs'], { cwd: sourceRoot });
    assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: NODE, version: 'assume-unchanged', expectedSourceGitSha: cleanHermesSourceGitSha() }), /working bytes|pinned Git blob/i);
  } finally {
    execFileSync('git', ['update-index', '--no-assume-unchanged', 'src/mcp/bin.mjs'], { cwd: sourceRoot }); writeFileSync(sourcePath, original);
  }
});

test('uses the verified package blob for runtime compatibility after the source tree changes', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, sourcePath } = fixture(t); const sourceRoot = join(sourcePath, '../../..'); const packagePath = join(sourceRoot, 'package.json'); const originalPackage = readFileSync(packagePath, 'utf8');
  const originalRename = fs.renameSync; let changed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = originalRename(from, to);
    if (!changed && String(to).includes('/.lucy-memory/staging/') && String(to).endsWith('/package.json')) {
      changed = true; const changedManifest = JSON.parse(originalPackage); changedManifest.engines = { node: '>=99.0.0' }; writeFileSync(packagePath, `${JSON.stringify(changedManifest, null, 2)}\n`);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const artifact = installHermesLucyArtifact(profilePath, options(sourcePath, 'verified-manifest').artifact);
    assert.equal(changed, true); assert.equal(existsSync(artifact.receiptPath), true);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(packagePath, originalPackage);
  }
});

test('enforces executable Node, package engines, and trusted Hermes compatibility', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, sourcePath } = fixture(t);
  const nonExecutable = join(dir, 'not-executable-node'); writeFileSync(nonExecutable, '#!/bin/sh\necho v22.0.0\n', { mode: 0o600 });
  assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: nonExecutable, version: 'non-executable', expectedSourceGitSha: cleanHermesSourceGitSha() }), /executable/i);
  const unsupported = join(dir, 'unsupported-node'); writeFileSync(unsupported, '#!/bin/sh\necho v25.0.0\n', { mode: 0o700 });
  assert.throws(() => installHermesLucyArtifact(profilePath, { sourcePath, nodePath: unsupported, version: 'unsupported-node', expectedSourceGitSha: cleanHermesSourceGitSha() }), /does not satisfy|Node version/i);
  assert.throws(() => installHermesLucyArtifact(profilePath, {
    sourcePath, nodePath: NODE, version: 'incompatible-hermes', expectedSourceGitSha: cleanHermesSourceGitSha(), compatibility: { hermes: '>=1.0.0' }, trustedHermesVersion: '0.9.0',
  }), /Hermes version.*does not satisfy/i);
});

test('rollback rechecks the recorded Node runtime before it activates an artifact', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, sourcePath } = fixture(t); const node = join(dir, 'node');
  writeFileSync(node, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.0.0; else exec ${NODE} "$@"; fi\n`, { mode: 0o700 });
  const artifact = { ...options(sourcePath).artifact, nodePath: node };
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath, artifact });
  const stable = readFileSync(configPath, 'utf8'); writeFileSync(node, '#!/bin/sh\necho v25.0.0\n', { mode: 0o700 });
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: node }), /does not satisfy|Node version/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('rollback uses the caller-selected trusted Node rather than executing the receipt-selected Node path', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, sourcePath } = fixture(t);
  const marker = join(dir, 'receipt-node-executed'); const receiptNode = join(dir, 'receipt-node');
  writeFileSync(receiptNode, `#!/bin/sh\nprintf receipt-node > ${marker}\nexec ${NODE} "$@"\n`, { mode: 0o700 });
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const stable = readFileSync(configPath, 'utf8');
  const receipt = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8'));
  receipt.node_path = receiptNode;
  writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  rmSync(marker, { force: true });
  assert.throws(() => rollbackHermesLucyConfig(configPath, {
    profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha(), trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION,
  }), /does not match the trusted Node executable/i);
  assert.equal(existsSync(marker), false, 'verification must not execute the receipt-selected Node path');
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  assert.equal(YAML.parse(stable).mcp_servers.lucy.command, NODE);
  assert.equal(stable.includes(receiptNode), false);
});

test('rollback activation keeps the verified trusted Node and rejects a tampered receipt redirect', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, sourcePath } = fixture(t);
  const marker = join(dir, 'tampered-node-executed');
  const tamperedNode = join(dir, 'tampered-node');
  writeFileSync(tamperedNode, `#!/bin/sh\nprintf executed > ${marker}\nexec ${NODE} "$@"\n`, { mode: 0o700 });
  chmodSync(tamperedNode, 0o700);
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  assert.equal(installed.artifact.node_path, NODE);
  const before = readFileSync(configPath, 'utf8');
  const rolled = rollbackHermesLucyConfig(configPath, {
    profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha(), trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION,
  });
  assert.equal(rolled.artifact.node_path, NODE);
  const afterTrusted = readFileSync(configPath, 'utf8');
  const activated = YAML.parse(afterTrusted).mcp_servers.lucy;
  assert.equal(activated.command, NODE);
  assert.equal(activated.args[0], rolled.artifact.entrypoint);
  const launchTrusted = execFileSync(activated.command, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(launchTrusted, /^v\d+/);
  assert.equal(existsSync(marker), false);

  const receipt = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8'));
  receipt.node_path = tamperedNode;
  writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, {
    profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha(), trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION,
  }), /does not match the trusted Node executable/i);
  assert.equal(readFileSync(configPath, 'utf8'), afterTrusted);
  assert.equal(afterTrusted.includes(tamperedNode), false);
  assert.equal(existsSync(marker), false, 'tampered receipt must not redirect verification or activation');
  assert.equal(before.includes(tamperedNode), false);
});

test('rollback requires an independently selected Node executable and rebuilds dependency bytes from the trusted lockfile', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const stable = readFileSync(configPath, 'utf8');
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha() }), /Trusted rollback Node executable is required/);
  const initial = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8'));
  const target = artifactClosure(initial.path, true).files.find((file) => file.endsWith('/package.json'));
  assert.ok(target, 'fixture must contain an installed dependency package manifest');
  writeFileSync(join(initial.path, target), `${readFileSync(join(initial.path, target), 'utf8')}\n`);
  forgeMutableArtifactMetadata(installed.artifact.receiptPath);
  assert.throws(() => rollbackHermesLucyConfig(configPath, {
    profilePath, receiptPath: installed.artifact.receiptPath, sourcePath, expectedSourceGitSha: cleanHermesSourceGitSha(), trustedNodePath: NODE, trustedHermesVersion: TRUSTED_HERMES_VERSION,
  }), /trusted offline lockfile rebuild/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('rollback rejects receipts with stripped source or dependency provenance', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, sourcePath } = fixture(t);
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const stable = readFileSync(configPath, 'utf8');
  const receipt = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8'));
  const sourceClosure = receipt.source_git_closure_digest;
  const dependencyProvenance = receipt.dependency_provenance;
  delete receipt.source_git_closure_digest;
  writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: NODE }), /Invalid artifact receipt/);
  receipt.source_git_closure_digest = sourceClosure;
  delete receipt.dependency_provenance;
  writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: NODE }), /Invalid artifact receipt/);
  receipt.dependency_provenance = { ...dependencyProvenance, closure_digest: '0'.repeat(64) };
  writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: NODE }), /does not match its build manifest/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('rollback rejects a linked package manifest before any digest read escapes the artifact', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, sourcePath } = fixture(t);
  const installed = installHermesLucyConfig(configPath, { ...options(sourcePath), profilePath });
  const stable = readFileSync(configPath, 'utf8');
  const external = join(dir, 'outside-package.json');
  writeFileSync(external, readFileSync(join(installed.artifact.path, 'package.json')));
  rmSync(join(installed.artifact.path, 'package.json'));
  fs.symlinkSync(external, join(installed.artifact.path, 'package.json'));
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: NODE }), /symbolic link/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});
