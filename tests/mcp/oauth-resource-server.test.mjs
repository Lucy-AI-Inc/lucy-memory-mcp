import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  OAuthResourceServerError,
  createOAuthResourceServer,
  createProtectedResourceMetadata,
  requireHostedMcpScope,
} from '../../src/mcp/resource-server.mjs';

const RESOURCE = 'https://mcp-beta.example.test/mcp';
const ISSUER = 'https://auth.example.test/';
const JWKS = 'https://auth.example.test/jwks';
const INTROSPECT = 'https://auth.example.test/introspect';
const NOW = 1_800_000_000;
const SUBJECT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';
const { privateKey: rsaPrivate, publicKey: rsaPublic } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: ecPrivate, publicKey: ecPublic } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaJwk = { ...rsaPublic.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
const ecJwk = { ...ecPublic.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig', key_ops: ['verify'] };

function jwt(claims = {}, { algorithm = 'RS256', key = rsaPrivate, kid = 'rsa-1' } = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: algorithm, kid, typ: 'at+jwt' })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: SUBJECT,
    workspace_id: WORKSPACE,
    aud: RESOURCE,
    resource: RESOURCE,
    scope: 'memory:read memory:propose',
    exp: NOW + 300,
    ...claims,
  })).toString('base64url');
  const input = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = algorithm === 'ES256'
    ? sign('SHA256', input, { key, dsaEncoding: 'ieee-p1363' })
    : sign('RSA-SHA256', input, key);
  return `${encodedHeader}.${encodedClaims}.${signature.toString('base64url')}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function options(overrides = {}) {
  return {
    resource: RESOURCE,
    issuer: ISSUER,
    jwksUri: JWKS,
    introspectionEndpoint: INTROSPECT,
    introspectionAuthorization: 'Basic provider-resource-credential',
    now: () => NOW * 1000,
    fetchImpl: async (url, init) => {
      if (url === JWKS) return json({ keys: [rsaJwk, ecJwk] });
      assert.equal(url, INTROSPECT);
      assert.equal(init.headers.authorization, 'Basic provider-resource-credential');
      return json({ active: true, sub: SUBJECT, workspace_id: WORKSPACE });
    },
    ...overrides,
  };
}

async function failure(promise, code, status, missing = false) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof OAuthResourceServerError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.missing, missing);
    return true;
  });
}

test('publishes the exact RFC 9728 protected-resource metadata document', () => {
  assert.deepEqual(createProtectedResourceMetadata({
    resource: RESOURCE,
    authorizationServers: [ISSUER],
  }), {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ['memory:read', 'memory:propose'],
    bearer_methods_supported: ['header'],
  });
});

test('RS256 validation returns only the signed bearer-free subject/workspace/scopes', async () => {
  const calls = [];
  const token = jwt();
  const server = createOAuthResourceServer(options({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url === JWKS
        ? json({ keys: [rsaJwk] })
        : json({
          active: true,
          iss: ISSUER,
          sub: SUBJECT,
          workspace_id: WORKSPACE,
          aud: RESOURCE,
          resource: RESOURCE,
          scope: ['memory:read', 'memory:propose'],
        });
    },
  }));
  const context = await server.authenticate({ authorization: `Bearer ${token}`, requestId: 'req_safe-1' });
  assert.deepEqual(context, {
    subject: SUBJECT,
    workspaceId: WORKSPACE,
    scopes: ['memory:read', 'memory:propose'],
  });
  assert.deepEqual(Object.keys(context).sort(), ['scopes', 'subject', 'workspaceId']);
  assert.equal(calls.length, 2);
  assert.equal(new URLSearchParams(calls[1].init.body).get('token'), token);
  assert.equal(JSON.stringify(context).includes(token), false);
});

test('root issuer identity is preserved exactly without adding a trailing slash', async () => {
  const issuer = 'https://auth.example.test';
  const server = createOAuthResourceServer(options({ issuer }));
  assert.deepEqual(server.metadata.authorization_servers, [issuer]);
  assert.equal((await server.authenticate({
    authorization: `Bearer ${jwt({ iss: issuer })}`,
  })).workspaceId, WORKSPACE);
  await failure(server.authenticate({
    authorization: `Bearer ${jwt({ iss: `${issuer}/` })}`,
  }), 'invalid_token', 401);
});

test('ES256 accepts the JOSE 64-byte P1363 signature form', async () => {
  const context = await createOAuthResourceServer(options()).authenticate({
    authorization: `Bearer ${jwt({}, { algorithm: 'ES256', key: ecPrivate, kid: 'ec-1' })}`,
  });
  assert.equal(context.workspaceId, WORKSPACE);
});

test('scope enforcement is per tool and never narrows tools/list advertisement', async () => {
  const context = await createOAuthResourceServer(options()).authenticate({
    authorization: `Bearer ${jwt({ scope: 'memory:read' })}`,
  });
  assert.equal(requireHostedMcpScope(context, 'memory_recall'), 'memory:read');
  assert.equal(requireHostedMcpScope(context, 'memory_proposal_status'), 'memory:read');
  await failure(Promise.resolve().then(() => requireHostedMcpScope(context, 'memory_propose')), 'insufficient_scope', 403);
});

test('rejects malformed, unsigned, wrong-claim, time, UUID, and signature inputs', async () => {
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const cases = [
    'opaque-token',
    jwt({}, { key: otherKey }),
    jwt({ iss: 'https://evil.example.test/' }),
    jwt({ aud: 'https://other.example.test/mcp' }),
    jwt({ resource: 'https://other.example.test/mcp' }),
    jwt({ sub: 'not-a-uuid' }),
    jwt({ workspace_id: 'not-a-uuid' }),
    jwt({ exp: NOW - 31 }),
    jwt({ nbf: NOW + 31 }),
  ];
  for (const value of cases) {
    await failure(createOAuthResourceServer(options()).authenticate({
      authorization: `Bearer ${value}`,
    }), 'invalid_token', 401);
  }
});

test('JWKS selection requires exactly one alg-compatible signing key', async () => {
  for (const keys of [
    [rsaJwk, { ...rsaJwk }],
    [rsaJwk, { ...rsaJwk, alg: 'ES256' }],
    [{ ...rsaJwk, use: 'enc' }],
    [{ ...rsaJwk, key_ops: ['encrypt'] }],
    [{ ...rsaJwk, alg: 'ES256' }],
  ]) {
    await failure(createOAuthResourceServer(options({
      fetchImpl: async (url) => json(url === JWKS ? { keys } : { active: true }),
    })).authenticate({ authorization: `Bearer ${jwt()}` }), 'invalid_token', 401);
  }
});

test('mandatory introspection rejects revocation and any disagreement with signed claims', async () => {
  const disagreements = [
    { active: false },
    { active: true, sub: '33333333-3333-3333-3333-333333333333' },
    { active: true, workspace_id: '33333333-3333-3333-3333-333333333333' },
    { active: true, iss: 'https://evil.example.test/' },
    { active: true, aud: 'wrong' },
    { active: true, resource: 'wrong' },
    { active: true, scope: 'memory:read' },
  ];
  for (const active of disagreements) {
    await failure(createOAuthResourceServer(options({
      fetchImpl: async (url) => json(url === JWKS ? { keys: [rsaJwk] } : active),
    })).authenticate({ authorization: `Bearer ${jwt()}` }), 'invalid_token', 401);
  }
});

test('missing and malformed authorization are distinct internally but public invalid_token', async () => {
  const server = createOAuthResourceServer(options());
  await failure(server.authenticate({}), 'invalid_token', 401, true);
  await failure(server.authenticate({ authorization: 'Basic nope' }), 'invalid_token', 401);
  await failure(server.authenticate({ authorization: `Bearer ${jwt()}, Bearer second` }), 'invalid_token', 401);
});

test('provider failures fail closed and logs contain no bearer or claims', async () => {
  const events = [];
  const token = jwt();
  const server = createOAuthResourceServer(options({
    logger: (event) => events.push(event),
    fetchImpl: async () => { throw new Error('provider unavailable'); },
  }));
  await failure(server.authenticate({
    authorization: `Bearer ${token}`,
    requestId: 'req_safe-2',
  }), 'temporarily_unavailable', 503);
  assert.deepEqual(events, [{
    event: 'oauth_resource_server_failure',
    reason: 'temporarily_unavailable',
    request_id: 'req_safe-2',
  }]);
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.equal(JSON.stringify(events).includes(SUBJECT), false);
});

test('resource server requires both JWKS and fail-closed introspection configuration', () => {
  assert.throws(() => createOAuthResourceServer(options({ jwksUri: undefined })));
  assert.throws(() => createOAuthResourceServer(options({ introspectionEndpoint: undefined })));
  assert.throws(() => createOAuthResourceServer(options({ algorithms: ['HS256'] })));
});
