import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installHermesLucyConfig } from '../../src/integrations/hermes.mjs';

test('Hermes install fails closed on a read-only YAML config', { skip: process.platform !== 'linux' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-hermes-ro-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilePath = join(dir, 'profile'); mkdirSync(profilePath, { mode: 0o700 }); const path = join(profilePath, 'config.yaml'); const sourcePath = join(dir, 'mcp.mjs');
  writeFileSync(path, 'mcp_servers:\n  other:\n    command: echo\n'); writeFileSync(sourcePath, 'export {};\n'); chmodSync(path, 0o444);
  assert.throws(() => installHermesLucyConfig(path, { profilePath, artifact: { sourcePath, nodePath: process.execPath, version: '1.0.0' }, baseUrl: 'https://www.trylucy.ai', tokenEnv: 'LUCY_MEMORY_TOKEN' }), /read-only/);
  assert.match(readFileSync(path, 'utf8'), /other/);
});
