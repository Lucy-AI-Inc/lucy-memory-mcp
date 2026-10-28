import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('documented client configs parse and expose only the lucy command plus two permissions', () => {
  const files = [
    'src/clients/generic.mcp.json',
    'src/clients/claude-desktop.json',
    'src/clients/claude.json',
    'src/clients/cursor.json',
    'src/clients/vscode.json',
    'src/clients/openclaw.json',
  ];
  for (const rel of files) {
    const parsed = JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
    const blob = JSON.stringify(parsed);
    assert.match(blob, /lucy-memory-mcp/);
    assert.match(blob, /memory:read/);
    assert.match(blob, /memory:propose/);
    assert.doesNotMatch(blob, /memory:resolve|memory:approve|memory:write/);
    assert.doesNotMatch(blob, /sk_live_|ghp_|AKIA/);
  }
});

test('Codex MCP config uses stdio and forwards the token without storing it', () => {
  const config = readFileSync(resolve(root, 'src/clients/codex.toml'), 'utf8');
  assert.match(config, /^\[mcp_servers\.lucy\]$/m);
  assert.match(config, /^command = "lucy-memory-mcp"$/m);
  assert.match(config, /^env_vars = \["LUCY_MEMORY_TOKEN"\]$/m);
  assert.match(config, /LUCY_MEMORY_PERMISSIONS\s*=\s*"memory:read,memory:propose"/);
  assert.match(config, /LUCY_MEMORY_BASE_URL\s*=\s*"https:\/\/www\.trylucy\.ai"/);
  assert.doesNotMatch(config, /<token>|sk_live_|ghp_|AKIA/);
});

test('client docs link the supported host templates without embedding credentials', () => {
  const docs = readFileSync(resolve(root, 'docs/clients.md'), 'utf8');
  assert.match(docs, /claude-desktop\.json/);
  assert.match(docs, /codex\.toml/);
  assert.match(docs, /cursor\.json/);
  assert.match(docs, /vscode\.json/);
  assert.doesNotMatch(docs, /sk_live_|ghp_|AKIA/);
});

test('README documents the exact three tools and public imports', () => {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  assert.match(readme, /memory_recall/);
  assert.match(readme, /memory_propose/);
  assert.match(readme, /memory_proposal_status/);
  assert.match(readme, /@trylucy\/agent-memory\/mcp\/stdio/);
  assert.match(readme, /@trylucy\/agent-memory\/hermes/);
  assert.doesNotMatch(readme, /memory_approve|memory_forget|memory_resolve/);
});
