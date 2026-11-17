import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createTestOAuthAuthority } from '../../scripts/e2e/test-oauth-as.mjs';
import { pkceChallenge } from '../../scripts/e2e/lib.mjs';
import { createOAuthResourceServer } from '../../src/mcp/resource-server.mjs';

const BIND = 'binding-credential-00000000000000000000000';
const INTROSPECTION = 'Basic introspection-credential-0000000000000000';
const CONTROL = 'control-credential-00000000000000000000000';
const SUBJECT = '11111111-1111-1111-1111-111111111111';
const WORKSPACE = '22222222-2222-2222-2222-222222222222';

function invoke(authority, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = path;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  let resolveResponse;
  const completed = new Promise((resolve) => { resolveResponse = resolve; });
  const response = {
    status: null,
    headers: {},
    writeHead(status, responseHeaders = {}) { this.status = status; this.headers = responseHeaders; },
    end(content = '') { resolveResponse({ status: this.status, headers: this.headers, text: String(content) }); },
  };
  authority.handle(request, response);
  return completed;
}

const form = (value) => new URLSearchParams(value).toString();

test('TEST-ONLY AS enforces PKCE binding, resource-server auth, single-use code, and revocation', async () => {
  const authority = createTestOAuthAuthority({
    bindingCredential: BIND,
    introspectionAuthorization: INTROSPECTION,
    controlCredential: CONTROL,
  });
  const verifier = 'a'.repeat(64);
  const base = {
    response_type: 'code',
    client_id: 'hmcp-e2e-client',
    redirect_uri: 'http://127.0.0.1:3192/callback',
    scope: 'memory:read memory:propose',
    state: 'state-1',
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  };
  for (const change of [
    { redirect_uri: 'http://127.0.0.1:3192/callback/extra' },
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
  ]) {
    const denied = await invoke(authority, { path: `/authorize?${form({ ...base, ...change })}` });
    assert.equal(denied.status, 400);
  }
  const started = await invoke(authority, { path: `/authorize?${form(base)}` });
  assert.equal(started.status, 200);
  const authorizationId = JSON.parse(started.text).authorization_id;
  const unbound = await invoke(authority, {
    method: 'POST', path: '/approve', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorization_id: authorizationId }),
  });
  assert.equal(unbound.status, 400);
  const bound = await invoke(authority, {
    method: 'POST', path: '/internal/bind',
    headers: { authorization: `Bearer ${BIND}`, 'content-type': 'application/json' },
    body: JSON.stringify({ authorization_id: authorizationId, user_id: SUBJECT, workspace_id: WORKSPACE }),
  });
  assert.equal(bound.status, 200);
  const approved = await invoke(authority, {
    method: 'POST', path: '/approve', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorization_id: authorizationId }),
  });
  assert.equal(approved.status, 302);
  const redirect = new URL(approved.headers.location);
  assert.equal(redirect.origin + redirect.pathname, 'http://127.0.0.1:3192/callback');
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  const tokenRequest = {
    grant_type: 'authorization_code', client_id: 'hmcp-e2e-client',
    redirect_uri: 'http://127.0.0.1:3192/callback',
    code: redirect.searchParams.get('code'), code_verifier: verifier,
  };
  const issued = await invoke(authority, {
    method: 'POST', path: '/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(tokenRequest),
  });
  assert.equal(issued.status, 200);
  const token = JSON.parse(issued.text).access_token;
  assert.equal((await invoke(authority, {
    method: 'POST', path: '/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(tokenRequest),
  })).status, 400);
  const active = await invoke(authority, {
    method: 'POST', path: '/introspect',
    headers: { authorization: INTROSPECTION, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ token }),
  });
  assert.equal(JSON.parse(active.text).active, true);
  const resourceServer = createOAuthResourceServer({
    resource: 'http://127.0.0.1:3191/mcp',
    issuer: 'http://127.0.0.1:3192',
    jwksUri: 'http://127.0.0.1:3192/jwks',
    introspectionEndpoint: 'http://127.0.0.1:3192/introspect',
    introspectionAuthorization: INTROSPECTION,
    allowInsecureLoopback: true,
    fetchImpl: async (url, init = {}) => {
      const response = await invoke(authority, {
        method: init.method, path: new URL(url).pathname, headers: init.headers, body: init.body,
      });
      return new Response(response.text, { status: response.status, headers: response.headers });
    },
  });
  assert.deepEqual(await resourceServer.authenticate({ authorization: `Bearer ${token}` }), {
    subject: SUBJECT,
    workspaceId: WORKSPACE,
    scopes: ['memory:read', 'memory:propose'],
  });
  await invoke(authority, {
    method: 'POST', path: '/revoke', headers: { authorization: `Bearer ${CONTROL}`, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const revoked = await invoke(authority, {
    method: 'POST', path: '/introspect',
    headers: { authorization: INTROSPECTION, 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ token }),
  });
  assert.deepEqual(JSON.parse(revoked.text), { active: false });
});
