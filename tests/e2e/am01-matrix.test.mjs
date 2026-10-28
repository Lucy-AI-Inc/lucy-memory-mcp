import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { listenIsolatedAm01 } from './isolated-am01-authority.mjs';

function clientFor(baseUrl, token) {
  return new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token,
    permissions: ['memory:read', 'memory:propose'],
  });
}

const SCOPES = [
  { kind: 'user' },
  { kind: 'workspace' },
  { kind: 'project', id: 'project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
];
const KINDS = ['fact', 'preference', 'decision', 'rule'];

test('AM-01 scopes and kinds: pending is not recallable; approve then recall', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'matrix-token' });
  t.after(() => lucy.close());
  const client = clientFor(lucy.baseUrl, 'matrix-token');
  let n = 0;
  for (const scope of SCOPES) {
    for (const kind of KINDS) {
      n += 1;
      const key = `matrix.${kind}.${scope.kind}.${n}`;
      const pending = await client.propose(JSON.stringify({
        operation: 'create',
        key,
        kind,
        scope,
        content: `${kind} in ${scope.kind}`,
        justification: 'matrix',
        idempotency_key: `matrix-key-${String(n).padStart(8, '0')}`,
      }));
      assert.equal(pending.status, 'pending');
      const hidden = await client.recall(JSON.stringify({ query: kind, scope, keys: [key] }));
      assert.equal(hidden.results.length, 0);
      lucy.approve(pending.id);
      const visible = await client.recall(JSON.stringify({ query: kind, scope, keys: [key] }));
      assert.equal(visible.results[0].content, `${kind} in ${scope.kind}`);
    }
  }
});

test('AM-01 replace increments version and stale expected_version conflicts', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'replace-token' });
  t.after(() => lucy.close());
  const client = clientFor(lucy.baseUrl, 'replace-token');
  const scope = { kind: 'user' };
  const created = await client.propose(JSON.stringify({
    operation: 'create', key: 'matrix.replace', kind: 'rule', scope,
    content: 'v1', justification: 'create', idempotency_key: 'replace-create-16okxx',
  }));
  lucy.approve(created.id);
  const v1 = await client.recall(JSON.stringify({ query: 'v1', scope, keys: ['matrix.replace'] }));
  const memoryId = v1.results[0].id;
  const replaced = await client.propose(JSON.stringify({
    operation: 'replace', memory_id: memoryId, expected_version: 1,
    key: 'matrix.replace', scope,
    content: 'v2', justification: 'replace', idempotency_key: 'replace-update-16okxx',
  }));
  lucy.approve(replaced.id);
  const v2 = await client.recall(JSON.stringify({ query: 'v2', scope, keys: ['matrix.replace'] }));
  assert.equal(v2.results[0].content, 'v2');
  const stale = await client.propose(JSON.stringify({
    operation: 'replace', memory_id: memoryId, expected_version: 1,
    key: 'matrix.replace', scope,
    content: 'stale', justification: 'stale', idempotency_key: 'replace-stale-16okxxx',
  }));
  assert.equal(stale.status, 'pending');
  const staleApprove = lucy.approve(stale.id);
  assert.equal(staleApprove.status, 409);
});
