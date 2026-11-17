import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  createHostedMcpProductClient,
  HostedMcpProductError,
} from '../../src/mcp/hosted-product.mjs';

const SUBJECT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const REQUEST_ID = 'req_0123456789abcdef0123456789abcdef';
const SERVICE = 'service-credential-000000000000000000000000';
const LEASE = `${'a'.repeat(64)}.${'b'.repeat(64)}`;

async function fakeProduct(t, responder) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const call = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    calls.push(call);
    const result = await responder(call, calls.length - 1);
    const body = JSON.stringify(result.body);
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'x-request-id': call.headers['x-request-id'],
      ...(result.headers ?? {}),
    });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  try {
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('local loopback listeners are unavailable in this sandbox');
      return null;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function client(baseUrl, fetchImpl) {
  return createHostedMcpProductClient({
    baseUrl,
    serviceCredential: SERVICE,
    requestId: REQUEST_ID,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = {
      method: init.method,
      path: new URL(url).pathname,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    calls.push(call);
    const result = await responder(call, calls.length - 1);
    return Response.json(result.body, {
      status: result.status ?? 200,
      headers: { 'x-request-id': REQUEST_ID, ...(result.headers ?? {}) },
    });
  };
  return { calls, fetchImpl };
}

async function productFailure(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof HostedMcpProductError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('local fake PRODUCT sees exact exchange/acquire/release schemas and service authentication', async (t) => {
  const fake = await fakeProduct(t, (call) => {
    if (call.path.endsWith('/credential-exchange')) return { body: {
      access_token: 'lucy_xc1.claims.signature',
      token_type: 'Bearer',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      scopes: ['memory:read'],
    } };
    if (call.path.endsWith('/admission/acquire')) return { body: {
      allowed: true, lease: LEASE, expires_in_ms: 60_000,
    } };
    return { body: { released: true } };
  });
  if (!fake) return;
  const { baseUrl, calls } = fake;
  const product = client(baseUrl);
  const exchanged = await product.exchange({ subject: SUBJECT, workspaceId: WORKSPACE, scope: 'memory:read' });
  assert.deepEqual(exchanged, { accessToken: 'lucy_xc1.claims.signature', scope: 'memory:read' });
  const lease = await product.acquire({ subject: SUBJECT, workspaceId: WORKSPACE, operation: 'memory_recall' });
  assert.equal(lease, LEASE);
  await product.release(lease);

  assert.deepEqual(calls.map(({ path }) => path), [
    '/api/internal/hosted-mcp/v1/credential-exchange',
    '/api/internal/hosted-mcp/v1/admission/acquire',
    '/api/internal/hosted-mcp/v1/admission/release',
  ]);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.authorization, `Bearer ${SERVICE}`);
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['x-request-id'], REQUEST_ID);
  }
  assert.deepEqual(calls[0].body, {
    subject: SUBJECT, workspace_id: WORKSPACE, scopes: ['memory:read'],
  });
  assert.deepEqual(calls[1].body, {
    subject: SUBJECT,
    workspace_id: WORKSPACE,
    operation: 'memory_recall',
    client_id: 'lucy-memory-mcp',
    request_id: REQUEST_ID,
  });
  assert.deepEqual(calls[2].body, { lease: LEASE });
});

test('exchange fails closed on disabled/forbidden, extra fields, over-grant, token reuse, and lifetime', async (t) => {
  const responses = [
    { status: 503, body: { error: 'hosted_mcp_disabled' }, expected: ['hosted_mcp_disabled', 503] },
    { status: 403, body: { error: 'hosted_mcp_forbidden' }, expected: ['insufficient_scope', 403] },
    { body: {
      access_token: 'lucy_xc1.claims.signature', token_type: 'Bearer',
      expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['memory:read'], extra: true,
    }, expected: ['hosted_mcp_unavailable', 503] },
    { body: {
      access_token: 'lucy_xc1.claims.signature', token_type: 'Bearer',
      expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['memory:read', 'memory:propose'],
    }, expected: ['hosted_mcp_unavailable', 503] },
    { body: {
      access_token: SERVICE, token_type: 'Bearer',
      expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['memory:read'],
    }, expected: ['hosted_mcp_unavailable', 503] },
    { body: {
      access_token: 'lucy_xc1.claims.signature', token_type: 'Bearer',
      expires_at: new Date(Date.now() + 901_000).toISOString(), scopes: ['memory:read'],
    }, expected: ['hosted_mcp_unavailable', 503] },
  ];
  const { fetchImpl } = fakeFetch((_call, index) => responses[index]);
  const product = client('https://product.example.test', fetchImpl);
  for (const item of responses) {
    await productFailure(product.exchange({
      subject: SUBJECT, workspaceId: WORKSPACE, scope: 'memory:read',
    }), ...item.expected);
  }
});

test('admission preserves stable 429 details and maps malformed/old-schema responses unavailable', async (t) => {
  const responses = [
    { status: 429, body: { error: 'rate_limit', limit: 'global', retry_after_ms: 250 } },
    { status: 429, body: { error: 'rate_limit', limit: 'scope' } },
    { status: 503, body: { error: 'hosted_mcp_unavailable' } },
    { body: { allowed: true, lease: 'bad', expires_in_ms: 60_000 } },
  ];
  const { fetchImpl } = fakeFetch((_call, index) => responses[index]);
  const product = client('https://product.example.test', fetchImpl);
  for (const [index, expected] of [
    [0, { limit: 'global', retryAfterMs: 250 }],
    [1, { limit: 'scope' }],
  ]) {
    await assert.rejects(product.acquire({ subject: SUBJECT, workspaceId: WORKSPACE, operation: 'memory_recall' }), (error) => {
      assert.equal(error.code, 'rate_limit');
      assert.equal(error.status, 429);
      assert.deepEqual(error.details, expected);
      return true;
    });
    assert.equal(index >= 0, true);
  }
  await productFailure(product.acquire({ subject: SUBJECT, workspaceId: WORKSPACE, operation: 'memory_recall' }), 'hosted_mcp_unavailable', 503);
  await productFailure(product.acquire({ subject: SUBJECT, workspaceId: WORKSPACE, operation: 'memory_recall' }), 'hosted_mcp_unavailable', 503);
});

test('bounded response parsing rejects oversized dependency responses', async () => {
  const product = client('https://product.example.test', async () => new Response(
    `{"padding":"${'x'.repeat(17_000)}"}`,
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': REQUEST_ID } },
  ));
  await productFailure(product.exchange({
    subject: SUBJECT, workspaceId: WORKSPACE, scope: 'memory:read',
  }), 'hosted_mcp_unavailable', 503);
});

test('PRODUCT response must echo the server-owned request ID', async () => {
  const product = client('https://product.example.test', async () => Response.json({
    access_token: 'lucy_xc1.claims.signature',
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    scopes: ['memory:read'],
  }));
  await productFailure(product.exchange({
    subject: SUBJECT, workspaceId: WORKSPACE, scope: 'memory:read',
  }), 'hosted_mcp_unavailable', 503);
});
