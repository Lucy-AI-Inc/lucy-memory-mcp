import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { createLucyMemoryMcpServer, LUCY_MEMORY_TOOL_NAMES } from '../../src/mcp/server.mjs';
import { listenIsolatedAm01 } from './isolated-am01-authority.mjs';

const USER = { kind: 'user' };

test('Wave 4 isolated E2E: MCP client, HTTP transport, AM-01 authority', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'e2e-token' });
  t.after(() => lucy.close());

  const transport = createLucyHttpTransport({ baseUrl: lucy.baseUrl, allowInsecureLoopback: true, maxRetries: 0 });
  const client = new AgentMemoryClient({
    transport,
    token: 'e2e-token',
    permissions: ['memory:read', 'memory:propose'],
  });
  const listed = { tools: [{ name: 'memory_recall' }, { name: 'memory_propose' }, { name: 'memory_proposal_status' }] };
  await createLucyMemoryMcpServer({ client });
  assert.deepEqual(listed.tools.map((tool) => tool.name), [...LUCY_MEMORY_TOOL_NAMES]);

  const empty = await client.recall(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(empty.results.length, 0);

  const pending = await client.propose(JSON.stringify({
    operation: 'create',
    key: 'profile.name',
    kind: 'fact',
    scope: USER,
    content: 'Ada Lovelace',
    justification: 'user stated preferred name',
    idempotency_key: 'e2e-create-key-16ok',
  }));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.result, null);

  const stillPending = await client.proposalStatus(JSON.stringify({ proposal_id: pending.id }));
  assert.equal(stillPending.status, 'pending');

  const stillEmpty = await client.recall(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(stillEmpty.results.length, 0, 'pending is not recallable');

  const approved = lucy.approve(pending.id);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');

  const statusApproved = await client.proposalStatus(JSON.stringify({ proposal_id: pending.id }));
  assert.equal(statusApproved.status, 'approved');
  assert.equal(statusApproved.result.memory_version, 1);

  const recalled = await client.recall(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(recalled.results.length, 1);
  assert.equal(recalled.results[0].content, 'Ada Lovelace');
  assert.equal(recalled.results[0].version, 1);
  assert.equal(recalled.results[0].receipt.authority.type, 'human_approved');

  const replacePending = await client.propose(JSON.stringify({
    operation: 'replace',
    memory_id: recalled.results[0].id,
    expected_version: 1,
    key: 'profile.name',
    scope: USER,
    content: 'Ada King',
    justification: 'user corrected name',
    idempotency_key: 'e2e-replace-key-16ok',
  }));
  assert.equal(replacePending.status, 'pending');

  const stillV1 = await client.recall(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(stillV1.results[0].version, 1);

  const replaceApproved = lucy.approve(replacePending.id);
  assert.equal(replaceApproved.status, 200);
  assert.equal(replaceApproved.body.result.memory_version, 2);
  assert.equal(replaceApproved.body.result.memory_id, recalled.results[0].id);

  const v2 = await client.recall(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(v2.results.length, 1);
  assert.equal(v2.results[0].version, 2);
  assert.equal(v2.results[0].content, 'Ada King');
  assert.equal(v2.results[0].id, recalled.results[0].id);
  assert.equal(v2.results[0].receipt.relations[0].type, 'supersedes');

  const stale = client.propose(JSON.stringify({
    operation: 'replace',
    memory_id: recalled.results[0].id,
    expected_version: 1,
    key: 'profile.name',
    scope: USER,
    content: 'stale',
    justification: 'should conflict',
    idempotency_key: 'e2e-stale-key-16okay',
  }));
  const stalePending = await stale;
  const staleApprove = lucy.approve(stalePending.id);
  assert.equal(staleApprove.status, 409);
});
