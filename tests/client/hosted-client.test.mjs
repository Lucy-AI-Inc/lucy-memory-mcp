import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedAgentMemoryClient } from '../../src/client/hosted-client.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';
import {
  AuthenticationFailureError,
  AuthorizationFailureError,
  MalformedResponseError,
} from '../../src/client/errors.mjs';
import { LUCY_MEMORY_TOOL_NAMES } from '../../src/mcp/server.mjs';

const CLIENT_TOKEN = 'client-oauth-token';
const SERVICE_TOKEN = 'exchange-service-token';
const EXCHANGED_TOKEN = 'short-lived-lucy-token';
const AUTH_CONTEXT = {
  subject: 'user_123',
  workspaceId: 'workspace_123',
  scopes: ['openid', 'memory:read', 'memory:propose', 'profile'],
};

function exchangeResponse(overrides = {}) {
  return new Response(JSON.stringify({
    access_token: EXCHANGED_TOKEN,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['memory:read', 'memory:propose'],
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function recallResponse() {
  return new Response(JSON.stringify({
    schema_version: '1',
    request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    as_of: '2026-08-23T00:00:00.000Z',
    consistency: 'canonical_active',
    scope: { kind: 'user' },
    results: [],
    notices: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function pendingResponse() {
  return new Response(JSON.stringify({
    schema_version: '1',
    id: 'proposal_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    proposal_version: 1,
    operation: 'create',
    status: 'pending',
    requested: { key: 'profile.name', kind: 'fact', scope: { kind: 'user' } },
    relations: [],
    created_at: '2026-08-23T00:00:00.000Z',
    expires_at: '2026-08-24T00:00:00.000Z',
    decided_at: null,
    result: null,
  }), { status: 202, headers: { 'content-type': 'application/json' } });
}

test('hosted client exchanges validated identity and never passes the client bearer upstream', async () => {
  const exchangeCalls = [];
  const upstreamCalls = [];
  const transport = createLucyHttpTransport({
    baseUrl: 'https://memory.example.test',
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      upstreamCalls.push({ url, init });
      return String(url).endsWith('/recall') ? recallResponse() : pendingResponse();
    },
  });
  const client = await createHostedAgentMemoryClient({
    authContext: AUTH_CONTEXT,
    exchangeUrl: 'https://frontend.example.test/api/lucy/credential-exchange',
    serviceToken: SERVICE_TOKEN,
    transport,
    fetchImpl: async (url, init) => {
      exchangeCalls.push({ url, init });
      return exchangeResponse();
    },
  });

  await client.recall(JSON.stringify({ query: 'name', scope: { kind: 'user' } }));
  await client.propose(JSON.stringify({
    operation: 'create',
    key: 'profile.name',
    kind: 'fact',
    scope: { kind: 'user' },
    content: 'Ada',
    justification: 'user stated',
    idempotency_key: '123e4567-e89b-42d3-a456-426614174000',
  }));

  assert.equal(exchangeCalls.length, 1);
  assert.equal(exchangeCalls[0].init.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
  assert.deepEqual(JSON.parse(exchangeCalls[0].init.body), {
    subject: 'user_123',
    workspace_id: 'workspace_123',
    scopes: ['memory:read', 'memory:propose'],
  });
  assert.equal(exchangeCalls[0].init.body.includes(CLIENT_TOKEN), false);
  assert.equal(upstreamCalls.length, 2);
  assert.deepEqual(upstreamCalls.map(({ init }) => init.headers.authorization), [
    `Bearer ${EXCHANGED_TOKEN}`,
    `Bearer ${EXCHANGED_TOKEN}`,
  ]);
  assert.notEqual(upstreamCalls[0].init.headers.authorization, `Bearer ${CLIENT_TOKEN}`);
  assert.deepEqual(LUCY_MEMORY_TOOL_NAMES, [
    'memory_recall',
    'memory_propose',
    'memory_proposal_status',
  ]);
});

test('hosted client fails closed when exchange is rejected', async () => {
  let upstreamCalls = 0;
  const transport = async () => {
    upstreamCalls += 1;
    throw new Error('must not reach Agent Memory');
  };
  await assert.rejects(createHostedAgentMemoryClient({
    authContext: AUTH_CONTEXT,
    exchangeUrl: 'https://frontend.example.test/exchange',
    serviceToken: SERVICE_TOKEN,
    transport,
    fetchImpl: async () => new Response('{}', { status: 503 }),
  }), AuthenticationFailureError);
  assert.equal(upstreamCalls, 0);
});

test('hosted client rejects passthrough, expired, malformed, and over-scoped exchange responses', async () => {
  const cases = [
    [exchangeResponse({ access_token: SERVICE_TOKEN }), AuthenticationFailureError],
    [exchangeResponse({ expires_at: '2020-01-01T00:00:00.000Z' }), AuthenticationFailureError],
    [exchangeResponse({ expires_at: new Date(Date.now() + 16 * 60_000).toISOString() }), AuthenticationFailureError],
    [exchangeResponse({ token_type: 'DPoP' }), MalformedResponseError],
    [exchangeResponse({ scopes: ['memory:read', 'memory:approve'] }), AuthorizationFailureError],
  ];
  for (const [response, ErrorType] of cases) {
    let upstreamCalls = 0;
    await assert.rejects(createHostedAgentMemoryClient({
      authContext: AUTH_CONTEXT,
      exchangeUrl: 'https://frontend.example.test/exchange',
      serviceToken: SERVICE_TOKEN,
      transport: async () => { upstreamCalls += 1; },
      fetchImpl: async () => response,
    }), ErrorType);
    assert.equal(upstreamCalls, 0);
  }
});

test('hosted auth context is bearer-free', () => {
  assert.deepEqual(Object.keys(AUTH_CONTEXT).sort(), ['scopes', 'subject', 'workspaceId']);
  assert.equal(JSON.stringify(AUTH_CONTEXT).includes(CLIENT_TOKEN), false);
});
