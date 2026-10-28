import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installHermesLucyConfig } from '../../src/integrations/hermes.mjs';

function options(dir, profilePath) {
  const sourcePath = join(dir, 'mcp.mjs'); writeFileSync(sourcePath, 'export {};\n');
  return { profilePath, artifact: { sourcePath, nodePath: process.execPath, version: '1.0.0' }, baseUrl: 'https://memory.example.test', tokenEnv: 'LUCY_MEMORY_TOKEN' };
}

test('Hermes install fails closed on malformed, duplicate-key, and alias YAML', { skip: process.platform !== 'linux' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-hermes-bad-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile'); mkdirSync(profilePath, { mode: 0o700 }); const path = join(profilePath, 'config.yaml'); const install = options(dir, profilePath);
  for (const content of ['mcp_servers: [', 'theme: one\ntheme: two\n', 'shared: &a {command: keep}\nmcp_servers: *a\n']) {
    writeFileSync(path, content); assert.throws(() => installHermesLucyConfig(path, install), /Invalid|duplicate|anchor|alias/i); assert.equal(readFileSync(path, 'utf8'), content);
  }
});
