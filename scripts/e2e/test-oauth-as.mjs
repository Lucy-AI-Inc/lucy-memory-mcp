// TEST-ONLY OAuth authorization-server stand-in. Excluded from the Vercel bundle.
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { pkceChallenge } from './lib.mjs';

const ISSUER = 'http://127.0.0.1:3192';
const CLIENT_ID = 'hmcp-e2e-client';
const REDIRECT_URI = `${ISSUER}/callback`;
const RESOURCE = 'http://127.0.0.1:3191/mcp';
const SCOPES = new Set(['memory:read', 'memory:propose']);

function json(response, status, body, headers = {}) {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(content),
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(content);
}

async function body(request, limit = 8_192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearer(request, expected) {
  const supplied = request.headers.authorization;
  return typeof supplied === 'string' && supplied === `Bearer ${expected}`;
}

export function createTestOAuthAuthority({
  bindingCredential,
  introspectionAuthorization,
  controlCredential,
  now = () => Date.now(),
} = {}) {
  if (![bindingCredential, introspectionAuthorization, controlCredential]
    .every((value) => typeof value === 'string' && value.length >= 32)) {
    throw new Error('TEST-ONLY OAuth credentials are required');
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.freeze({
    ...publicKey.export({ format: 'jwk' }), kid: 'hmcp-e2e-rsa', alg: 'RS256', use: 'sig', key_ops: ['verify'],
  });
  const authorizations = new Map();
  const codes = new Map();
  const issued = new Map();
  const revoked = new Set();
  let introspectionAvailable = true;

  function mint({ subject, workspaceId, scope, claimOverrides = {} }) {
    const timestamp = Math.floor(now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'at+jwt' })).toString('base64url');
    const claims = {
      iss: ISSUER,
      sub: subject,
      workspace_id: workspaceId,
      aud: RESOURCE,
      resource: RESOURCE,
      scope,
      iat: timestamp,
      nbf: timestamp - 1,
      exp: timestamp + 300,
      jti: randomUUID(),
      ...claimOverrides,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    const token = `${header}.${payload}.${signature}`;
    issued.set(token, claims);
    return token;
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', ISSUER);
    try {
      if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        json(response, 200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          introspection_endpoint: `${ISSUER}/introspect`,
          revocation_endpoint: `${ISSUER}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: [...SCOPES],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        json(response, 200, { keys: [jwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const requestedScopes = (url.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean);
        const valid = url.searchParams.get('response_type') === 'code'
          && url.searchParams.get('client_id') === CLIENT_ID
          && url.searchParams.get('redirect_uri') === REDIRECT_URI
          && url.searchParams.get('code_challenge_method') === 'S256'
          && /^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('code_challenge') ?? '')
          && requestedScopes.length > 0
          && requestedScopes.every((scope) => SCOPES.has(scope));
        if (!valid) return json(response, 400, { error: 'invalid_request' });
        const authorizationId = `authz_${randomBytes(16).toString('hex')}`;
        authorizations.set(authorizationId, {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          challenge: url.searchParams.get('code_challenge'),
          scope: [...new Set(requestedScopes)].join(' '),
          state: url.searchParams.get('state') ?? '',
          bound: null,
          approved: false,
        });
        json(response, 200, { authorization_id: authorizationId, consent_required: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/internal/bind') {
        if (!bearer(request, bindingCredential)) return json(response, 401, { error: 'unauthorized' });
        const parsed = JSON.parse(await body(request));
        const transaction = authorizations.get(parsed.authorization_id);
        if (!transaction || transaction.bound
          || typeof parsed.user_id !== 'string' || typeof parsed.workspace_id !== 'string') {
          return json(response, 400, { error: 'invalid_binding' });
        }
        transaction.bound = { subject: parsed.user_id, workspaceId: parsed.workspace_id };
        json(response, 200, { bound: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/approve') {
        const parsed = JSON.parse(await body(request));
        const transaction = authorizations.get(parsed.authorization_id);
        if (!transaction || !transaction.bound || transaction.approved) {
          return json(response, 400, { error: 'invalid_authorization' });
        }
        transaction.approved = true;
        const code = `code_${randomBytes(24).toString('base64url')}`;
        codes.set(code, { ...transaction, expiresAt: now() + 60_000, used: false });
        const redirect = new URL(transaction.redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', transaction.state);
        response.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await body(request));
        const code = codes.get(form.get('code'));
        const valid = form.get('grant_type') === 'authorization_code'
          && form.get('client_id') === CLIENT_ID
          && form.get('redirect_uri') === REDIRECT_URI
          && code && !code.used && code.expiresAt > now()
          && pkceChallenge(form.get('code_verifier') ?? '') === code.challenge;
        if (!valid) return json(response, 400, { error: 'invalid_grant' });
        code.used = true;
        const token = mint({
          subject: code.bound.subject,
          workspaceId: code.bound.workspaceId,
          scope: code.scope,
        });
        json(response, 200, {
          access_token: token,
          token_type: 'Bearer',
          expires_in: 300,
          scope: code.scope,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/introspect') {
        if (!introspectionAvailable) return json(response, 503, { error: 'temporarily_unavailable' });
        if (request.headers.authorization !== introspectionAuthorization) return json(response, 401, { error: 'unauthorized' });
        const token = new URLSearchParams(await body(request)).get('token');
        const claims = issued.get(token);
        if (!claims || revoked.has(token) || claims.exp <= Math.floor(now() / 1000)) {
          return json(response, 200, { active: false });
        }
        json(response, 200, { active: true, ...claims });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/revoke') {
        if (!bearer(request, controlCredential)) return json(response, 401, { error: 'unauthorized' });
        const parsed = JSON.parse(await body(request));
        if (typeof parsed.token === 'string') revoked.add(parsed.token);
        json(response, 200, { revoked: true });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/__test/mint') {
        if (!bearer(request, controlCredential)) return json(response, 401, { error: 'unauthorized' });
        const parsed = JSON.parse(await body(request));
        const token = mint({
          subject: parsed.subject,
          workspaceId: parsed.workspace_id,
          scope: parsed.scope,
          claimOverrides: parsed.claim_overrides ?? {},
        });
        json(response, 200, { access_token: token });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/__test/control') {
        if (!bearer(request, controlCredential)) return json(response, 401, { error: 'unauthorized' });
        const parsed = JSON.parse(await body(request));
        if (typeof parsed.introspection_available !== 'boolean') return json(response, 400, { error: 'invalid_request' });
        introspectionAvailable = parsed.introspection_available;
        json(response, 200, { configured: true });
        return;
      }
      if (url.pathname === '/callback') return json(response, 200, { callback: true });
      json(response, 404, { error: 'not_found' });
    } catch {
      json(response, 400, { error: 'invalid_request' });
    }
  }

  return Object.freeze({ handle, jwk });
}

export async function startTestOAuthServer(options) {
  const authority = createTestOAuthAuthority(options);
  const server = createServer((request, response) => authority.handle(request, response));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3192, '127.0.0.1', resolve);
  });
  return Object.freeze({
    server,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  });
}

if (process.env.HMCP_E2E_DISPOSABLE === '1' && import.meta.url === `file://${process.argv[1]}`) {
  const runtime = await startTestOAuthServer({
    bindingCredential: process.env.HMCP_BINDING_CREDENTIAL,
    introspectionAuthorization: process.env.HMCP_INTROSPECTION_AUTHORIZATION,
    controlCredential: process.env.HMCP_CONTROL_CREDENTIAL,
  });
  console.log(JSON.stringify({ event: 'hmcp_test_oauth_ready', port: 3192 }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => runtime.close().then(() => process.exit(0)));
  }
}
