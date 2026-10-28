import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { scanBuffer } from '../../scripts/scan-secrets.mjs';

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = resolve(import.meta.dirname, '../..');

function isolatedNpmEnvironment(directory) {
  return {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    npm_config_cache: resolve(directory, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

function runNpm(args, { cwd, env, timeout = 180000 } = {}) {
  return spawnSync(npmBin, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout,
    env,
  });
}

function files(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function installedLucyBin(consumer) {
  const binDir = resolve(consumer, 'node_modules', '.bin');
  if (process.platform === 'win32') return resolve(binDir, 'lucy-memory-mcp.cmd');
  return resolve(binDir, 'lucy-memory-mcp');
}

test('npm pack dry-run allowlist excludes private governance and development artifacts', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lucy-memory-mcp-pack-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packed = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    env: isolatedNpmEnvironment(directory),
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const parsed = JSON.parse(packed.stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  const names = result.files.map(({ path }) => path.replaceAll('\\', '/')).sort();
  for (const required of [
    'README.md', 'package.json', 'src/client/index.mjs', 'src/client/index.d.ts',
    'src/mcp/server.mjs', 'src/mcp/index.d.ts', 'src/mcp/stdio.mjs', 'src/mcp/stdio.d.ts', 'src/mcp/bin.mjs',
    'src/client/http-transport.mjs', 'src/client/http-transport.d.ts',
    'src/provider/index.mjs', 'src/integrations/hermes.mjs',
    'contracts/agent-manifest.json', 'src/clients/generic.mcp.json',
    'schemas/v1/common.schema.json', 'contracts/agent-memory-api.contract.json', 'scripts/lib/am01.mjs',
  ]) assert.ok(names.includes(required), `missing package file: ${required}`);
  for (const name of names) {
    assert.doesNotMatch(name, /(?:^|\/)(?:\.lucy-governance|tests|fixtures|\.github|\.git|node_modules)(?:\/|$)/);
    assert.doesNotMatch(name, /certifier|evidence|scope-lock|report/i);
  }
  assert.equal(names.some((name) => name.endsWith('.pem') || name.endsWith('.key')), false);
  assert.equal(names.includes('package-lock.json'), false);
});

test('public package source contains no private host or certifier references', () => {
  const roots = ['src', 'schemas', 'contracts', 'scripts/lib'].map((name) => resolve(root, name));
  const privateHostPath = ['/home', ['golden', 'goose'].join('_')].join('/');
  const privateCertifierDirectory = ['.lucy', 'certifier'].join('-');
  for (const path of roots.flatMap(files)) {
    if (statSync(path).size > 2_000_000) continue;
    const text = readFileSync(path, 'utf8');
    assert.equal(text.includes(privateHostPath), false);
    assert.equal(text.includes(privateCertifierDirectory), false);
    assert.doesNotMatch(text, /(?:password|api[_-]?key|bearer[_-]?token)\s*[=:]\s*['"][^'"]{8,}['"]/i);
  }
});

test('tarball installs in an empty consumer and exposes bin plus public exports', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lucy-memory-mcp-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(resolve(directory, '.npm-cache'), { recursive: true });
  const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], {
    cwd: root,
    env: isolatedNpmEnvironment(directory),
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packJson = JSON.parse(packed.stdout);
  const filename = Array.isArray(packJson) ? packJson[0].filename : packJson.filename;
  const tarball = resolve(directory, filename);
  assert.ok(statSync(tarball).isFile());
  const tarballHits = scanBuffer(filename, readFileSync(tarball));
  assert.deepEqual(tarballHits, []);

  const consumer = resolve(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ name: 'lucy-mcp-consumer', type: 'module', private: true }, null, 2));
  const installed = runNpm(['install', tarball, '--ignore-scripts', '--no-package-lock'], {
    cwd: consumer,
    env: isolatedNpmEnvironment(directory),
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  const bin = installedLucyBin(consumer);
  const invoked = spawnSync(bin, [], {
    cwd: consumer,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, HOME: directory, USERPROFILE: directory },
  });
  assert.equal(invoked.status, 1, invoked.stderr || invoked.stdout);
  assert.equal(invoked.stdout, '');
  assert.match(invoked.stderr, /CONFIGURATION_ERROR/);

  const checker = resolve(consumer, 'import-public.mjs');
  writeFileSync(checker, `
    const client = await import('@trylucy/agent-memory');
    const mcp = await import('@trylucy/agent-memory/mcp');
    const stdio = await import('@trylucy/agent-memory/mcp/stdio');
    const provider = await import('@trylucy/agent-memory/provider');
    const hermes = await import('@trylucy/agent-memory/hermes');
    if (typeof client.createLucyHttpTransport !== 'function') throw new Error('client export missing');
    if (typeof mcp.createLucyMemoryMcpServer !== 'function') throw new Error('mcp export missing');
    if (typeof stdio.main !== 'function' && typeof stdio.startLucyMemoryMcpStdio !== 'function' && typeof stdio.runLucyMemoryMcpStdio !== 'function') {
      throw new Error('stdio export missing');
    }
    if (!provider.LucyMemoryFirstProvider && typeof provider.shouldRecall !== 'function') throw new Error('provider export missing');
    if (typeof hermes.installHermesLucyConfig !== 'function') throw new Error('hermes export missing');
    console.log('public-exports-ok');
  `);
  const imported = spawnSync(process.execPath, [checker], {
    cwd: consumer,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  assert.match(imported.stdout, /public-exports-ok/);
});
