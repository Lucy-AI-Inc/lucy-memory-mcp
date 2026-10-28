import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import {
  hermesLucyStatus,
  installHermesLucyArtifact,
  installHermesLucyConfig,
  resetHermesLucyArtifacts,
  resetHermesLucyBackup,
  rollbackHermesLucyConfig,
  uninstallHermesLucyConfig,
} from '../../src/integrations/hermes.mjs';
import { cleanHermesSource, cleanHermesSourceGitSha } from '../helpers/hermes-clean-source.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-hermes-secure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile'); mkdirSync(profilePath, { mode: 0o700 });
  const configPath = join(profilePath, 'config.yaml'); const sourcePath = cleanHermesSource();
  const npmPath = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { dir, profilePath, configPath, options: { profilePath, artifact: { sourcePath, nodePath: process.execPath, npmPath, version: '1.0.0', expectedSourceGitSha: cleanHermesSourceGitSha() }, baseUrl: 'https://www.trylucy.ai', tokenEnv: 'LUCY_MEMORY_TOKEN' } };
}

const mode = (path) => lstatSync(path).mode & 0o777;

test('private files and isolated profile directories are clamped', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, options } = setup(t);
  const sourceMode = mode(options.artifact.sourcePath);
  writeFileSync(configPath, 'theme: dark\n', { mode: 0o666 }); chmodSync(configPath, 0o666);
  installHermesLucyConfig(configPath, options);
  assert.equal(mode(profilePath), 0o700); assert.equal(mode(configPath), 0o600); assert.equal(mode(configPath + '.lucy-memory.bak'), 0o600);
  assert.equal(mode(options.artifact.sourcePath), sourceMode, 'unmanaged source remains unchanged');
});

test('legacy literal Lucy tokens fail before backup, artifact, or installer-state mutation', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, options } = setup(t);
  const original = `theme: legacy
mcp_servers:
  lucy:
    env:
      LUCY_MEMORY_TOKEN: legacy-cleartext-token
`;
  writeFileSync(configPath, original, { mode: 0o600 });
  assert.throws(() => installHermesLucyConfig(configPath, options), /raw token.*rotate/i);
  assert.equal(readFileSync(configPath, 'utf8'), original);
  assert.equal(existsSync(configPath + '.lucy-memory.bak'), false);
  assert.equal(existsSync(join(profilePath, '.lucy-memory')), false);

  writeFileSync(configPath, 'mcp_servers:\n  lucy:\n    env:\n      LUCY_MEMORY_TOKEN: ${LUCY_MEMORY_TOKEN}\n', { mode: 0o600 });
  writeFileSync(configPath + '.lucy-memory.bak', original, { mode: 0o600 });
  assert.throws(() => installHermesLucyConfig(configPath, options), /raw token.*rotate/i);
  assert.equal(readFileSync(configPath + '.lucy-memory.bak', 'utf8'), original);
  assert.equal(existsSync(join(profilePath, '.lucy-memory')), false);
});

test('unsafe ancestors and hard-linked config leaves fail closed before publication', { skip: process.platform !== 'linux' }, (t) => {
  const unsafe = setup(t);
  chmodSync(unsafe.dir, 0o777);
  writeFileSync(unsafe.configPath, 'theme: unsafe-parent\n', { mode: 0o600 });
  assert.throws(
    () => installHermesLucyConfig(unsafe.configPath, unsafe.options),
    /group- or world-writable ancestor/i,
  );
  assert.equal(existsSync(join(unsafe.profilePath, '.lucy-memory')), false);

  const linked = setup(t);
  writeFileSync(linked.configPath, 'theme: hard-linked\n', { mode: 0o600 });
  const alias = join(linked.profilePath, 'config-alias.yaml');
  linkSync(linked.configPath, alias);
  assert.throws(() => installHermesLucyConfig(linked.configPath, linked.options), /hard linked/i);
  assert.equal(readFileSync(alias, 'utf8'), 'theme: hard-linked\n');
  assert.equal(existsSync(join(linked.profilePath, '.lucy-memory')), false);
});

test('symlink and special-file guards reject config and backup before mutation', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, configPath, options } = setup(t); const target = join(dir, 'target.yaml'); writeFileSync(target, 'theme: unchanged\n');
  symlinkSync(target, configPath);
  assert.throws(() => installHermesLucyConfig(configPath, options), /symbolic link/); assert.equal(readFileSync(target, 'utf8'), 'theme: unchanged\n');
  rmSync(configPath); writeFileSync(configPath, 'theme: unchanged\n'); symlinkSync(target, configPath + '.lucy-memory.bak');
  assert.throws(() => installHermesLucyConfig(configPath, options), /symbolic link/); assert.equal(readFileSync(configPath, 'utf8'), 'theme: unchanged\n');
});

test('uninstall preserves later changes and removes only managed Lucy configuration', { skip: process.platform !== 'linux' }, (t) => {
  const { configPath, options } = setup(t); writeFileSync(configPath, 'theme: before\n'); installHermesLucyConfig(configPath, options);
  writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('theme: before', 'theme: after') + 'post_install: true\n');
  assert.deepEqual(uninstallHermesLucyConfig(configPath, { profilePath: options.profilePath }), { restored: false, removed: true });
  const text = readFileSync(configPath, 'utf8'); assert.match(text, /theme: after/); assert.match(text, /post_install: true/); assert.doesNotMatch(text, /lucy_memory_artifact/);
});

test('uninstall refuses to clamp an unmanaged config after losing its lease pathname', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath } = setup(t);
  writeFileSync(configPath, 'theme: unchanged\n', { mode: 0o666 }); chmodSync(configPath, 0o666);
  const lockPath = join(profilePath, '.lucy-memory', '.config.lock');
  const displaced = `${lockPath}.displaced`;
  const originalRead = fs.readFileSync;
  let replaced = false;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (!replaced && typeof path === 'number' && existsSync(lockPath)) {
      replaced = true;
      renameSync(lockPath, displaced);
      writeFileSync(lockPath, 'replacement\n', { mode: 0o600 });
    }
    return originalRead(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => uninstallHermesLucyConfig(configPath, { profilePath }),
      /advisory lock path changed while held/i,
    );
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(replaced, true);
  assert.equal(readFileSync(configPath, 'utf8'), 'theme: unchanged\n');
  assert.equal(mode(configPath), 0o666);
});

test('uninstall and backup-reset reject missing, absolute-outside, and relative-outside paths before mutation', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath } = setup(t); const outside = join(dir, 'outside.yaml'); const backup = outside + '.lucy-memory.bak';
  const configBytes = 'mcp_servers:\n  lucy:\n    command: do-not-remove\n'; const backupBytes = 'backup: do-not-delete\n';
  writeFileSync(outside, configBytes); writeFileSync(backup, backupBytes);
  assert.throws(() => uninstallHermesLucyConfig(outside), /profilePath.*absolute/i);
  assert.equal(readFileSync(outside, 'utf8'), configBytes); assert.equal(readFileSync(backup, 'utf8'), backupBytes);
  assert.throws(() => resetHermesLucyArtifacts(outside), /profilePath.*absolute/i);
  assert.equal(readFileSync(outside, 'utf8'), configBytes); assert.equal(readFileSync(backup, 'utf8'), backupBytes);
  const relativeOutside = relative(process.cwd(), outside);
  for (const cleanup of [uninstallHermesLucyConfig, resetHermesLucyBackup, resetHermesLucyArtifacts]) {
    assert.throws(() => cleanup(outside, { profilePath }), /stay inside/i);
    assert.equal(readFileSync(outside, 'utf8'), configBytes); assert.equal(readFileSync(backup, 'utf8'), backupBytes);
    assert.throws(() => cleanup(relativeOutside, { profilePath }), /absolute/i);
    assert.equal(readFileSync(outside, 'utf8'), configBytes); assert.equal(readFileSync(backup, 'utf8'), backupBytes);
  }
  const linkedProfile = join(dir, 'linked-profile'); const linkTarget = join(dir, 'link-target'); const linkedConfig = join(linkedProfile, 'config.yaml');
  mkdirSync(linkTarget); writeFileSync(join(linkTarget, 'config.yaml'), configBytes); writeFileSync(join(linkTarget, 'config.yaml.lucy-memory.bak'), backupBytes); symlinkSync(linkTarget, linkedProfile);
  assert.throws(() => uninstallHermesLucyConfig(linkedConfig, { profilePath: linkedProfile }), /symbolic link/i);
  assert.throws(() => resetHermesLucyArtifacts(linkedConfig, { profilePath: linkedProfile }), /symbolic link/i);
  assert.equal(readFileSync(join(linkTarget, 'config.yaml'), 'utf8'), configBytes); assert.equal(readFileSync(join(linkTarget, 'config.yaml.lucy-memory.bak'), 'utf8'), backupBytes);
});

test('backup reset names are equivalent and deliberately retain artifact and receipt caches', { skip: process.platform !== 'linux' }, (t) => {
  const { configPath, options } = setup(t); writeFileSync(configPath, 'theme: stable\n');
  const installed = installHermesLucyConfig(configPath, options); const backup = configPath + '.lucy-memory.bak';
  assert.equal(resetHermesLucyBackup(configPath, { profilePath: options.profilePath }), undefined);
  assert.equal(existsSync(backup), false); assert.equal(existsSync(installed.artifact.path), true); assert.equal(existsSync(installed.artifact.receiptPath), true);
  writeFileSync(backup, 'replacement backup\n');
  assert.equal(resetHermesLucyArtifacts(configPath, { profilePath: options.profilePath }), undefined);
  assert.equal(existsSync(backup), false); assert.equal(existsSync(installed.artifact.path), true); assert.equal(existsSync(installed.artifact.receiptPath), true);
});

test('intermediate-directory symlinks reject reset and uninstall before touching outside config files', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath } = setup(t); const outside = join(dir, 'outside'); const child = join(profilePath, 'child-link'); const configPath = join(child, 'config.yaml'); const backupPath = configPath + '.lucy-memory.bak';
  const configBytes = 'theme: outside\n'; const backupBytes = 'backup: outside\n'; mkdirSync(outside); writeFileSync(join(outside, 'config.yaml'), configBytes, { mode: 0o666 }); writeFileSync(join(outside, 'config.yaml.lucy-memory.bak'), backupBytes, { mode: 0o644 }); chmodSync(join(outside, 'config.yaml'), 0o666); chmodSync(join(outside, 'config.yaml.lucy-memory.bak'), 0o644); symlinkSync(outside, child);
  const configMode = mode(configPath); const backupMode = mode(backupPath);
  assert.throws(() => resetHermesLucyArtifacts(configPath, { profilePath }), /must not traverse a symbolic link/i);
  assert.throws(() => uninstallHermesLucyConfig(configPath, { profilePath }), /must not traverse a symbolic link/i);
  assert.equal(readFileSync(configPath, 'utf8'), configBytes); assert.equal(mode(configPath), configMode);
  assert.equal(readFileSync(backupPath, 'utf8'), backupBytes); assert.equal(mode(backupPath), backupMode); assert.ok(lstatSync(backupPath).isFile());
});

test('intermediate-directory symlinks reject install and rollback before artifact work or config reads', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, options } = setup(t); const outside = join(dir, 'outside'); const child = join(profilePath, 'child-link'); const configPath = join(child, 'config.yaml'); const backupPath = configPath + '.lucy-memory.bak';
  const configBytes = 'theme: outside\n'; const backupBytes = 'backup: outside\n'; mkdirSync(outside); writeFileSync(join(outside, 'config.yaml'), configBytes, { mode: 0o666 }); writeFileSync(join(outside, 'config.yaml.lucy-memory.bak'), backupBytes, { mode: 0o644 }); chmodSync(join(outside, 'config.yaml'), 0o666); chmodSync(join(outside, 'config.yaml.lucy-memory.bak'), 0o644); symlinkSync(outside, child);
  const configMode = mode(configPath); const backupMode = mode(backupPath);
  assert.throws(() => installHermesLucyConfig(configPath, { ...options, artifact: { ...options.artifact, sourcePath: join(dir, 'missing-source.mjs') } }), /must not traverse a symbolic link/i);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: join(dir, 'missing-receipt.json') }), /must not traverse a symbolic link/i);
  assert.equal(readFileSync(configPath, 'utf8'), configBytes); assert.equal(mode(configPath), configMode);
  assert.equal(readFileSync(backupPath, 'utf8'), backupBytes); assert.equal(mode(backupPath), backupMode); assert.ok(lstatSync(backupPath).isFile());
});

test('existing regular backup is validated and clamped, while malformed backup fails before install', { skip: process.platform !== 'linux' }, (t) => {
  const { configPath, options } = setup(t); const backup = configPath + '.lucy-memory.bak';
  writeFileSync(configPath, 'theme: current\n', { mode: 0o600 }); writeFileSync(backup, 'theme: original\n', { mode: 0o666 }); chmodSync(backup, 0o666);
  installHermesLucyConfig(configPath, options); assert.equal(mode(backup), 0o600); assert.equal(readFileSync(backup, 'utf8'), 'theme: original\n');
  writeFileSync(configPath, 'theme: unchanged\n'); writeFileSync(backup, 'not: [valid');
  assert.throws(() => installHermesLucyConfig(configPath, options), /Invalid/); assert.equal(readFileSync(configPath, 'utf8'), 'theme: unchanged\n');
});

test('status and uninstall reject config links and non-regular paths without touching targets', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath } = setup(t); const target = join(dir, 'target.yaml'); writeFileSync(target, 'mcp_servers:\n  lucy:\n    command: do-not-remove\n'); symlinkSync(target, configPath);
  assert.throws(() => hermesLucyStatus(configPath), /symbolic link/); assert.throws(() => uninstallHermesLucyConfig(configPath, { profilePath }), /symbolic link/); assert.match(readFileSync(target, 'utf8'), /do-not-remove/);
  rmSync(configPath); mkdirSync(configPath); assert.throws(() => hermesLucyStatus(configPath), /regular file/);
});

test('status validates existing parents without creating or clamping absent paths', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath } = setup(t); const absentParent = join(profilePath, 'absent', 'nested'); const absentConfig = join(absentParent, 'config.yaml');
  assert.deepEqual(hermesLucyStatus(absentConfig), { installed: false }); assert.equal(existsSync(absentParent), false);
  const outside = join(dir, 'outside'); mkdirSync(outside, { mode: 0o755 }); const linkedParent = join(profilePath, 'linked'); symlinkSync(outside, linkedParent);
  assert.throws(() => hermesLucyStatus(join(linkedParent, 'config.yaml')), /must not traverse a symbolic link/i);
  assert.equal(mode(outside), 0o755);
});

test('backup links and directories fail closed; artifact reset never follows a backup link', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t); const backup = configPath + '.lucy-memory.bak'; const target = join(dir, 'do-not-delete.yaml'); writeFileSync(configPath, 'theme: safe\n'); writeFileSync(target, 'target: safe\n'); symlinkSync(target, backup);
  assert.throws(() => installHermesLucyConfig(configPath, options), /symbolic link/); assert.throws(() => uninstallHermesLucyConfig(configPath, { profilePath }), /symbolic link/); assert.throws(() => resetHermesLucyArtifacts(configPath, { profilePath }), /symbolic link/); assert.equal(readFileSync(target, 'utf8'), 'target: safe\n');
  rmSync(backup); mkdirSync(backup); assert.throws(() => installHermesLucyConfig(configPath, options), /regular file/); assert.equal(readFileSync(configPath, 'utf8'), 'theme: safe\n');
});

test('closed artifact records immutable official provenance and private closure material', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, options } = setup(t);
  const artifact = installHermesLucyArtifact(profilePath, options.artifact);
  const receipt = JSON.parse(readFileSync(artifact.receiptPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(artifact.path, 'lucy-hermes-build-manifest.json'), 'utf8'));
  assert.equal(mode(join(profilePath, '.lucy-memory', 'artifacts')), 0o700);
  assert.equal(mode(join(profilePath, '.lucy-memory', 'receipts')), 0o700);
  assert.equal(mode(artifact.path), 0o700); assert.equal(mode(artifact.entrypoint), 0o600); assert.equal(mode(artifact.receiptPath), 0o600);
  assert.match(receipt.source_git_sha, /^[a-f0-9]{40}$/); assert.equal(receipt.package_name, '@trylucy/agent-memory');
  assert.match(receipt.artifact_digest, /^[a-f0-9]{64}$/); assert.equal(manifest.artifact_digest, receipt.artifact_digest);
  assert.equal(receipt.entrypoint, artifact.entrypoint); assert.ok(readdirSync(join(artifact.path, 'node_modules')).length > 0);
});

test('tampered, linked, or interrupted artifact publication fails closed without changing config', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t);
  const installed = installHermesLucyConfig(configPath, options); const stable = readFileSync(configPath, 'utf8');
  writeFileSync(installed.artifact.entrypoint, 'export {};\n');
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /digest mismatch/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  const target = join(dir, 'receipt-target.json'); writeFileSync(target, '{}\n'); rmSync(installed.artifact.receiptPath); symlinkSync(target, installed.artifact.receiptPath);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /symbolic link/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  assert.throws(() => installHermesLucyConfig(configPath, { ...options, artifact: { ...options.artifact, sourcePath: join(dir, 'missing.mjs'), version: 'interrupted' } }));
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('artifact-directory links fail closed during receipt recovery', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t);
  const installed = installHermesLucyConfig(configPath, options); const stable = readFileSync(configPath, 'utf8');
  const target = join(dir, 'artifact-target'); mkdirSync(target); rmSync(installed.artifact.path, { recursive: true }); symlinkSync(target, installed.artifact.path);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /symbolic link/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('receipt recovery rejects linked receipt and artifact parents plus relative receipt references', { skip: process.platform !== 'linux' }, (t) => {
  const receiptFixture = setup(t); const receiptInstalled = installHermesLucyConfig(receiptFixture.configPath, receiptFixture.options); const receiptStable = readFileSync(receiptFixture.configPath, 'utf8');
  const receiptParent = join(receiptFixture.profilePath, '.lucy-memory', 'receipts'); const receiptTarget = join(receiptFixture.dir, 'outside-receipts');
  renameSync(receiptParent, receiptTarget); symlinkSync(receiptTarget, receiptParent);
  assert.throws(() => rollbackHermesLucyConfig(receiptFixture.configPath, { profilePath: receiptFixture.profilePath, receiptPath: receiptInstalled.artifact.receiptPath, trustedNodePath: receiptFixture.options.artifact.nodePath }), /must not traverse a symbolic link/i);
  assert.equal(readFileSync(receiptFixture.configPath, 'utf8'), receiptStable);
  rmSync(receiptParent); writeFileSync(receiptParent, 'not a directory\n');
  assert.throws(() => rollbackHermesLucyConfig(receiptFixture.configPath, { profilePath: receiptFixture.profilePath, receiptPath: receiptInstalled.artifact.receiptPath, trustedNodePath: receiptFixture.options.artifact.nodePath }), /parent must be a directory/i);
  assert.equal(readFileSync(receiptFixture.configPath, 'utf8'), receiptStable);

  const artifactFixture = setup(t); const artifactInstalled = installHermesLucyConfig(artifactFixture.configPath, artifactFixture.options); const artifactStable = readFileSync(artifactFixture.configPath, 'utf8');
  const artifactParent = join(artifactFixture.profilePath, '.lucy-memory', 'artifacts'); const artifactTarget = join(artifactFixture.dir, 'outside-artifacts');
  renameSync(artifactParent, artifactTarget); symlinkSync(artifactTarget, artifactParent);
  assert.throws(() => rollbackHermesLucyConfig(artifactFixture.configPath, { profilePath: artifactFixture.profilePath, receiptPath: artifactInstalled.artifact.receiptPath, trustedNodePath: artifactFixture.options.artifact.nodePath }), /must not traverse a symbolic link/i);
  assert.equal(readFileSync(artifactFixture.configPath, 'utf8'), artifactStable);
  rmSync(artifactParent); writeFileSync(artifactParent, 'not a directory\n');
  assert.throws(() => rollbackHermesLucyConfig(artifactFixture.configPath, { profilePath: artifactFixture.profilePath, receiptPath: artifactInstalled.artifact.receiptPath, trustedNodePath: artifactFixture.options.artifact.nodePath }), /parent must be a directory/i);
  assert.equal(readFileSync(artifactFixture.configPath, 'utf8'), artifactStable);

  const relativeFixture = setup(t); const relativeInstalled = installHermesLucyConfig(relativeFixture.configPath, relativeFixture.options); const relativeStable = readFileSync(relativeFixture.configPath, 'utf8');
  const receipt = JSON.parse(readFileSync(relativeInstalled.artifact.receiptPath, 'utf8')); receipt.path = '.lucy-memory/artifacts/relative'; writeFileSync(relativeInstalled.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(relativeFixture.configPath, { profilePath: relativeFixture.profilePath, receiptPath: relativeInstalled.artifact.receiptPath, trustedNodePath: relativeFixture.options.artifact.nodePath }), /Artifact path must be an absolute path/i);
  assert.equal(readFileSync(relativeFixture.configPath, 'utf8'), relativeStable);
});

test('receipt recovery rejects absolute receipt and artifact paths outside its isolated profile', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t); const installed = installHermesLucyConfig(configPath, options); const stable = readFileSync(configPath, 'utf8');
  const externalReceipt = join(dir, 'external-receipt.json'); const externalReceiptBytes = '{"outside":true}\n'; writeFileSync(externalReceipt, externalReceiptBytes);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: externalReceipt, trustedNodePath: options.artifact.nodePath }), /stay inside/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable); assert.equal(readFileSync(externalReceipt, 'utf8'), externalReceiptBytes);
  const externalArtifact = join(dir, 'external-artifact'); const externalSentinel = join(externalArtifact, 'do-not-read-or-write'); mkdirSync(externalArtifact); writeFileSync(externalSentinel, 'outside artifact\n');
  const receipt = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8')); receipt.path = externalArtifact; writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /stay inside/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable); assert.equal(readFileSync(externalSentinel, 'utf8'), 'outside artifact\n');
});

test('receipt recovery binds its entrypoint and compatibility range to the verified artifact', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t); const installed = installHermesLucyConfig(configPath, options); const stable = readFileSync(configPath, 'utf8');
  const receipt = JSON.parse(readFileSync(installed.artifact.receiptPath, 'utf8'));
  receipt.entrypoint = join(dir, 'other-entrypoint.mjs'); writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /entrypoint/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  receipt.entrypoint = installed.artifact.entrypoint; receipt.compatibility.node.required_range = '>=0.0.0'; writeFileSync(installed.artifact.receiptPath, `${JSON.stringify(receipt)}\n`);
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, trustedNodePath: options.artifact.nodePath }), /compatibility.*manifest|Node range/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
});

test('Hermes-constrained rollback requires a current trusted host version', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, options } = setup(t);
  const constrained = { ...options, artifact: { ...options.artifact, compatibility: { hermes: '>=1.0.0' }, trustedHermesVersion: '1.2.3' } };
  const installed = installHermesLucyConfig(configPath, constrained); const stable = readFileSync(configPath, 'utf8');
  assert.throws(() => rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, sourcePath: options.artifact.sourcePath, expectedSourceGitSha: options.artifact.expectedSourceGitSha, trustedNodePath: options.artifact.nodePath }), /Trusted Hermes host version is required/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  rollbackHermesLucyConfig(configPath, { profilePath, receiptPath: installed.artifact.receiptPath, sourcePath: options.artifact.sourcePath, expectedSourceGitSha: options.artifact.expectedSourceGitSha, trustedNodePath: options.artifact.nodePath, trustedHermesVersion: '1.2.3' });
  assert.match(readFileSync(configPath, 'utf8'), /1\.0\.0/);
});

test('cached artifacts enforce current runtime and immutable Hermes policy before config changes', { skip: process.platform !== 'linux' }, (t) => {
  const { dir, profilePath, configPath, options } = setup(t);
  const constrained = { ...options, artifact: { ...options.artifact, compatibility: { hermes: '>=1.0.0' }, trustedHermesVersion: '1.2.3' } };
  const installed = installHermesLucyConfig(configPath, constrained); const stable = readFileSync(configPath, 'utf8');
  assert.equal(installHermesLucyConfig(configPath, constrained).artifact.receiptPath, installed.artifact.receiptPath, 'matching constrained cache is idempotent');
  assert.throws(() => installHermesLucyConfig(configPath, { ...constrained, artifact: { ...constrained.artifact, compatibility: {} } }), /Cached artifact reuse requires an explicit trusted Hermes compatibility policy/);
  assert.throws(() => installHermesLucyConfig(configPath, { ...constrained, artifact: { ...constrained.artifact, trustedHermesVersion: undefined } }), /Cached artifact reuse requires an explicit trusted Hermes compatibility policy/);
  assert.equal(readFileSync(configPath, 'utf8'), stable);
  assert.throws(() => installHermesLucyConfig(configPath, { ...constrained, artifact: { ...constrained.artifact, trustedHermesVersion: '0.9.0' } }), /Hermes version.*does not satisfy/i);
  assert.equal(readFileSync(configPath, 'utf8'), stable);

  const unconstrained = { ...options, artifact: { ...options.artifact, version: 'unconstrained' } };
  installHermesLucyConfig(configPath, unconstrained); const unconstrainedStable = readFileSync(configPath, 'utf8');
  assert.throws(() => installHermesLucyConfig(configPath, { ...unconstrained, artifact: { ...unconstrained.artifact, compatibility: { hermes: '>=0.0.0' }, trustedHermesVersion: '1.2.3' } }), /conflicts with requested compatibility/i);
  assert.equal(readFileSync(configPath, 'utf8'), unconstrainedStable);
  assert.throws(() => installHermesLucyConfig(configPath, { ...unconstrained, artifact: { ...unconstrained.artifact, compatibility: { hermes: '>=99.0.0' }, trustedHermesVersion: '1.2.3' } }), /Hermes version.*does not satisfy/i);
  assert.equal(readFileSync(configPath, 'utf8'), unconstrainedStable);

  const cachedUnconstrainedPolicy = { compatibility: { hermes: '>=0.0.0' }, trustedHermesVersion: '1.2.3' };
  const copiedNode = join(dir, 'copied-node'); writeFileSync(copiedNode, readFileSync(process.execPath), { mode: 0o700 }); chmodSync(copiedNode, 0o700);
  assert.throws(() => installHermesLucyConfig(configPath, { ...unconstrained, artifact: { ...unconstrained.artifact, ...cachedUnconstrainedPolicy, nodePath: copiedNode } }), /conflicts with requested artifact|does not match the trusted Node executable/i);
  assert.equal(readFileSync(configPath, 'utf8'), unconstrainedStable);
  writeFileSync(copiedNode, '#!/bin/sh\necho v99.0.0\n', { mode: 0o700 }); chmodSync(copiedNode, 0o700);
  assert.throws(() => installHermesLucyConfig(configPath, { ...unconstrained, artifact: { ...unconstrained.artifact, ...cachedUnconstrainedPolicy, nodePath: copiedNode } }), /does not satisfy|Node version|does not match the trusted Node executable/i);
  assert.equal(readFileSync(configPath, 'utf8'), unconstrainedStable);
});

test('unsafe umask leaves no temporary publication files and all private files clamped', { skip: process.platform !== 'linux' }, (t) => {
  const { profilePath, configPath, options } = setup(t); writeFileSync(configPath, 'theme: before\n'); const old = process.umask(0);
  try { installHermesLucyConfig(configPath, options); } finally { process.umask(old); }
  const pending = readdirSync(join(profilePath, '.lucy-memory', 'artifacts'), { recursive: true }).filter((name) => String(name).endsWith('.tmp'));
  assert.deepEqual(pending, []); assert.equal(mode(configPath), 0o600); assert.equal(mode(configPath + '.lucy-memory.bak'), 0o600);
});
