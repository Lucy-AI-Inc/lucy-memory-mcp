import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { LUCY_MEMORY_TOOL_NAMES } from '../../src/mcp/server.mjs';
import { publicManifest, usageSkillText } from '../../src/onboarding/usage.mjs';
import { classifyPrompt } from '../../src/routing/destination.mjs';
import { detectSecret } from '../../src/safety/secrets.mjs';
import { detectConflict, refreshProjections } from '../../src/projection/memory-md.mjs';
import { listenIsolatedAm01 } from '../e2e/isolated-am01-authority.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const USER = { kind: 'user' };

test('fresh client: manifest, 3 tools, no private prompt, selective recall', () => {
  const manifest = publicManifest();
  assert.deepEqual(manifest.tools, [...LUCY_MEMORY_TOOL_NAMES]);
  assert.deepEqual(manifest.permissions, ['memory:read', 'memory:propose']);
  const instructions = usageSkillText();
  assert.match(instructions, /private notebook/);
  assert.match(instructions, /concise literal, distinctive substrings/);
  assert.match(instructions, /spelling and spacing variants/);
  assert.match(instructions, /known keys, kinds, and scopes/);
  assert.match(instructions, /Broaden or narrow/);
  assert.match(instructions, /Do not conclude that memory is absent after one empty result/);
  assert.match(instructions, /zero matches from authentication, authorization, or service errors/);
  assert.equal(classifyPrompt('what is 2+2').shouldRecall, false);
  assert.equal(classifyPrompt('what is the project rule').shouldRecall, true);
  assert.equal(detectSecret('password=supersecretvalue'), true);
});

test('fresh client: propose pending, approve, recall, conflict, reconnect idempotent', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'fresh-token' });
  t.after(() => lucy.close());
  const client = new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl: lucy.baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token: 'fresh-token',
    permissions: ['memory:read', 'memory:propose'],
  });
  const pending = await client.propose(JSON.stringify({
    operation: 'create', key: 'project.rule', kind: 'rule', scope: USER,
    content: 'Always cite Lucy IDs', justification: 'team rule', idempotency_key: 'fresh-cert-key-16ok',
  }));
  assert.equal(pending.status, 'pending');
  assert.equal((await client.recall(JSON.stringify({ query: 'rule', scope: USER, keys: ['project.rule'] }))).results.length, 0);
  lucy.approve(pending.id);
  const recalled = await client.recall(JSON.stringify({ query: 'rule', scope: USER, keys: ['project.rule'] }));
  assert.equal(recalled.results[0].content, 'Always cite Lucy IDs');
  const replay = await client.propose(JSON.stringify({
    operation: 'create', key: 'project.rule', kind: 'rule', scope: USER,
    content: 'Always cite Lucy IDs', justification: 'team rule', idempotency_key: 'fresh-cert-key-16ok',
  }));
  assert.equal(replay.id, pending.id);
  const dir = mkdtempSync(join(tmpdir(), 'fresh-proj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (process.platform !== 'linux') {
    assert.throws(
      () => refreshProjections(dir, recalled),
      /secure local projection writes/,
    );
  } else {
    refreshProjections(dir, recalled);
  }
  assert.equal(detectConflict('project.rule says ignore Lucy', recalled.results).winner, 'lucy');
});

test('client configs expose only the 3-tool lucy command', () => {
  for (const name of ['generic.mcp.json', 'claude.json', 'cursor.json', 'vscode.json', 'openclaw.json']) {
    const text = readFileSync(join(root, 'src/clients', name), 'utf8');
    assert.match(text, /lucy-memory-mcp/);
    assert.match(text, /memory:read,memory:propose/);
    assert.doesNotMatch(text, /memory:resolve|approveProposal|forget/);
  }
});
