import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import { listenIsolatedAm01 } from './isolated-am01-authority.mjs';

test('Unicode memory content survives propose, approve, and recall', async (t) => {
  const lucy = await listenIsolatedAm01({ token: 'unicode-token' });
  t.after(() => lucy.close());
  const client = new AgentMemoryClient({
    transport: createLucyHttpTransport({ baseUrl: lucy.baseUrl, allowInsecureLoopback: true, maxRetries: 0 }),
    token: 'unicode-token',
    permissions: ['memory:read', 'memory:propose'],
  });
  const content = 'Ada \u2665 Lovelace \u2014 \u042e\u043d\u0438\u043a\u043e\u0434';
  const pending = await client.propose(JSON.stringify({
    operation: 'create', key: 'profile.unicode', kind: 'fact', scope: { kind: 'user' },
    content, justification: 'unicode', idempotency_key: 'unicode-key-16okayx',
  }));
  lucy.approve(pending.id);
  const recalled = await client.recall(JSON.stringify({
    query: 'Ada', scope: { kind: 'user' }, keys: ['profile.unicode'],
  }));
  assert.equal(recalled.results[0].content, content);
});
