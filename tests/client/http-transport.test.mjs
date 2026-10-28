import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import {
  AuthenticationFailureError,
  MalformedResponseError,
  RateLimitError,
  ValidationFailureError,
  VersionConflictError,
} from '../../src/client/errors.mjs';

const USER = { kind: 'user' };
const now = '2026-08-23T00:00:00.000Z';

function recallBody() {
  return {
    schema_version: '1',
    request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    as_of: now,
    consistency: 'canonical_active',
    scope: USER,
    results: [],
    notices: [],
  };
}

function canonicalRecallBody() {
  return {
    schema_version: 'canonical-recall-1', request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', as_of: now,
    consistency: 'canonical_active', scope: USER, results: [{
      record_id: 'memory-record-a', key: 'profile.name', kind: 'fact', scope: USER, content: 'Ada', status: 'active', persisted: true,
      approval_status: 'controller_approved', version: null,
      provenance: { type: 'lucy_canonical', record_id: 'memory-record-a', proposal_id: null, canonical_payload_hash: null, written_at: now },
    }], notices: [],
  };
}

function pendingBody() {
  return {
    schema_version: '1',
    id: 'proposal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    proposal_version: 1,
    operation: 'create',
    status: 'pending',
    requested: { key: 'profile.name', kind: 'fact', scope: USER },
    relations: [],
    created_at: now,
    expires_at: '2026-08-24T00:00:00.000Z',
    decided_at: null,
    result: null,
  };
}

function errorEnvelope(code, retryable = false) {
  return { schema_version: '1', request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', error: { code, message: code, retryable } };
}

function jsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {},
          releaseLock: () => {},
        };
      },
    },
    text: async () => text,
  };
}

test('HTTP transport maps recall, propose, and status to AM-01 routes', async () => {
  const calls = [];
  const transport = createLucyHttpTransport({
    baseUrl: 'https://www.trylucy.ai/',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
      if (init.method === 'GET') return jsonResponse(200, pendingBody());
      if (String(url).endsWith('/recall')) return jsonResponse(200, recallBody());
      return jsonResponse(200, pendingBody());
    },
    maxRetries: 0,
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await client.recall(JSON.stringify({ query: 'name', scope: USER }));
  await client.propose(JSON.stringify({
    operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
    content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
  }));
  await client.proposalStatus(JSON.stringify({ proposal_id: 'proposal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
  assert.equal(calls[0].url, 'https://www.trylucy.ai/api/lucy/agent-memory/v1/recall');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls.map(({ redirect }) => redirect), ['error', 'error', 'error']);
  assert.equal(calls[1].url, 'https://www.trylucy.ai/api/lucy/agent-memory/v1/proposals');
  assert.equal(calls[1].headers['idempotency-key'], 'idempotency-key-16');
  assert.match(calls[2].url, /\/proposals\/proposal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/);
  assert.equal(calls[2].method, 'GET');
  assert.equal(calls[2].body, null);
});

test('HTTP transport does not auto-retry recall after 503', async () => {
  let n = 0;
  const transport = createLucyHttpTransport({
    baseUrl: 'http://127.0.0.1:9',
    allowInsecureLoopback: true,
    maxRetries: 2,
    sleep: async () => { throw new Error('recall must not sleep to retry'); },
    fetchImpl: async () => {
      n += 1;
      return jsonResponse(503, errorEnvelope('service_unavailable', true), { 'retry-after': '2' });
    },
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.recall(JSON.stringify({ query: 'name', scope: USER })));
  assert.equal(n, 1);
});

test('HTTP transport sends canonical recall once to the existing recall URL with the exact projection header', async () => {
  const calls = [];
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test', maxRetries: 2,
    sleep: async () => { throw new Error('canonical recall must not retry'); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, canonicalRecallBody());
    },
  });
  const client = new AgentMemoryClient({ transport, token: 'tok', permissions: ['memory:read'] });
  await client.recallCanonical(JSON.stringify({ query: 'Ada', scope: USER }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/lucy/agent-memory/v1/recall');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-lucy-memory-projection'], 'canonical-v1');
});

test('HTTP transport does not retry or downgrade canonical recall after 503', async () => {
  let calls = 0;
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test', maxRetries: 2,
    sleep: async () => { throw new Error('canonical recall must not retry'); },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(503, errorEnvelope('service_unavailable', true));
    },
  });
  const client = new AgentMemoryClient({ transport, token: 'tok', permissions: ['memory:read'] });
  await assert.rejects(client.recallCanonical(JSON.stringify({ query: 'Ada', scope: USER })));
  assert.equal(calls, 1);
});

test('HTTP transport does not auto-retry proposal-status after 504', async () => {
  let n = 0;
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 2,
    sleep: async () => { throw new Error('status must not sleep to retry'); },
    fetchImpl: async () => {
      n += 1;
      return jsonResponse(504, errorEnvelope('service_unavailable', true));
    },
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.proposalStatus(JSON.stringify({ proposal_id: 'proposal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })));
  assert.equal(n, 1);
});

test('HTTP transport maps version_conflict and 401', async () => {
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async (url) => {
      if (String(url).includes('/proposals') && !String(url).includes('proposal_')) {
        return jsonResponse(409, errorEnvelope('version_conflict'));
      }
      return jsonResponse(401, errorEnvelope('unauthenticated'));
    },
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.propose(JSON.stringify({
    operation: 'replace', memory_id: 'mem_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expected_version: 1,
    key: 'profile.name', scope: USER, content: 'x', justification: 'y', idempotency_key: 'idempotency-key-16',
  })), VersionConflictError);
  await assert.rejects(client.recall(JSON.stringify({ query: 'n', scope: USER })), AuthenticationFailureError);
});

test('HTTP transport preserves rate-limit Retry-After for the client', async () => {
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse(429, errorEnvelope('rate_limited', true), { 'retry-after': '7' }),
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.recall(JSON.stringify({ query: 'n', scope: USER })), (error) => (
    error instanceof RateLimitError && error.retryAfterMs === 7000
  ));
});

test('HTTP transport rejects invalid base URLs', () => {
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'ftp://x' }), ValidationFailureError);
  assert.throws(() => createLucyHttpTransport({ baseUrl: '' }), ValidationFailureError);
});

test('HTTP transport retries propose on 502 and 504 then stops', async () => {
  let n = 0;
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      n += 1;
      return jsonResponse(n === 1 ? 502 : 504, errorEnvelope('service_unavailable', true));
    },
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.propose(JSON.stringify({
    operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
    content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
  })));
  assert.equal(n, 2);
});

test('HTTP transport default proposal retries preserve serialized body and idempotency key', async () => {
  const attempts = [];
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    sleep: async () => {},
    fetchImpl: async (_url, init) => {
      attempts.push({ body: init.body, idempotencyKey: init.headers['idempotency-key'] });
      return attempts.length < 3
        ? jsonResponse(503, errorEnvelope('service_unavailable', true))
        : jsonResponse(202, pendingBody());
    },
  });
  const client = new AgentMemoryClient({ transport, token: 'tok', permissions: ['memory:propose'] });
  await client.propose(JSON.stringify({
    operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
    content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
  }));
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(({ body }) => body), [attempts[0].body, attempts[0].body, attempts[0].body]);
  assert.deepEqual(attempts.map(({ idempotencyKey }) => idempotencyKey), [
    'idempotency-key-16', 'idempotency-key-16', 'idempotency-key-16',
  ]);
});

test('HTTP transport ignores malformed Retry-After', async () => {
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse(429, errorEnvelope('rate_limited', true), { 'retry-after': 'nope' }),
  });
  const client = new AgentMemoryClient({
    transport, token: 'tok', permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.recall(JSON.stringify({ query: 'n', scope: USER })), RateLimitError);
});

test('HTTP transport refuses cleartext bearer credentials unless loopback is explicitly enabled', async () => {
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'http://127.0.0.1:9' }), ValidationFailureError);
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'http://[::1]:9' }), ValidationFailureError);
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'http://example.test', allowInsecureLoopback: true }), ValidationFailureError);
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'http://127.example.com', allowInsecureLoopback: true }), ValidationFailureError);
  assert.throws(() => createLucyHttpTransport({ baseUrl: 'http://127.evil.test', allowInsecureLoopback: true }), ValidationFailureError);

  let authorization;
  const transport = createLucyHttpTransport({
    baseUrl: 'http://127.0.0.1:9',
    allowInsecureLoopback: true,
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      authorization = init.headers.authorization;
      return jsonResponse(200, recallBody());
    },
  });
  const client = new AgentMemoryClient({ transport, token: 'tok', permissions: ['memory:read'] });
  await client.recall(JSON.stringify({ query: 'name', scope: USER }));
  assert.equal(authorization, 'Bearer tok');
});

function oversizedStreamingResponse(status) {
  const chunks = [new Uint8Array(40_000), new Uint8Array(30_000)];
  const state = { reads: 0, cancelled: false, textCalled: false };
  return {
    state,
    response: {
      status,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks[state.reads];
            state.reads += 1;
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          cancel: async () => { state.cancelled = true; },
          releaseLock: () => {},
        }),
      },
      text: async () => { state.textCalled = true; throw new Error('streaming body was buffered'); },
    },
  };
}

test('HTTP transport enforces the raw streamed body limit for every operation and error response', async () => {
  const cases = [
    ['recall', '{"query":"x"}', 200],
    ['propose', '{"idempotency_key":"stream-limit-16"}', 202],
    ['proposal-status', '{"proposal_id":"proposal_stream"}', 200],
    ['recall', '{"query":"x"}', 500],
  ];
  for (const [operation, payload, status] of cases) {
    const streamed = oversizedStreamingResponse(status);
    const transport = createLucyHttpTransport({
      baseUrl: 'https://example.test',
      maxRetries: 0,
      fetchImpl: async () => streamed.response,
    });
    await assert.rejects(transport({
      operation,
      payload,
      accessToken: 'tok',
      signal: new AbortController().signal,
    }), MalformedResponseError);
    assert.equal(streamed.state.reads, 2);
    assert.equal(streamed.state.cancelled, true);
    assert.equal(streamed.state.textCalled, false);
  }
});

test('HTTP transport rejects non-streaming response implementations before they can buffer a body', async () => {
  let textCalled = false;
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => {
        textCalled = true;
        return 'x'.repeat(70_000_000);
      },
    }),
  });

  await assert.rejects(transport({
    operation: 'recall',
    payload: '{"query":"x"}',
    accessToken: 'tok',
    signal: new AbortController().signal,
  }), MalformedResponseError);
  assert.equal(textCalled, false);
});

test('HTTP transport bounds Retry-After before exposing or waiting on it', async () => {
  let calls = 0;
  const waits = [];
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 1,
    sleep: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(503, errorEnvelope('service_unavailable', true), { 'retry-after': '999999' })
        : jsonResponse(200, pendingBody());
    },
  });
  const client = new AgentMemoryClient({ transport, token: 'tok', permissions: ['memory:propose'] });
  await client.propose(JSON.stringify({
    operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
    content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
  }));
  assert.deepEqual(waits, [60_000]);
});

test('HTTP transport aborts promptly while waiting to retry propose', async () => {
  let startSleep;
  const sleepStarted = new Promise((resolve) => { startSleep = resolve; });
  const controller = new AbortController();
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 1,
    sleep: async () => {
      startSleep();
      await new Promise((resolve) => setTimeout(resolve, 200));
    },
    fetchImpl: async () => jsonResponse(503, errorEnvelope('service_unavailable', true), { 'retry-after': '60' }),
  });
  const pending = transport({
    operation: 'propose',
    payload: JSON.stringify({
      operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
      content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
    }),
    accessToken: 'tok',
    signal: controller.signal,
  });
  await sleepStarted;
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(Date.now() - startedAt < 100);
});

test('HTTP transport passes through x-lucy-memory-operation-id', async () => {
  const opId = `memory-${'ab'.repeat(16)}`;
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse(200, pendingBody(), { 'x-lucy-memory-operation-id': opId }),
  });
  const response = await transport({
    operation: 'propose',
    payload: JSON.stringify({
      operation: 'create', key: 'profile.name', kind: 'fact', scope: USER,
      content: 'Ada', justification: 'user stated', idempotency_key: 'idempotency-key-16',
    }),
    accessToken: 'tok',
    signal: new AbortController().signal,
  });
  assert.equal(response.memoryOperationId, opId);
  assert.equal(response.body.id, pendingBody().id);
});
