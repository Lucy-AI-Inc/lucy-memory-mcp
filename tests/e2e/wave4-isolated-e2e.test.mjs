import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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
  const server = await createLucyMemoryMcpServer({ client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'wave4-e2e', version: '1.0.0' });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });

  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [...LUCY_MEMORY_TOOL_NAMES]);
  const proposalSchema = listed.tools.find((tool) => tool.name === 'memory_propose').inputSchema;
  assert.equal(proposalSchema.properties.operation.enum.includes('create'), true);
  assert.equal(proposalSchema.properties.memory_id.$ref, '#/$defs/common/$defs/memoryId');
  assert.equal(proposalSchema.$defs.common.$defs.memoryId.pattern, '^mem_[A-Za-z0-9_-]+$');

  const emptyResult = await mcp.callTool({
    name: 'memory_recall', arguments: { query: 'name', scope: USER, keys: ['profile.name'] },
  });
  const empty = emptyResult.structuredContent;
  assert.equal(empty.results.length, 0);
  assert.equal(empty.results.length, 0);

  const proposed = await mcp.callTool({ name: 'memory_propose', arguments: {
    operation: 'create',
    key: 'profile.name',
    kind: 'fact',
    scope: USER,
    content: 'Ada Lovelace',
    justification: 'user stated preferred name',
    idempotency_key: 'e2e-create-key-16ok',
  } });
  const pending = proposed.structuredContent;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.result, null);

  const repeated = await mcp.callTool({ name: 'memory_propose', arguments: {
    operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
    content: 'Ada Lovelace', justification: 'user stated preferred name',
    idempotency_key: 'e2e-create-key-16ok',
  } });
  assert.equal(repeated.structuredContent.id, pending.id, 'idempotent retry returns the original proposal');

  const stillPendingResult = await mcp.callTool({
    name: 'memory_proposal_status', arguments: { proposal_id: pending.id },
  });
  assert.equal(stillPendingResult.structuredContent.status, 'pending');

  const stillEmptyResult = await mcp.callTool({
    name: 'memory_recall', arguments: { query: 'name', scope: USER, keys: ['profile.name'] },
  });
  assert.equal(stillEmptyResult.structuredContent.results.length, 0, 'pending is not recallable');

  const approved = lucy.approve(pending.id);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');

  const statusApprovedResult = await mcp.callTool({
    name: 'memory_proposal_status', arguments: { proposal_id: pending.id },
  });
  const statusApproved = statusApprovedResult.structuredContent;
  assert.equal(statusApproved.status, 'approved');
  assert.equal(statusApproved.result.memory_version, 1);

  const recalledResult = await mcp.callTool({
    name: 'memory_recall', arguments: { query: 'name', scope: USER, keys: ['profile.name'] },
  });
  assert.equal(recalledResult.isError, undefined, recalledResult.content?.[0]?.text);
  const recalled = recalledResult.structuredContent;
  assert.equal(recalled.results.length, 1);
  assert.equal(recalled.results[0].content, 'Ada Lovelace');
  assert.equal(recalled.results[0].version, 1);
  assert.equal(recalled.results[0].approval_status, 'approved');
  assert.equal(recalled.results[0].provenance.proposal_id, pending.id);

  const replacePending = await client.propose(JSON.stringify({
    operation: 'replace',
    memory_id: recalled.results[0].record_id,
    expected_version: 1,
    key: 'profile.name',
    scope: USER,
    content: 'Ada King',
    justification: 'user corrected name',
    idempotency_key: 'e2e-replace-key-16ok',
  }));
  assert.equal(replacePending.status, 'pending');

  const stillV1 = await client.recallCanonical(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(stillV1.results[0].version, 1);

  const replaceApproved = lucy.approve(replacePending.id);
  assert.equal(replaceApproved.status, 200);
  assert.equal(replaceApproved.body.result.memory_version, 2);
  assert.equal(replaceApproved.body.result.memory_id, recalled.results[0].record_id);

  const v2 = await client.recallCanonical(JSON.stringify({ query: 'name', scope: USER, keys: ['profile.name'] }));
  assert.equal(v2.results.length, 1);
  assert.equal(v2.results[0].version, 2);
  assert.equal(v2.results[0].content, 'Ada King');
  assert.equal(v2.results[0].record_id, recalled.results[0].record_id);
  assert.equal(v2.results[0].provenance.proposal_id, replacePending.id);

  const stale = client.propose(JSON.stringify({
    operation: 'replace',
    memory_id: recalled.results[0].record_id,
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
