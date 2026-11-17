import { isIP } from 'node:net';
import { HOSTED_MCP_SUPPORTED_SCOPES } from './resource-server.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HostedMcpConfigurationError extends Error {
  constructor() {
    super('Hosted MCP configuration is invalid.');
    this.name = 'HostedMcpConfigurationError';
  }
}

const invalid = () => { throw new HostedMcpConfigurationError(); };

function loopback(hostname) {
  if (hostname === 'localhost') return true;
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(literal) === 4) return literal.startsWith('127.');
  return isIP(literal) === 6 && literal === '::1';
}

function absoluteUrl(value, { allowInsecureLoopback, originOnly = false, preserveOrigin = false } = {}) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) invalid();
  let url;
  try { url = new URL(value); } catch { invalid(); }
  const insecure = allowInsecureLoopback && url.protocol === 'http:' && loopback(url.hostname);
  if ((url.protocol !== 'https:' && !insecure) || url.username || url.password || url.hash) invalid();
  if (originOnly && (url.pathname !== '/' || url.search)) invalid();
  return originOnly || (preserveOrigin && value === url.origin) ? url.origin : url.href;
}

function secret(value, { noWhitespace = false, noComma = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32 || /[\r\n\0]/.test(value)) invalid();
  if (noWhitespace && /\s/.test(value)) invalid();
  if (noComma && value.includes(',')) invalid();
  return value;
}

function opaqueValue(value) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) invalid();
  return value;
}

function parseOrigins(value) {
  if (value === undefined || value === '') return Object.freeze([]);
  const origins = String(value).split(',').map((entry) => entry.trim());
  if (origins.some((entry) => !entry) || new Set(origins).size !== origins.length) invalid();
  return Object.freeze(origins.map((origin) => {
    let url;
    try { url = new URL(origin); } catch { invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.origin !== origin) invalid();
    return origin;
  }));
}

function parseCallTimeout(value) {
  const parsed = Number(value ?? 55_000);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 55_000) invalid();
  return parsed;
}

function parseStaticScopes(value) {
  const scopes = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !HOSTED_MCP_SUPPORTED_SCOPES.includes(scope))) invalid();
  return Object.freeze(scopes);
}

export function loadHostedMcpConfig(environment = process.env) {
  const enabled = environment.HOSTED_MCP_ENABLED === 'true';
  const authMode = environment.HOSTED_MCP_AUTH_MODE ?? 'oauth';
  const allowInsecureLoopback = environment.HOSTED_MCP_ALLOW_INSECURE_LOOPBACK === 'true';
  if (!['oauth', 'staging-static-bearer'].includes(authMode)
    || (environment.HOSTED_MCP_ALLOW_INSECURE_LOOPBACK !== undefined
      && !['true', 'false'].includes(environment.HOSTED_MCP_ALLOW_INSECURE_LOOPBACK))
    || (allowInsecureLoopback && (environment.VERCEL !== undefined
      || environment.VERCEL_ENV === 'production'))) invalid();

  const canonicalUrl = absoluteUrl(environment.HOSTED_MCP_CANONICAL_URL, { allowInsecureLoopback });
  const canonical = new URL(canonicalUrl);
  if (canonical.search || canonical.pathname !== '/mcp') invalid();
  const productBaseUrl = absoluteUrl(environment.HOSTED_MCP_PRODUCT_BASE_URL, {
    allowInsecureLoopback,
    originOnly: true,
  });
  const productServiceCredential = secret(environment.HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL, {
    noWhitespace: true,
    noComma: true,
  });
  const logHashKey = secret(environment.HOSTED_MCP_LOG_HASH_KEY);
  if (logHashKey === productServiceCredential) invalid();

  const common = {
    enabled,
    authMode,
    canonicalUrl,
    productBaseUrl,
    productServiceCredential,
    logHashKey,
    allowedOrigins: parseOrigins(environment.HOSTED_MCP_ALLOWED_ORIGINS),
    callTimeoutMs: parseCallTimeout(environment.HOSTED_MCP_CALL_TIMEOUT_MS),
    allowInsecureLoopback,
  };

  if (authMode === 'oauth') {
    const oauthIntrospectionAuthorization = opaqueValue(environment.HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION);
    if (oauthIntrospectionAuthorization === logHashKey
      || oauthIntrospectionAuthorization === productServiceCredential) invalid();
    return Object.freeze({
      ...common,
      oauthIssuer: absoluteUrl(environment.HOSTED_MCP_OAUTH_ISSUER, { allowInsecureLoopback, preserveOrigin: true }),
      oauthJwksUrl: absoluteUrl(environment.HOSTED_MCP_OAUTH_JWKS_URL, { allowInsecureLoopback }),
      oauthIntrospectionUrl: absoluteUrl(environment.HOSTED_MCP_OAUTH_INTROSPECTION_URL, { allowInsecureLoopback }),
      oauthIntrospectionAuthorization,
    });
  }

  const oauthNames = [
    'HOSTED_MCP_OAUTH_ISSUER',
    'HOSTED_MCP_OAUTH_JWKS_URL',
    'HOSTED_MCP_OAUTH_INTROSPECTION_URL',
    'HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION',
  ];
  if (!environment.VERCEL_ENV || environment.VERCEL_ENV === 'production'
    || oauthNames.some((name) => environment[name] !== undefined)
    || canonical.hostname === 'mcp.trylucy.ai') invalid();
  const subject = environment.HOSTED_MCP_STAGING_STATIC_SUBJECT;
  const workspaceId = environment.HOSTED_MCP_STAGING_STATIC_WORKSPACE_ID;
  if (typeof subject !== 'string' || !UUID.test(subject)
    || typeof workspaceId !== 'string' || !UUID.test(workspaceId)) invalid();
  const staticBearer = opaqueValue(environment.HOSTED_MCP_STAGING_STATIC_BEARER);
  if (staticBearer === productServiceCredential || staticBearer === logHashKey) invalid();
  return Object.freeze({
    ...common,
    staticBearer,
    staticSubject: subject,
    staticWorkspaceId: workspaceId,
    staticScopes: parseStaticScopes(environment.HOSTED_MCP_STAGING_STATIC_SCOPES),
  });
}

export function hostedMcpEnabled(environment = process.env) {
  return environment.HOSTED_MCP_ENABLED === 'true';
}
