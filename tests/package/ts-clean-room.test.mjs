import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = resolve(import.meta.dirname, '../..');

function run(cmd, args, cwd, extraEnv = {}) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
    windowsHide: true,
    timeout: 180000,
    env: {
      ...process.env,
      HOME: extraEnv.HOME || process.env.HOME,
      USERPROFILE: extraEnv.USERPROFILE || process.env.USERPROFILE,
      npm_config_cache: extraEnv.npm_config_cache,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    },
  });
}

test('TypeScript consumer compiles public exports from an installed tarball only', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lucy-ts-clean-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packed = run(npmBin, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root, {
    HOME: directory,
    USERPROFILE: directory,
    npm_config_cache: resolve(directory, '.npm-cache'),
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packJson = JSON.parse(packed.stdout);
  const filename = Array.isArray(packJson) ? packJson[0].filename : packJson.filename;
  const tarball = resolve(directory, filename);
  const consumer = resolve(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({
    name: 'lucy-ts-consumer',
    private: true,
    type: 'module',
  }, null, 2));
  const installed = run(npmBin, ['install', tarball, '--ignore-scripts', '--no-package-lock'], consumer, {
    HOME: directory,
    USERPROFILE: directory,
    npm_config_cache: resolve(directory, '.npm-cache'),
  });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  writeFileSync(resolve(consumer, 'consumer.ts'), readFileSync(resolve(root, 'tests/types/mcp-consumer.ts'), 'utf8'));
  writeFileSync(resolve(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['consumer.ts'],
  }, null, 2));
  const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
  const compiled = run(process.execPath, [tsc, '-p', 'tsconfig.json'], consumer);
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
});
