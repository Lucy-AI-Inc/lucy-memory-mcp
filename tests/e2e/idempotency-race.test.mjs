import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { LifecycleConflictError } from '../../src/client/errors.mjs';
import { listenIsolatedAm01 } from '../e2e/isolated-am01-authority.mjs';

const USER = { kind: 'user' };
const payload = (content = 'Always cite Lucy IDs') => JSON.stringify({
  operation: 'create', key: 'project.rule', kind: 'rule', scope: USER,
  content, justification: 'team rule', idempotency_key: 'adv-idempotency-16ok',
});

test('same idempotency key and payload replays; changed payload conflicts', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'idem-token' });
  t.after(() => lucy.close());
  const client = new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl: lucy.baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token: 'idem-token',
    permissions: ['memory:read', 'memory:propose'],
  });
  const first = await client.propose(payload());
  const replay = await client.propose(payload());
  assert.equal(replay.id, first.id);
  await assert.rejects(client.propose(payload('Different content')), LifecycleConflictError);
});

test('parallel same-key proposes return one durable proposal id', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'race-token' });
  t.after(() => lucy.close());
  const client = new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl: lucy.baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token: 'race-token',
    permissions: ['memory:read', 'memory:propose'],
  });
  const results = await Promise.all([
    client.propose(payload()),
    client.propose(payload()),
  ]);
  assert.equal(results[0].id, results[1].id);
});
