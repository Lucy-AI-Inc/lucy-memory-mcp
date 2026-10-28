import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { listenIsolatedAm01 } from '../e2e/isolated-am01-authority.mjs';

const USER = { kind: 'user' };

function clientFor(baseUrl, token) {
  return new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token,
    permissions: ['memory:read', 'memory:propose'],
  });
}

test('two isolated authorities cannot recall each other', async (t) => {
  const a = await listenIsolatedAm01({ token: 'tenant-a-token' });
  const b = await listenIsolatedAm01({ token: 'tenant-b-token' });
  t.after(() => Promise.all([a.close(), b.close()]));
  const clientA = clientFor(a.baseUrl, 'tenant-a-token');
  const clientB = clientFor(b.baseUrl, 'tenant-b-token');
  const pending = await clientA.propose(JSON.stringify({
    operation: 'create', key: 'secret.note', kind: 'fact', scope: USER,
    content: 'Tenant A only', justification: 'isolation', idempotency_key: 'iso-tenant-a-16ok',
  }));
  a.approve(pending.id);
  const recalledA = await clientA.recall(JSON.stringify({ query: 'Tenant', scope: USER, keys: ['secret.note'] }));
  assert.equal(recalledA.results[0].content, 'Tenant A only');
  const recalledB = await clientB.recall(JSON.stringify({ query: 'Tenant', scope: USER, keys: ['secret.note'] }));
  assert.equal(recalledB.results.length, 0);
});

test('wrong token cannot read another isolated authority', async () => {
  const a = await listenIsolatedAm01({ token: 'tenant-a-token' });
  try {
    const stranger = clientFor(a.baseUrl, 'tenant-b-token');
    await assert.rejects(stranger.recall(JSON.stringify({ query: 'x', scope: USER })));
  } finally {
    await a.close();
  }
});

test('project scopes do not leak across authorized project ids', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'tenant-a-token' });
  t.after(() => lucy.close());
  const client = clientFor(lucy.baseUrl, 'tenant-a-token');
  const projectA = { kind: 'project', id: 'project_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const projectB = { kind: 'project', id: 'project_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
  const pending = await client.propose(JSON.stringify({
    operation: 'create', key: 'decision.ship', kind: 'decision', scope: projectA,
    content: 'Ship A only', justification: 'project isolation', idempotency_key: 'iso-project-a-16ok',
  }));
  lucy.approve(pending.id);
  const inA = await client.recall(JSON.stringify({ query: 'Ship', scope: projectA, keys: ['decision.ship'] }));
  assert.equal(inA.results[0].content, 'Ship A only');
  const inB = await client.recall(JSON.stringify({ query: 'Ship', scope: projectB, keys: ['decision.ship'] }));
  assert.equal(inB.results.length, 0);
});
