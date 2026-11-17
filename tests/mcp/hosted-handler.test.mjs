import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createHostedMcpHandler } from '../../src/mcp/hosted-handler.mjs';
import { LUCY_MEMORY_TOOL_NAMES } from '../../src/mcp/server.mjs';

const RESOURCE = 'https://mcp-beta.example.test/mcp';
const ISSUER = 'https://auth.example.test/';
const JWKS = `${ISSUER}jwks`;
const INTROSPECTION = `${ISSUER}introspect`;
const PRODUCT = 'https://product.example.test';
const SUBJECT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const SERVICE = 'service-credential-000000000000000000000000';
const LOG_KEY = 'log-hmac-key-00000000000000000000000000';
const LEASE = `${'a'.repeat(64)}.${'b'.repeat(64)}`;
const REQUEST_ID = `req_${'01'.repeat(16)}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-rsa', alg: 'RS256', use: 'sig' };

test('hosted surface is the shared exact three-tool surface', () => {
  assert.deepEqual(LUCY_MEMORY_TOOL_NAMES, [
    'memory_recall',
    'memory_propose',
    'memory_proposal_status',
  ]);
});

const ENV = Object.freeze({
  HOSTED_MCP_ENABLED: 'true',
  HOSTED_MCP_CANONICAL_URL: RESOURCE,
  HOSTED_MCP_PRODUCT_BASE_URL: PRODUCT,
  HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: SERVICE,
  HOSTED_MCP_OAUTH_ISSUER: ISSUER,
  HOSTED_MCP_OAUTH_JWKS_URL: JWKS,
  HOSTED_MCP_OAUTH_INTROSPECTION_URL: INTROSPECTION,
  HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION: 'Basic resource-server-test',
  HOSTED_MCP_LOG_HASH_KEY: LOG_KEY,
});

function accessToken(claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-rsa', typ: 'at+jwt' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: SUBJECT,
    workspace_id: WORKSPACE,
    aud: RESOURCE,
    resource: RESOURCE,
    scope: 'memory:read memory:propose',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })).toString('base64url');
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

function canonicalRecall() {
  return {
    schema_version: 'canonical-recall-1',
    request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    as_of: '2026-11-16T00:00:00.000Z',
    consistency: 'canonical_active',
    scope: { kind: 'user' },
    results: [],
    notices: [],
  };
}

function productJson(body, init = {}) {
  return Response.json(body, {
    ...init,
    headers: { 'x-request-id': REQUEST_ID, ...(init.headers ?? {}) },
  });
}

function mcpBody(method, params, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

function mcpRequest(body, { token = accessToken(), headers = {}, path = '/mcp' } = {}) {
  return new Request(`https://mcp-beta.example.test${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  });
}

function fakeDependencies(overrides = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).startsWith(PRODUCT) ? new URL(url).pathname : String(url);
    calls.push({ url: String(url), path, init });
    if (url === JWKS) return Response.json({ keys: [jwk] });
    if (url === INTROSPECTION) return Response.json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE });
    if (path.endsWith('/credential-exchange')) return productJson({
      access_token: 'lucy_xc1.test-claims.test-signature',
      token_type: 'Bearer',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      scopes: ['memory:read'],
    });
    if (path.endsWith('/admission/acquire')) return productJson({ allowed: true, lease: LEASE, expires_in_ms: 60_000 });
    if (path.endsWith('/admission/release')) return productJson({ released: true });
    if (path.endsWith('/api/lucy/agent-memory/v1/recall')) return Response.json(canonicalRecall());
    throw new Error(`unexpected URL ${url}`);
  };
  return {
    calls,
    logs,
    handler: createHostedMcpHandler({
      environment: ENV,
      fetchImpl: overrides.fetchImpl ?? fetchImpl,
      logger: (entry) => logs.push(entry),
      random: () => Buffer.alloc(16, 1),
    }),
  };
}

test('health, route methods, and RFC 9728 metadata remain truthful while disabled', async () => {
  const logs = [];
  const disabled = { ...ENV, HOSTED_MCP_ENABLED: 'false' };
  const handler = createHostedMcpHandler({ environment: disabled, logger: (event) => logs.push(event) });
  const health = await handler(new Request('https://mcp-beta.example.test/healthz'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'disabled', enabled: false });
  assert.match(health.headers.get('x-request-id'), /^req_[a-f0-9]{32}$/);
  const healthHead = await handler(new Request('https://mcp-beta.example.test/healthz', { method: 'HEAD' }));
  assert.equal(healthHead.status, 200);
  assert.equal(healthHead.headers.get('content-length'), health.headers.get('content-length'));
  assert.equal(await healthHead.text(), '');

  const metadata = await handler(new Request('https://mcp-beta.example.test/.well-known/oauth-protected-resource/mcp'));
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['memory:read', 'memory:propose'],
    bearer_methods_supported: ['header'],
  });
  assert.equal(metadata.headers.get('cache-control'), 'public, max-age=300');
  const rootMetadata = await handler(new Request('https://mcp-beta.example.test/.well-known/oauth-protected-resource'));
  assert.deepEqual(await rootMetadata.json(), {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['memory:read', 'memory:propose'],
    bearer_methods_supported: ['header'],
  });
  const metadataHead = await handler(new Request(
    'https://mcp-beta.example.test/.well-known/oauth-protected-resource/mcp',
    { method: 'HEAD' },
  ));
  assert.equal(metadataHead.status, 200);
  assert.equal(metadataHead.headers.get('content-length'), metadata.headers.get('content-length'));
  assert.equal(await metadataHead.text(), '');
  const getMcp = await handler(new Request(RESOURCE));
  assert.equal(getMcp.status, 405);
  assert.equal(getMcp.headers.get('allow'), 'POST');
  assert.equal((await handler(new Request('https://mcp-beta.example.test/missing'))).status, 404);
  assert.equal(logs.every((entry) => entry.event === 'hosted_mcp_request'), true);
});

test('missing OAuth bearer returns the exact path-suffixed challenge without provider calls', async () => {
  let calls = 0;
  const handler = createHostedMcpHandler({
    environment: ENV,
    fetchImpl: async () => { calls += 1; throw new Error('must not call provider'); },
    logger: () => {},
  });
  const request = mcpRequest(mcpBody('ping'), { token: '' });
  request.headers.delete('authorization');
  const response = await handler(request);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'invalid_token' });
  assert.equal(response.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://mcp-beta.example.test/.well-known/oauth-protected-resource/mcp"');
  assert.equal(calls, 0);
});

test('authenticated tools/list uses the shared three-tool server without PRODUCT calls', async () => {
  const { handler, calls } = fakeDependencies();
  const response = await handler(mcpRequest(mcpBody('tools/list')));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map(({ name }) => name), [
    'memory_recall',
    'memory_propose',
    'memory_proposal_status',
  ]);
  assert.equal(calls.some(({ url }) => url.startsWith(PRODUCT)), false);
});

test('wrong resource, revoked token, and provider outage fail before PRODUCT', async () => {
  for (const [token, introspection, expected] of [
    [accessToken({ resource: 'https://wrong.example/mcp' }), { active: true }, 401],
    [accessToken(), { active: false }, 401],
  ]) {
    let productCalls = 0;
    const handler = createHostedMcpHandler({
      environment: ENV,
      logger: () => {},
      random: () => Buffer.alloc(16, 1),
      fetchImpl: async (url) => {
        if (url === JWKS) return Response.json({ keys: [jwk] });
        if (url === INTROSPECTION) return Response.json(introspection);
        productCalls += 1;
        throw new Error('PRODUCT must not be reached');
      },
    });
    const response = await handler(mcpRequest(mcpBody('tools/list'), { token }));
    assert.equal(response.status, expected);
    assert.equal(productCalls, 0);
  }

  const outage = createHostedMcpHandler({
    environment: ENV,
    logger: () => {},
    fetchImpl: async (url) => {
      if (url === JWKS) return Response.json({ keys: [jwk] });
      throw new Error('introspection unavailable');
    },
  });
  const unavailable = await outage(mcpRequest(mcpBody('tools/list')));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'hosted_mcp_unavailable' });
  assert.equal(unavailable.headers.has('www-authenticate'), false);
});

test('8 KiB raw body cap and exact Origin allowlist reject before auth or PRODUCT', async () => {
  let calls = 0;
  const handler = createHostedMcpHandler({
    environment: { ...ENV, HOSTED_MCP_ALLOWED_ORIGINS: 'https://allowed.example' },
    fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
    logger: () => {},
  });
  const oversized = await handler(mcpRequest('x'.repeat(8_193)));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request_too_large', max_bytes: 8192 });
  const wrongOrigin = await handler(mcpRequest(mcpBody('ping'), { headers: { origin: 'https://wrong.example' } }));
  assert.equal(wrongOrigin.status, 403);
  assert.equal(calls, 0);

  const boundaryDependencies = fakeDependencies();
  const base = mcpBody('ping');
  const boundary = `${' '.repeat(8_192 - Buffer.byteLength(base))}${base}`;
  const boundaryResponse = await boundaryDependencies.handler(mcpRequest(boundary));
  assert.notEqual(boundaryResponse.status, 413);

  const controller = new AbortController();
  controller.abort();
  const aborted = await boundaryDependencies.handler(new Request(RESOURCE, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken()}`, 'content-type': 'application/json' },
    body: mcpBody('ping'),
    signal: controller.signal,
  }));
  assert.equal(aborted.status, 503);
  assert.deepEqual(await aborted.json(), { error: 'hosted_mcp_unavailable' });
});

test('tool request exchanges one scope, acquires shared admission, calls upstream, and releases in finally', async () => {
  const { handler, calls, logs } = fakeDependencies();
  const response = await handler(mcpRequest(mcpBody('tools/call', {
    name: 'memory_recall',
    arguments: { query: 'profile', scope: { kind: 'user' } },
  }), { headers: { 'x-lucy-workspace-id': '33333333-3333-3333-3333-333333333333' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.result.structuredContent.consistency, 'canonical_active');

  const exchange = calls.find(({ path }) => path.endsWith('/credential-exchange'));
  assert.deepEqual(JSON.parse(exchange.init.body), {
    subject: SUBJECT,
    workspace_id: WORKSPACE,
    scopes: ['memory:read'],
  });
  assert.equal(exchange.init.headers.authorization, `Bearer ${SERVICE}`);
  const upstream = calls.find(({ path }) => path.endsWith('/api/lucy/agent-memory/v1/recall'));
  assert.equal(upstream.init.headers.authorization, 'Bearer lucy_xc1.test-claims.test-signature');
  assert.equal(upstream.init.headers['x-lucy-workspace-id'], undefined);
  assert.equal(calls.some(({ path }) => path.endsWith('/admission/release')), true);

  const terminal = logs.at(-1);
  assert.equal(terminal.tool, 'memory_recall');
  assert.equal(terminal.http_status, 200);
  assert.equal(terminal.upstream_status, 200);
  assert.equal(terminal.admission_outcome, 'allowed');
  assert.match(terminal.subject_hash, /^h1:/);
  const serialized = JSON.stringify(logs);
  for (const forbidden of [accessToken(), SERVICE, 'lucy_xc1.test-claims.test-signature', 'profile', LEASE]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('read-only token gets exact insufficient-scope challenge before exchange/admission', async () => {
  const calls = [];
  const token = accessToken({ scope: 'memory:read' });
  const handler = createHostedMcpHandler({
    environment: ENV,
    logger: () => {},
    random: () => Buffer.alloc(16, 1),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return url === JWKS
        ? Response.json({ keys: [jwk] })
        : Response.json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE });
    },
  });
  const response = await handler(mcpRequest(mcpBody('tools/call', {
    name: 'memory_propose', arguments: {},
  }), { token }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'insufficient_scope' });
  assert.equal(response.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://mcp-beta.example.test/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="memory:propose"');
  assert.equal(calls.some((url) => url.startsWith(PRODUCT)), false);
});

test('admission stable errors preserve global/scope limit and release is attempted on MCP failure', async () => {
  for (const limit of ['global', 'scope']) {
    const base = fakeDependencies();
    const handler = createHostedMcpHandler({
      environment: ENV,
      logger: () => {},
      random: () => Buffer.alloc(16, 1),
      fetchImpl: async (url, init) => {
        const path = String(url).startsWith(PRODUCT) ? new URL(url).pathname : String(url);
        if (path.endsWith('/admission/acquire')) {
          return productJson({ error: 'rate_limit', limit, retry_after_ms: 250 }, { status: 429 });
        }
        return base.calls.length >= 0 && (url === JWKS
          ? Response.json({ keys: [jwk] })
          : url === INTROSPECTION
            ? Response.json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE })
            : path.endsWith('/credential-exchange')
              ? productJson({
                access_token: 'lucy_xc1.test.claim', token_type: 'Bearer',
                expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['memory:read'],
              })
              : Promise.reject(new Error('unexpected')));
      },
    });
    const response = await handler(mcpRequest(mcpBody('tools/call', {
      name: 'memory_recall', arguments: { query: 'x', scope: { kind: 'user' } },
    })));
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limit', limit, retry_after_ms: 250 });
    assert.equal(response.headers.get('retry-after'), '1');
  }
});

test('an acquired lease is released even when MCP transport handling fails', async () => {
  const base = fakeDependencies();
  const released = [];
  const handler = createHostedMcpHandler({
    environment: ENV,
    logger: () => {},
    random: () => Buffer.alloc(16, 1),
    fetchImpl: async (url, init) => {
      const path = String(url).startsWith(PRODUCT) ? new URL(url).pathname : String(url);
      if (path.endsWith('/admission/release')) {
        released.push(JSON.parse(init.body).lease);
        return productJson({ released: true });
      }
      if (url === JWKS) return Response.json({ keys: [jwk] });
      if (url === INTROSPECTION) return Response.json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE });
      if (path.endsWith('/credential-exchange')) return productJson({
        access_token: 'lucy_xc1.test.claim', token_type: 'Bearer',
        expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['memory:read'],
      });
      if (path.endsWith('/admission/acquire')) return productJson({ allowed: true, lease: LEASE, expires_in_ms: 60_000 });
      return base.fetchImpl?.(url, init);
    },
    transportFactory: () => ({
      start: async () => {},
      close: async () => {},
      handleRequest: async () => { throw new Error('transport failure'); },
    }),
  });
  const response = await handler(mcpRequest(mcpBody('tools/call', {
    name: 'memory_recall', arguments: { query: 'x', scope: { kind: 'user' } },
  })));
  assert.equal(response.status, 503);
  assert.deepEqual(released, [LEASE]);
});

test('PRODUCT disabled and unavailable responses retain stable public codes', async () => {
  for (const [productBody, expectedBody] of [
    [{ error: 'hosted_mcp_disabled' }, { error: 'hosted_mcp_disabled' }],
    [{ error: 'hosted_mcp_unavailable' }, { error: 'hosted_mcp_unavailable' }],
  ]) {
    const handler = createHostedMcpHandler({
      environment: ENV,
      logger: () => {},
      random: () => Buffer.alloc(16, 1),
      fetchImpl: async (url) => {
        const path = String(url).startsWith(PRODUCT) ? new URL(url).pathname : String(url);
        if (url === JWKS) return Response.json({ keys: [jwk] });
        if (url === INTROSPECTION) return Response.json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE });
        if (path.endsWith('/credential-exchange')) return productJson(productBody, { status: 503 });
        throw new Error('must stop at exchange');
      },
    });
    const response = await handler(mcpRequest(mcpBody('tools/call', {
      name: 'memory_recall', arguments: { query: 'x', scope: { kind: 'user' } },
    })));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), expectedBody);
  }
});

test('MCP kill switch and invalid enabled configuration use stable 503s while health is truthful', async () => {
  const disabled = createHostedMcpHandler({
    environment: { HOSTED_MCP_ENABLED: 'false' }, logger: () => {},
  });
  const denied = await disabled(mcpRequest(mcpBody('ping')));
  assert.equal(denied.status, 503);
  assert.deepEqual(await denied.json(), { error: 'hosted_mcp_disabled' });

  const invalid = createHostedMcpHandler({
    environment: { HOSTED_MCP_ENABLED: 'true' }, logger: () => {},
  });
  const health = await invalid(new Request('https://example.test/healthz'));
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { status: 'misconfigured', enabled: false });
});

test('guarded static staging mode is isolated from OAuth metadata and production', async () => {
  const staticEnv = {
    HOSTED_MCP_ENABLED: 'true',
    HOSTED_MCP_AUTH_MODE: 'staging-static-bearer',
    HOSTED_MCP_CANONICAL_URL: 'https://mcp-preview.example.test/mcp',
    HOSTED_MCP_PRODUCT_BASE_URL: PRODUCT,
    HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: SERVICE,
    HOSTED_MCP_LOG_HASH_KEY: LOG_KEY,
    HOSTED_MCP_STAGING_STATIC_BEARER: 'preview-only-token',
    HOSTED_MCP_STAGING_STATIC_SUBJECT: SUBJECT,
    HOSTED_MCP_STAGING_STATIC_WORKSPACE_ID: WORKSPACE,
    HOSTED_MCP_STAGING_STATIC_SCOPES: 'memory:read',
    VERCEL_ENV: 'preview',
  };
  const handler = createHostedMcpHandler({ environment: staticEnv, logger: () => {} });
  const metadata = await handler(new Request('https://mcp-preview.example.test/.well-known/oauth-protected-resource'));
  assert.equal(metadata.status, 404);
  const ping = await handler(mcpRequest(mcpBody('ping'), {
    token: 'preview-only-token',
    path: '/mcp',
  }));
  assert.equal(ping.status, 200);
  const rejected = await handler(mcpRequest(mcpBody('ping'), {
    token: 'wrong-preview-token',
    path: '/mcp',
  }));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('www-authenticate'), 'Bearer error="invalid_token"');
  assert.doesNotMatch(rejected.headers.get('www-authenticate'), /resource_metadata/);
  const production = createHostedMcpHandler({
    environment: { ...staticEnv, VERCEL_ENV: 'production' }, logger: () => {},
  });
  const health = await production(new Request('https://mcp-preview.example.test/healthz'));
  assert.equal(health.status, 503);
});
