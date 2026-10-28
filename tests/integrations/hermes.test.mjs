import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hermesLucyStatus, installHermesLucyConfig, uninstallHermesLucyConfig } from '../../src/integrations/hermes.mjs';
import { cleanHermesSource, cleanHermesSourceGitSha } from '../helpers/hermes-clean-source.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-lucy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile'); mkdirSync(profilePath, { mode: 0o700 });
  const configPath = join(profilePath, 'config.yaml'); const sourcePath = cleanHermesSource();
  return { profilePath, configPath, options: { profilePath, artifact: { sourcePath, nodePath: process.execPath, version: '1.0.0', expectedSourceGitSha: cleanHermesSourceGitSha(), compatibility: { hermes: '>=2026.9.0 <2027.0.0' }, trustedHermesVersion: '2026.9.10' }, baseUrl: 'https://www.trylucy.ai', tokenEnv: 'LUCY_MEMORY_TOKEN' } };
}

test('Hermes YAML install is idempotent, preserves unrelated configuration, and uninstalls', { skip: process.platform !== 'linux' }, (t) => {
  const { configPath, options } = setup(t);
  writeFileSync(configPath, 'theme: dark\nmcp_servers:\n  other:\n    command: keep-me\n');
  installHermesLucyConfig(configPath, options); installHermesLucyConfig(configPath, options);
  const installed = readFileSync(configPath, 'utf8');
  assert.match(installed, /theme: dark/); assert.match(installed, /command: keep-me/);
  assert.match(installed, /LUCY_MEMORY_TOKEN: \$\{LUCY_MEMORY_TOKEN\}/);
  assert.equal(hermesLucyStatus(configPath).installed, true);
  uninstallHermesLucyConfig(configPath, { profilePath: options.profilePath });
  const uninstalled = readFileSync(configPath, 'utf8');
  assert.doesNotMatch(uninstalled, /x_lucy_memory_artifact/); assert.match(uninstalled, /command: keep-me/);
});

test('Hermes emits cleartext loopback opt-in only when explicitly requested', { skip: process.platform !== 'linux' }, (t) => {
  const { configPath, options } = setup(t);
  installHermesLucyConfig(configPath, options);
  assert.doesNotMatch(readFileSync(configPath, 'utf8'), /ALLOW_INSECURE_LOOPBACK/);
  const second = join(options.profilePath, 'other.yaml');
  installHermesLucyConfig(second, { ...options, allowInsecureLoopback: true });
  assert.match(readFileSync(second, 'utf8'), /LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: "true"/);
});
