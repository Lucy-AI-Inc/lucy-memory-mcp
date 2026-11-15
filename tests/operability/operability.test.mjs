import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/index.mjs';
import { createOperabilityEmitter, hostedMcpDisabledResponse, versionEvidence } from '../../src/operability.mjs';
import { rollbackPlan, runDrill } from '../../scripts/hosted-mcp-drill.mjs';

const USER = { kind: 'user' };
const recall = { schema_version: '1', request_id: 'req_test', as_of: '2026-08-14T00:00:00.000Z', consistency: 'canonical_active', scope: USER, results: [], notices: [] };

test('telemetry is allowlisted and excludes credentials and memory content', async () => {
  const records = [];
  const emit = createOperabilityEmitter({ write: (record) => records.push(record), workspaceId: 'workspace-secret', workspaceSalt: '0123456789abcdef' });
  const client = new AgentMemoryClient({
    token: 'Bearer secret-token',
    permissions: ['memory:read'],
    onOperabilityEvent: emit,
    transport: async (request) => {
      assert.match(request.accessToken, /secret-token/);
      return { status: 200, body: recall, byteLength: Buffer.byteLength(JSON.stringify(recall)) };
    },
  });
  await client.recall(JSON.stringify({ query: 'private recall query', scope: USER, limit: 1 }));
  const serialized = JSON.stringify(records);
  for (const secret of ['secret-token', 'private recall query', 'workspace-secret', 'authorization', 'results']) assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(records[0].event, 'upstream');
  assert.equal(records[0].outcome, 'success');
});

test('observer failures cannot alter upstream results', async () => {
  for (const onOperabilityEvent of [
    () => { throw new Error('observer failed'); },
    async () => { throw new Error('observer failed'); },
  ]) {
    const client = new AgentMemoryClient({
      token: 'token',
      permissions: ['memory:read'],
      onOperabilityEvent,
      transport: async () => ({ status: 200, body: recall, byteLength: Buffer.byteLength(JSON.stringify(recall)) }),
    });
    assert.deepEqual(await client.recall(JSON.stringify({ query: 'safe', scope: USER, limit: 1 })), recall);
  }
});

test('auth, throttle, and upstream errors emit bounded metrics only', () => {
  const records = [];
  const emit = createOperabilityEmitter({ write: (record) => records.push(record) });
  emit({ event: 'upstream', operation: 'recall', outcome: 'error', duration_ms: 2, error_code: 'authentication_failure', status: 401 });
  emit({ event: 'upstream', operation: 'recall', outcome: 'error', duration_ms: 3, error_code: 'rate_limit', status: 429, throttled: true });
  assert.equal(records[0].AuthenticationFailure, 1);
  assert.equal(records[0].UpstreamError, 1);
  assert.equal(records[1].Throttled, 1);
  assert.equal(records[1].status, 429);
});

test('package and image evidence are independent and validated', () => {
  assert.deepEqual(versionEvidence({ LUCY_MCP_IMAGE_DIGEST: 'not-a-digest', LUCY_MCP_IMAGE_GIT_SHA: 'bad' }), { package_version: '0.1.3' });
  const digest = `sha256:${'a'.repeat(64)}`;
  const evidence = versionEvidence({ LUCY_MCP_IMAGE_DIGEST: digest, LUCY_MCP_IMAGE_GIT_SHA: 'b'.repeat(40) });
  assert.equal(evidence.package_version, '0.1.3');
  assert.equal(evidence.image_digest, digest);
});

test('kill switch and rollback drill are stable and chat-safe', () => {
  assert.equal(hostedMcpDisabledResponse().status, 503);
  assert.equal(runDrill().drill, 'passed');
  assert.throws(() => rollbackPlan({
    service: 'chat',
    currentImage: `x@sha256:${'a'.repeat(64)}`,
    previousImage: `x@sha256:${'b'.repeat(64)}`,
  }), /hosted MCP/);
});
