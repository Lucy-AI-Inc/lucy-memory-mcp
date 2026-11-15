import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  OAuthResourceServerError,
  createOAuthResourceServer,
  createProtectedResourceMetadata,
} from '../../src/mcp/resource-server.mjs';
import { AgentMemoryClient } from '../../src/client/client.mjs';

const RESOURCE = 'https://mcp-beta.example.test/mcp';
const ISSUER = 'https://auth.example.test/';
const JWKS = 'https://auth.example.test/jwks';
const INTROSPECT = 'https://auth.example.test/introspect';
const NOW = 1_800_000_000;
const CALLER_TOKEN = 'caller-secret-token';
const UPSTREAM_TOKEN = 'upstream-agent-memory-token';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const jwk = { ...publicJwk, kid: 'key-1', alg: 'RS256', use: 'sig' };

function token(claims = {}, signingKey = privateKey, header = {}) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'at+jwt', ...header })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: ISSUER,
    sub: 'subject-1',
    aud: RESOURCE,
    resource: RESOURCE,
    scope: 'memory:read memory:propose',
    exp: NOW + 300,
    ...claims,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedClaims}`), signingKey).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
}

function response(body, status = 200) {
  return { status, json: async () => body };
}

function options(overrides = {}) {
  return {
    resource: RESOURCE,
    issuer: ISSUER,
    jwksUri: JWKS,
    introspectionEndpoint: INTROSPECT,
    introspectionAuthorization: 'Basic server-credential',
    now: () => NOW * 1000,
    resolveMembership: async ({ subject }) => ({
      userId: `user:${subject}`,
      workspaceId: 'workspace:authoritative',
    }),
    createHostedClient: async () => new AgentMemoryClient({
      token: UPSTREAM_TOKEN,
      permissions: ['memory:read', 'memory:propose'],
      transport: async () => { throw new Error('unused'); },
    }),
    fetchImpl: async (url, init) => {
      if (url === JWKS) return response({ keys: [jwk] });
      assert.equal(init.headers.authorization, 'Basic server-credential');
      return response({ active: true, sub: 'subject-1' });
    },
    ...overrides,
  };
}

async function failure(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof OAuthResourceServerError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.deepEqual(error.toJSON(), {
      error: code,
      error_description: code === 'insufficient_scope'
        ? 'The access token lacks the required scope.'
        : code === 'temporarily_unavailable'
          ? 'Token validation is temporarily unavailable.'
          : 'The access token is invalid.',
    });
    return true;
  });
}

test('publishes RFC 9728 protected-resource metadata', () => {
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

test('JWT/JWKS validation derives identity and never forwards caller Authorization upstream', async () => {
  const outbound = [];
  const membershipInputs = [];
  const hostedContexts = [];
  const callerToken = token({ workspace_id: 'workspace:attacker' });
  const server = createOAuthResourceServer(options({
    resolveMembership: async (claims) => {
      membershipInputs.push(claims);
      return { userId: 'user:server', workspaceId: 'workspace:server' };
    },
    createHostedClient: async (authContext) => {
      hostedContexts.push(authContext);
      return new AgentMemoryClient({
        token: UPSTREAM_TOKEN,
        permissions: authContext.scopes,
        transport: async (request) => {
          outbound.push(request);
          return {
            status: 200,
            body: {
              schema_version: '1',
              request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              as_of: '2027-01-15T08:00:00.000Z',
              consistency: 'canonical_active',
              scope: { kind: 'user' },
              results: [],
              notices: [],
            },
            byteLength: 200,
          };
        },
      });
    },
  }));
  const authorization = await server.authorize({
    authorization: `Bearer ${callerToken}`,
    operation: 'memory_recall',
    requestId: 'req_safe-1',
  });
  assert.deepEqual(authorization.identity, {
    userId: 'user:server',
    workspaceId: 'workspace:server',
    subject: 'subject-1',
  });
  assert.deepEqual(membershipInputs, [{ issuer: ISSUER, subject: 'subject-1' }]);
  assert.deepEqual(hostedContexts, [{
    subject: 'subject-1',
    workspaceId: 'workspace:server',
    scopes: ['memory:read', 'memory:propose'],
  }]);
  assert(!JSON.stringify(hostedContexts).includes(callerToken));
  await authorization.client.recall(JSON.stringify({ query: 'name', scope: { kind: 'user' } }));
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].accessToken, UPSTREAM_TOKEN);
  assert(!JSON.stringify(outbound).includes(callerToken));
});

test('introspection-only validation accepts an active scoped token', async () => {
  const calls = [];
  const server = createOAuthResourceServer(options({
    jwksUri: undefined,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({
        active: true,
        iss: ISSUER,
        sub: 'subject-1',
        aud: RESOURCE,
        resource: RESOURCE,
        scope: 'memory:read',
        exp: NOW + 60,
      });
    },
  }));
  const authorization = await server.authorize({
    authorization: `Bearer ${CALLER_TOKEN}`,
    operation: 'memory_recall',
  });
  assert.equal(authorization.identity.workspaceId, 'workspace:authoritative');
  assert.equal(calls[0].url, INTROSPECT);
  assert.equal(new URLSearchParams(calls[0].init.body).get('token'), CALLER_TOKEN);
});

test('rejects signature, issuer, audience, resource, time, scope, and revocation failures', async () => {
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const cases = [
    token({}, otherKey),
    token({ iss: 'https://evil.example.test/' }),
    token({ aud: 'other-audience' }),
    token({ resource: 'https://other.example.test/' }),
    token({ exp: NOW - 31 }),
    token({ nbf: NOW + 31 }),
    token({ scope: 'memory:read' }),
  ];
  for (const [index, value] of cases.entries()) {
    const operation = index === cases.length - 1 ? 'memory_propose' : 'memory_recall';
    await failure(createOAuthResourceServer(options()).authorize({
      authorization: `Bearer ${value}`,
      operation,
    }), index === cases.length - 1 ? 'insufficient_scope' : 'invalid_token', index === cases.length - 1 ? 403 : 401);
  }
  await failure(createOAuthResourceServer(options({
    fetchImpl: async (url) => response(url === JWKS ? { keys: [jwk] } : { active: false }),
  })).authorize({
    authorization: `Bearer ${token()}`,
    operation: 'memory_recall',
  }), 'invalid_token', 401);
});

test('fails closed on JWKS, introspection, and malformed bearer failures with redacted logs', async () => {
  const logs = [];
  const failing = createOAuthResourceServer(options({
    logger: (event) => logs.push(event),
    fetchImpl: async () => { throw new Error(`must not log ${CALLER_TOKEN}`); },
  }));
  await failure(failing.authorize({
    authorization: `Bearer ${token()}`,
    operation: 'memory_recall',
    requestId: 'req_safe-2',
  }), 'temporarily_unavailable', 503);
  await failure(createOAuthResourceServer(options()).authorize({
    authorization: `Bearer ${CALLER_TOKEN},Bearer second`,
    operation: 'memory_recall',
  }), 'invalid_token', 401);
  assert.deepEqual(logs, [{
    event: 'oauth_resource_server_failure',
    reason: 'temporarily_unavailable',
    request_id: 'req_safe-2',
  }]);
  assert(!JSON.stringify(logs).includes(CALLER_TOKEN));
});

test('isolates static staging bearer tokens from the OAuth beta resource', async () => {
  assert.throws(() => createOAuthResourceServer(options({
    staticBearer: { token: 'legacy-token', resources: [RESOURCE] },
  })), /must not include the OAuth resource/);
  const server = createOAuthResourceServer(options({
    staticBearer: {
      token: 'legacy-token',
      resources: ['https://legacy-staging.example.test/mcp'],
    },
  }));
  await failure(server.authorize({
    authorization: 'Bearer legacy-token',
    operation: 'memory_recall',
  }), 'invalid_token', 401);
});
