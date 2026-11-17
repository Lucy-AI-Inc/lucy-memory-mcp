import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { isIP } from 'node:net';
import { AgentMemoryClient } from '../client/client.mjs';

export const HOSTED_MCP_OPERATION_SCOPES = Object.freeze({
  memory_recall: 'memory:read',
  memory_proposal_status: 'memory:read',
  memory_propose: 'memory:propose',
});
export const HOSTED_MCP_SUPPORTED_SCOPES = Object.freeze(['memory:read', 'memory:propose']);

const MAX_TOKEN_LENGTH = 16_384;
const MAX_PROVIDER_RESPONSE_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OAuthResourceServerError extends Error {
  constructor(code, status = 401, { missing = false } = {}) {
    super(code === 'insufficient_scope'
      ? 'The access token lacks the required scope.'
      : code === 'temporarily_unavailable'
        ? 'Token validation is temporarily unavailable.'
        : 'The access token is invalid.');
    this.name = 'OAuthResourceServerError';
    this.code = code;
    this.status = status;
    this.missing = missing;
    Object.freeze(this);
  }

  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

function loopback(hostname) {
  if (hostname === 'localhost') return true;
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) === 4) return literal.startsWith('127.');
  return isIP(literal) === 6 && literal === '::1';
}

function exactUrl(value, name, { allowInsecureLoopback = false, preserveOrigin = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be an absolute HTTPS URL.`);
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${name} must be an absolute HTTPS URL.`); }
  const insecureAllowed = allowInsecureLoopback && url.protocol === 'http:' && loopback(url.hostname);
  if ((url.protocol !== 'https:' && !insecureAllowed) || url.username || url.password || url.hash) {
    throw new TypeError(`${name} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return preserveOrigin && value === url.origin ? url.origin : url.href;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without control separators.`);
  }
  return value;
}

function exactArray(value, name) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) {
    throw new TypeError(`${name} must be a non-empty duplicate-free string array.`);
  }
  return [...value];
}

function safeRequestId(value) {
  return typeof value === 'string' && /^req_[A-Za-z0-9_-]{1,250}$/.test(value) ? value : undefined;
}

function bearer(header) {
  if (header === undefined || header === null || header === '') {
    throw new OAuthResourceServerError('invalid_token', 401, { missing: true });
  }
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) {
    throw new OAuthResourceServerError('invalid_token');
  }
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw new OAuthResourceServerError('invalid_token');
  return match[1];
}

function decodePart(value) {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length === 0 || decoded.length > 16_384) throw new Error();
    return decoded;
  } catch {
    throw new OAuthResourceServerError('invalid_token');
  }
}

function jsonPart(value) {
  try {
    const parsed = JSON.parse(decodePart(value));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new OAuthResourceServerError('invalid_token');
  }
}

function claimValues(value) {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
}

function claimContains(value, expected) {
  const values = claimValues(value);
  return values !== null && values.every((item) => typeof item === 'string') && values.includes(expected);
}

function scopesFrom(value) {
  const values = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(values) || values.length === 0 || values.some((scope) => typeof scope !== 'string' || !scope)) {
    throw new OAuthResourceServerError('invalid_token');
  }
  return new Set(values);
}

function equalStringSets(left, right, { scopes = false } = {}) {
  let a;
  let b;
  try {
    a = scopes ? scopesFrom(left) : new Set(claimValues(left));
    b = scopes ? scopesFrom(right) : new Set(claimValues(right));
  } catch {
    return false;
  }
  if ([...a, ...b].some((value) => typeof value !== 'string')) return false;
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function assertIntrospectionAgreement(active, signed) {
  for (const name of ['sub', 'iss', 'workspace_id']) {
    if (active[name] !== undefined && active[name] !== signed[name]) throw new OAuthResourceServerError('invalid_token');
  }
  for (const name of ['aud', 'resource']) {
    if (active[name] !== undefined && !equalStringSets(active[name], signed[name])) {
      throw new OAuthResourceServerError('invalid_token');
    }
  }
  if (active.scope !== undefined && !equalStringSets(active.scope, signed.scope, { scopes: true })) {
    throw new OAuthResourceServerError('invalid_token');
  }
}

function validateClaims(claims, { issuer, resource, now, clockToleranceSeconds }) {
  if (claims.iss !== issuer
    || !claimContains(claims.aud, resource)
    || !claimContains(claims.resource, resource)
    || typeof claims.sub !== 'string'
    || !UUID.test(claims.sub)
    || typeof claims.workspace_id !== 'string'
    || !UUID.test(claims.workspace_id)
    || !Number.isFinite(claims.exp)
    || claims.exp <= now - clockToleranceSeconds
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + clockToleranceSeconds))) {
    throw new OAuthResourceServerError('invalid_token');
  }
  const scopes = scopesFrom(claims.scope);
  const granted = HOSTED_MCP_SUPPORTED_SCOPES.filter((scope) => scopes.has(scope));
  if (granted.length === 0) throw new OAuthResourceServerError('insufficient_scope', 403);
  return Object.freeze({
    subject: claims.sub,
    workspaceId: claims.workspace_id,
    scopes: Object.freeze(granted),
  });
}

function validateLegacyClaims(claims, {
  issuer, audience, resource, requiredScope, now, clockToleranceSeconds,
}) {
  if (claims.iss !== issuer
    || !claimContains(claims.aud, audience)
    || !claimContains(claims.resource, resource)
    || typeof claims.sub !== 'string'
    || claims.sub.length === 0
    || !Number.isFinite(claims.exp)
    || claims.exp <= now - clockToleranceSeconds
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + clockToleranceSeconds))) {
    throw new OAuthResourceServerError('invalid_token');
  }
  const scopes = scopesFrom(claims.scope);
  if (!scopes.has(requiredScope)) throw new OAuthResourceServerError('insufficient_scope', 403);
  return scopes;
}

function validateIdentity(value, subject) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof value.userId !== 'string' || value.userId.length === 0
    || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) {
    throw new OAuthResourceServerError('invalid_token');
  }
  return Object.freeze({ userId: value.userId, workspaceId: value.workspaceId, subject });
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function dependencySignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function readBoundedJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new OAuthResourceServerError('temporarily_unavailable', 503);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* bounded failure remains authoritative */ }
        throw new OAuthResourceServerError('temporarily_unavailable', 503);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof OAuthResourceServerError) throw error;
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  } finally {
    reader.releaseLock?.();
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
}

async function fetchJson(fetchImpl, url, init, timeoutMs, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: dependencySignal(signal, timeoutMs),
    });
  } catch {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
  return readBoundedJson(response);
}

function verifyJwtSignature(header, key, signingInput, signature) {
  if ((header.alg === 'RS256' && key.kty !== 'RSA')
    || (header.alg === 'ES256' && (key.kty !== 'EC' || key.crv !== 'P-256'))
    || (key.use !== undefined && key.use !== 'sig')
    || (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')))) {
    throw new OAuthResourceServerError('invalid_token');
  }
  let publicKey;
  try { publicKey = createPublicKey({ key, format: 'jwk' }); } catch { throw new OAuthResourceServerError('invalid_token'); }
  try {
    const valid = header.alg === 'RS256'
      ? verify('RSA-SHA256', signingInput, publicKey, signature)
      : signature.length === 64 && verify('SHA256', signingInput, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    if (!valid) throw new OAuthResourceServerError('invalid_token');
  } catch (error) {
    if (error instanceof OAuthResourceServerError) throw error;
    throw new OAuthResourceServerError('invalid_token');
  }
}

export function requireHostedMcpScope(authContext, operation) {
  const required = HOSTED_MCP_OPERATION_SCOPES[operation];
  if (!required) throw new TypeError('operation must be a Lucy MCP tool name.');
  if (!authContext?.scopes?.includes(required)) {
    throw new OAuthResourceServerError('insufficient_scope', 403);
  }
  return required;
}

export function createProtectedResourceMetadata({
  resource,
  authorizationServers,
  scopesSupported = HOSTED_MCP_SUPPORTED_SCOPES,
  allowInsecureLoopback = false,
} = {}) {
  const canonicalResource = exactUrl(resource, 'resource', { allowInsecureLoopback });
  const servers = exactArray(authorizationServers, 'authorizationServers')
    .map((server) => exactUrl(server, 'authorizationServers item', {
      allowInsecureLoopback,
      preserveOrigin: true,
    }));
  const scopes = exactArray(scopesSupported, 'scopesSupported');
  if (scopes.some((scope) => !HOSTED_MCP_SUPPORTED_SCOPES.includes(scope))) {
    throw new TypeError('scopesSupported may contain only memory:read and memory:propose.');
  }
  return Object.freeze({
    resource: canonicalResource,
    authorization_servers: Object.freeze(servers),
    scopes_supported: Object.freeze(scopes),
    bearer_methods_supported: Object.freeze(['header']),
  });
}

export function createOAuthResourceServer({
  resource,
  issuer,
  audience = resource,
  jwksUri,
  introspectionEndpoint,
  introspectionAuthorization,
  algorithms = ['RS256', 'ES256'],
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  clockToleranceSeconds = 30,
  requestTimeoutMs = 3_000,
  allowInsecureLoopback = false,
  resolveMembership,
  createHostedClient,
  logger = () => {},
  staticBearer,
} = {}) {
  const legacyMode = resolveMembership !== undefined
    || createHostedClient !== undefined
    || staticBearer !== undefined;
  const canonicalResource = exactUrl(resource, 'resource', { allowInsecureLoopback });
  const canonicalIssuer = exactUrl(issuer, 'issuer', { allowInsecureLoopback, preserveOrigin: true });
  const canonicalAudience = nonempty(audience, 'audience');
  const canonicalJwksUri = jwksUri === undefined
    ? undefined
    : exactUrl(jwksUri, 'jwksUri', { allowInsecureLoopback });
  const canonicalIntrospection = introspectionEndpoint === undefined
    ? undefined
    : exactUrl(introspectionEndpoint, 'introspectionEndpoint', { allowInsecureLoopback });
  if (!canonicalJwksUri && !canonicalIntrospection) {
    throw new TypeError('jwksUri or introspectionEndpoint is required.');
  }
  if (canonicalJwksUri && !canonicalIntrospection) {
    throw new TypeError('JWT validation requires introspectionEndpoint for fail-closed revocation checks.');
  }
  if (!legacyMode && (!canonicalJwksUri || !canonicalIntrospection)) {
    throw new TypeError('Hosted authentication requires both jwksUri and introspectionEndpoint.');
  }
  const providerAuthorization = introspectionAuthorization === undefined
    ? undefined
    : nonempty(introspectionAuthorization, 'introspectionAuthorization');
  if (!legacyMode && providerAuthorization === undefined) {
    throw new TypeError('Hosted authentication requires introspectionAuthorization.');
  }
  const approvedAlgorithms = exactArray(algorithms, 'algorithms');
  if (approvedAlgorithms.some((algorithm) => !['RS256', 'ES256'].includes(algorithm))) {
    throw new TypeError('Only RS256 and ES256 are supported.');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof logger !== 'function') {
    throw new TypeError('fetchImpl, now, and logger must be functions.');
  }
  if (legacyMode && (typeof resolveMembership !== 'function' || typeof createHostedClient !== 'function')) {
    throw new TypeError('resolveMembership and createHostedClient must be functions.');
  }
  const maximumClockTolerance = legacyMode ? 300 : 30;
  if (!Number.isFinite(clockToleranceSeconds)
    || clockToleranceSeconds < 0
    || clockToleranceSeconds > maximumClockTolerance) {
    throw new TypeError(`clockToleranceSeconds must be from 0 through ${maximumClockTolerance}.`);
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 3_000) {
    throw new TypeError('requestTimeoutMs must be an integer from 1 through 3000.');
  }

  let legacy;
  if (staticBearer !== undefined) {
    const token = nonempty(staticBearer?.token, 'staticBearer.token');
    const resources = exactArray(staticBearer?.resources, 'staticBearer.resources')
      .map((value) => exactUrl(value, 'staticBearer.resources item', { allowInsecureLoopback }));
    if (resources.includes(canonicalResource)) {
      throw new TypeError('staticBearer.resources must not include the OAuth resource.');
    }
    legacy = Object.freeze({ token, resources: new Set(resources) });
  }

  async function introspect(token, signal) {
    if (!canonicalIntrospection) throw new OAuthResourceServerError('temporarily_unavailable', 503);
    const headers = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (providerAuthorization !== undefined) headers.authorization = providerAuthorization;
    const active = await fetchJson(fetchImpl, canonicalIntrospection, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ token }).toString(),
    }, requestTimeoutMs, signal);
    if (active.active !== true) throw new OAuthResourceServerError('invalid_token');
    return active;
  }

  async function validateJwt(token, signal) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OAuthResourceServerError('invalid_token');
    const header = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    if (!approvedAlgorithms.includes(header.alg) || typeof header.kid !== 'string' || !header.kid) {
      throw new OAuthResourceServerError('invalid_token');
    }
    const jwks = await fetchJson(fetchImpl, canonicalJwksUri, {
      method: 'GET', headers: { accept: 'application/json' },
    }, requestTimeoutMs, signal);
    if (!Array.isArray(jwks.keys)) throw new OAuthResourceServerError('temporarily_unavailable', 503);
    const matchingKid = jwks.keys.filter((candidate) => candidate?.kid === header.kid);
    const key = legacyMode
      ? matchingKid.find((candidate) => candidate?.alg === header.alg)
      : matchingKid[0];
    if (!key || (!legacyMode && (matchingKid.length !== 1 || key.alg !== header.alg))) {
      throw new OAuthResourceServerError('invalid_token');
    }
    verifyJwtSignature(header, key, Buffer.from(`${parts[0]}.${parts[1]}`), decodePart(parts[2]));
    const active = await introspect(token, signal);
    if (legacyMode) {
      if (active.sub !== undefined && active.sub !== claims.sub) throw new OAuthResourceServerError('invalid_token');
    } else {
      assertIntrospectionAgreement(active, claims);
    }
    return claims;
  }

  const server = {
    metadata: createProtectedResourceMetadata({
      resource: canonicalResource,
      authorizationServers: [canonicalIssuer],
      allowInsecureLoopback,
    }),

    async authenticate({ authorization, requestResource = canonicalResource, requestId, signal } = {}) {
      const correlationId = safeRequestId(requestId);
      try {
        const token = bearer(authorization);
        const canonicalRequestResource = exactUrl(requestResource, 'requestResource', { allowInsecureLoopback });
        if (canonicalRequestResource !== canonicalResource) throw new OAuthResourceServerError('invalid_token');
        const claims = await validateJwt(token, signal);
        return validateClaims(claims, {
          issuer: canonicalIssuer,
          resource: canonicalResource,
          now: Math.floor(now() / 1000),
          clockToleranceSeconds,
        });
      } catch (error) {
        const failure = error instanceof OAuthResourceServerError
          ? error
          : new OAuthResourceServerError('temporarily_unavailable', 503);
        try {
          logger(Object.freeze({
            event: 'oauth_resource_server_failure',
            reason: failure.code,
            ...(correlationId === undefined ? {} : { request_id: correlationId }),
          }));
        } catch { /* observability cannot alter auth behavior */ }
        throw failure;
      }
    },

    async authorize({ authorization, operation, requestResource = canonicalResource, requestId, signal } = {}) {
      if (!legacyMode) throw new TypeError('authorize is available only with legacy client callbacks.');
      const requiredScope = HOSTED_MCP_OPERATION_SCOPES[operation];
      if (!requiredScope) throw new TypeError('operation must be a Lucy MCP tool name.');
      const correlationId = safeRequestId(requestId);
      try {
        const token = bearer(authorization);
        const canonicalRequestResource = exactUrl(requestResource, 'requestResource', { allowInsecureLoopback });
        if (legacy && sameSecret(token, legacy.token)) {
          if (!legacy.resources.has(canonicalRequestResource)) throw new OAuthResourceServerError('invalid_token');
          throw new OAuthResourceServerError('invalid_token');
        }
        if (canonicalRequestResource !== canonicalResource) throw new OAuthResourceServerError('invalid_token');
        const claims = canonicalJwksUri ? await validateJwt(token, signal) : await introspect(token, signal);
        const scopes = validateLegacyClaims(claims, {
          issuer: canonicalIssuer,
          audience: canonicalAudience,
          resource: canonicalResource,
          requiredScope,
          now: Math.floor(now() / 1000),
          clockToleranceSeconds,
        });
        const identity = validateIdentity(await resolveMembership(Object.freeze({
          issuer: canonicalIssuer,
          subject: claims.sub,
        })), claims.sub);
        const grantedScopes = Object.freeze(HOSTED_MCP_SUPPORTED_SCOPES.filter((scope) => scopes.has(scope)));
        const client = await createHostedClient(Object.freeze({
          subject: identity.subject,
          workspaceId: identity.workspaceId,
          scopes: grantedScopes,
        }));
        if (!(client instanceof AgentMemoryClient) || !Object.isFrozen(client)) {
          throw new TypeError('createHostedClient must return a frozen AgentMemoryClient.');
        }
        return Object.freeze({ client, identity, scopes: grantedScopes });
      } catch (error) {
        const failure = error instanceof OAuthResourceServerError
          ? error
          : new OAuthResourceServerError('temporarily_unavailable', 503);
        try {
          logger(Object.freeze({
            event: 'oauth_resource_server_failure',
            reason: failure.code,
            ...(correlationId === undefined ? {} : { request_id: correlationId }),
          }));
        } catch { /* observability cannot alter auth behavior */ }
        throw failure;
      }
    },
  };
  if (legacyMode) delete server.authenticate;
  else delete server.authorize;
  return Object.freeze(server);
}
