import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { AgentMemoryClient } from '../client/client.mjs';

const OPERATION_SCOPE = Object.freeze({
  memory_recall: 'memory:read',
  memory_proposal_status: 'memory:read',
  memory_propose: 'memory:propose',
});
const SUPPORTED_SCOPES = Object.freeze(['memory:read', 'memory:propose']);
const MAX_TOKEN_LENGTH = 16_384;

export class OAuthResourceServerError extends Error {
  constructor(code, status = 401) {
    super(code === 'insufficient_scope'
      ? 'The access token lacks the required scope.'
      : code === 'temporarily_unavailable'
        ? 'Token validation is temporarily unavailable.'
        : 'The access token is invalid.');
    this.name = 'OAuthResourceServerError';
    this.code = code;
    this.status = status;
    Object.freeze(this);
  }

  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

function exactUrl(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be an absolute HTTPS URL.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(`${name} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return url.href;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without control separators.`);
  }
  return value;
}

function exactArray(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${name} must be a non-empty string array.`);
  }
  return [...new Set(value)];
}

function safeRequestId(value) {
  return typeof value === 'string' && /^req_[A-Za-z0-9_-]{1,250}$/.test(value) ? value : undefined;
}

function bearer(header) {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) throw new OAuthResourceServerError('invalid_token');
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(header);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) throw new OAuthResourceServerError('invalid_token');
  return match[1];
}

function decodePart(value) {
  try {
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

function claimContains(value, expected) {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function scopesFrom(value) {
  const values = typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : value;
  if (!Array.isArray(values) || values.some((scope) => typeof scope !== 'string')) {
    throw new OAuthResourceServerError('invalid_token');
  }
  return new Set(values);
}

function validateClaims(claims, { issuer, audience, resource, requiredScope, now, clockToleranceSeconds }) {
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

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function fetchJson(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
  if (!response || response.status < 200 || response.status >= 300) {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
  try {
    const body = await response.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new OAuthResourceServerError('temporarily_unavailable', 503);
  }
}

function validateIdentity(value, subject) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || typeof value.userId !== 'string' || value.userId.length === 0
    || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0) {
    throw new OAuthResourceServerError('invalid_token');
  }
  return Object.freeze({ userId: value.userId, workspaceId: value.workspaceId, subject });
}

export function createProtectedResourceMetadata({
  resource,
  authorizationServers,
  scopesSupported = SUPPORTED_SCOPES,
} = {}) {
  const canonicalResource = exactUrl(resource, 'resource');
  const servers = exactArray(authorizationServers, 'authorizationServers')
    .map((server) => exactUrl(server, 'authorizationServers item'));
  const scopes = exactArray(scopesSupported, 'scopesSupported');
  if (scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope))) {
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
  algorithms = ['RS256'],
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  clockToleranceSeconds = 30,
  resolveMembership,
  createHostedClient,
  logger = () => {},
  staticBearer,
} = {}) {
  const canonicalResource = exactUrl(resource, 'resource');
  const canonicalIssuer = exactUrl(issuer, 'issuer');
  const canonicalAudience = nonempty(audience, 'audience');
  const canonicalJwksUri = jwksUri === undefined ? undefined : exactUrl(jwksUri, 'jwksUri');
  const canonicalIntrospection = introspectionEndpoint === undefined
    ? undefined
    : exactUrl(introspectionEndpoint, 'introspectionEndpoint');
  if (!canonicalJwksUri && !canonicalIntrospection) throw new TypeError('jwksUri or introspectionEndpoint is required.');
  if (canonicalJwksUri && !canonicalIntrospection) {
    throw new TypeError('JWT validation requires introspectionEndpoint for fail-closed revocation checks.');
  }
  const approvedAlgorithms = exactArray(algorithms, 'algorithms');
  if (approvedAlgorithms.some((algorithm) => algorithm !== 'RS256')) {
    throw new TypeError('Only RS256 is supported.');
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof resolveMembership !== 'function'
    || typeof createHostedClient !== 'function' || typeof logger !== 'function') {
    throw new TypeError('fetchImpl, now, resolveMembership, createHostedClient, and logger must be functions.');
  }
  if (!Number.isFinite(clockToleranceSeconds) || clockToleranceSeconds < 0 || clockToleranceSeconds > 300) {
    throw new TypeError('clockToleranceSeconds must be from 0 through 300.');
  }
  let legacy;
  if (staticBearer !== undefined) {
    const token = nonempty(staticBearer?.token, 'staticBearer.token');
    const resources = exactArray(staticBearer?.resources, 'staticBearer.resources')
      .map((value) => exactUrl(value, 'staticBearer.resources item'));
    if (resources.includes(canonicalResource)) throw new TypeError('staticBearer.resources must not include the OAuth resource.');
    legacy = Object.freeze({ token, resources: new Set(resources) });
  }

  async function introspect(token) {
    if (!canonicalIntrospection) throw new OAuthResourceServerError('temporarily_unavailable', 503);
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (introspectionAuthorization !== undefined) headers.authorization = nonempty(introspectionAuthorization, 'introspectionAuthorization');
    const claims = await fetchJson(fetchImpl, canonicalIntrospection, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ token }).toString(),
    });
    if (claims.active !== true) throw new OAuthResourceServerError('invalid_token');
    return claims;
  }

  async function validateJwt(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OAuthResourceServerError('invalid_token');
    const header = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    if (!approvedAlgorithms.includes(header.alg) || typeof header.kid !== 'string' || header.kid.length === 0) {
      throw new OAuthResourceServerError('invalid_token');
    }
    const jwks = await fetchJson(fetchImpl, canonicalJwksUri, { method: 'GET', headers: { accept: 'application/json' } });
    if (!Array.isArray(jwks.keys)) throw new OAuthResourceServerError('temporarily_unavailable', 503);
    const key = jwks.keys.find((candidate) => candidate?.kid === header.kid && candidate?.alg === header.alg);
    if (!key) throw new OAuthResourceServerError('invalid_token');
    let publicKey;
    try {
      publicKey = createPublicKey({ key, format: 'jwk' });
    } catch {
      throw new OAuthResourceServerError('invalid_token');
    }
    let valid;
    try {
      valid = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, decodePart(parts[2]));
    } catch {
      throw new OAuthResourceServerError('invalid_token');
    }
    if (!valid) throw new OAuthResourceServerError('invalid_token');
    const active = await introspect(token);
    if (active.sub !== undefined && active.sub !== claims.sub) throw new OAuthResourceServerError('invalid_token');
    return claims;
  }

  return Object.freeze({
    metadata: createProtectedResourceMetadata({
      resource: canonicalResource,
      authorizationServers: [canonicalIssuer],
    }),
    async authorize({ authorization, operation, requestResource = canonicalResource, requestId } = {}) {
      const requiredScope = OPERATION_SCOPE[operation];
      if (!requiredScope) throw new TypeError('operation must be a Lucy MCP tool name.');
      const correlationId = safeRequestId(requestId);
      try {
        const token = bearer(authorization);
        const canonicalRequestResource = exactUrl(requestResource, 'requestResource');
        if (legacy && sameSecret(token, legacy.token)) {
          if (!legacy.resources.has(canonicalRequestResource)) throw new OAuthResourceServerError('invalid_token');
          throw new OAuthResourceServerError('invalid_token');
        }
        if (canonicalRequestResource !== canonicalResource) throw new OAuthResourceServerError('invalid_token');
        const claims = canonicalJwksUri ? await validateJwt(token) : await introspect(token);
        const timestamp = Math.floor(now() / 1000);
        const scopes = validateClaims(claims, {
          issuer: canonicalIssuer,
          audience: canonicalAudience,
          resource: canonicalResource,
          requiredScope,
          now: timestamp,
          clockToleranceSeconds,
        });
        const identity = validateIdentity(await resolveMembership(Object.freeze({
          issuer: canonicalIssuer,
          subject: claims.sub,
        })), claims.sub);
        const grantedScopes = Object.freeze(SUPPORTED_SCOPES.filter((scope) => scopes.has(scope)));
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
        logger(Object.freeze({
          event: 'oauth_resource_server_failure',
          reason: failure.code,
          ...(correlationId === undefined ? {} : { request_id: correlationId }),
        }));
        throw failure;
      }
    },
  });
}
