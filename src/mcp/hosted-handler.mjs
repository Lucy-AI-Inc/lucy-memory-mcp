import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { AgentMemoryClient } from '../client/client.mjs';
import { createLucyHttpTransport } from '../client/http-transport.mjs';
import { HostedMcpConfigurationError, hostedMcpEnabled, loadHostedMcpConfig } from './hosted-config.mjs';
import { createHostedMcpProductClient, HostedMcpProductError } from './hosted-product.mjs';
import { defaultHostedMcpLogger, emitHostedMcpLog, hostedIdentityHash } from './hosted-observability.mjs';
import {
  createOAuthResourceServer,
  HOSTED_MCP_OPERATION_SCOPES,
  OAuthResourceServerError,
  requireHostedMcpScope,
} from './resource-server.mjs';
import { createLucyMemoryMcpServer, LUCY_MEMORY_TOOL_NAMES } from './server.mjs';

const MAX_BODY_BYTES = 8_192;
const KNOWN_TOOLS = new Set(LUCY_MEMORY_TOOL_NAMES);

class HostedHttpError extends Error {
  constructor(status, body, headers = {}, outcome = body.error) {
    super(outcome);
    this.status = status;
    this.body = body;
    this.headers = headers;
    this.outcome = outcome;
  }
}

function jsonResponse(status, body, headers = {}, { head = false, cache = 'no-store' } = {}) {
  const content = JSON.stringify(body);
  return new Response(head ? null : content, {
    status,
    headers: {
      'cache-control': cache,
      'content-length': String(Buffer.byteLength(content)),
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function withRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function challengeUrl(canonicalUrl) {
  return `${new URL(canonicalUrl).origin}/.well-known/oauth-protected-resource/mcp`;
}

function challenge(config, error, scope) {
  const parameters = [];
  if (config.authMode === 'oauth') {
    parameters.push(`resource_metadata="${challengeUrl(config.canonicalUrl)}"`);
  }
  if (!error.missing) {
    parameters.push(`error="${error.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token'}"`);
  }
  if (scope) parameters.push(`scope="${scope}"`);
  return parameters.length > 0 ? `Bearer ${parameters.join(', ')}` : 'Bearer';
}

function originAllowed(request, allowedOrigins) {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

function staticAuthenticate(request, config) {
  const authorization = request.headers.get('authorization');
  const match = typeof authorization === 'string' ? /^Bearer (\S+)$/.exec(authorization) : null;
  if (!match) throw new OAuthResourceServerError('invalid_token', 401, { missing: !authorization });
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(config.staticBearer);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new OAuthResourceServerError('invalid_token');
  }
  return Object.freeze({
    subject: config.staticSubject,
    workspaceId: config.staticWorkspaceId,
    scopes: config.staticScopes,
  });
}

async function readBodyChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) throw new HostedHttpError(503, { error: 'hosted_mcp_unavailable' }, {}, 'deadline_exceeded');
  return new Promise((resolve, reject) => {
    const aborted = () => {
      reader.cancel().catch(() => undefined);
      reject(new HostedHttpError(503, { error: 'hosted_mcp_unavailable' }, {}, 'deadline_exceeded'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function boundedBody(request, signal) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new HostedHttpError(413, { error: 'request_too_large', max_bytes: MAX_BODY_BYTES });
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readBodyChunk(reader, signal);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* retain stable body-limit response */ }
        throw new HostedHttpError(413, { error: 'request_too_large', max_bytes: MAX_BODY_BYTES });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

export function identifyHostedTool(bytes) {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.jsonrpc !== '2.0' || value.method !== 'tools/call'
      || value.params === null || typeof value.params !== 'object' || Array.isArray(value.params)
      || !KNOWN_TOOLS.has(value.params.name)) return null;
    return value.params.name;
  } catch {
    return null;
  }
}

function cleanMcpRequest(request, bytes) {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete('content-length');
  headers.delete('x-lucy-workspace-id');
  headers.delete('x-request-id');
  return new Request(request.url, { method: 'POST', headers, body: bytes });
}

function mapProductError(error, config, requiredScope) {
  if (error.code === 'rate_limit') {
    const body = { error: 'rate_limit', limit: error.details.limit };
    const headers = {};
    if (error.details.retryAfterMs !== undefined) {
      body.retry_after_ms = error.details.retryAfterMs;
      if (error.details.retryAfterMs > 0) headers['retry-after'] = String(Math.max(1, Math.ceil(error.details.retryAfterMs / 1000)));
    }
    return new HostedHttpError(429, body, headers, 'rate_limit');
  }
  if (error.code === 'insufficient_scope') {
    const oauth = new OAuthResourceServerError('insufficient_scope', 403);
    return new HostedHttpError(403, { error: 'insufficient_scope' }, {
      'www-authenticate': challenge(config, oauth, requiredScope),
    }, 'insufficient_scope');
  }
  if (error.code === 'hosted_mcp_disabled') {
    return new HostedHttpError(503, { error: 'hosted_mcp_disabled' });
  }
  return new HostedHttpError(503, { error: 'hosted_mcp_unavailable' });
}

function metadataResponse(config, head) {
  if (config.authMode !== 'oauth') return jsonResponse(404, { error: 'not_found' }, {}, { head });
  const metadata = createOAuthResourceServer({
    resource: config.canonicalUrl,
    issuer: config.oauthIssuer,
    jwksUri: config.oauthJwksUrl,
    introspectionEndpoint: config.oauthIntrospectionUrl,
    introspectionAuthorization: config.oauthIntrospectionAuthorization,
    allowInsecureLoopback: config.allowInsecureLoopback,
  }).metadata;
  return jsonResponse(200, metadata, {}, { head, cache: 'public, max-age=300' });
}

function routeMethodError(allow) {
  return jsonResponse(405, { error: 'method_not_allowed' }, { allow });
}

function requestId(random = randomBytes) {
  return `req_${random(16).toString('hex')}`;
}

export function createHostedMcpHandler({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  logger = defaultHostedMcpLogger,
  now = () => Date.now(),
  random = randomBytes,
  serverFactory = createLucyMemoryMcpServer,
  transportFactory = (options) => new WebStandardStreamableHTTPServerTransport(options),
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof logger !== 'function' || typeof now !== 'function'
    || typeof random !== 'function' || typeof serverFactory !== 'function' || typeof transportFactory !== 'function') {
    throw new TypeError('Invalid hosted MCP handler dependency.');
  }

  return async function handleHostedMcpRequest(request) {
    const startedAt = now();
    const rid = requestId(random);
    const pathname = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    let config;
    let authContext;
    let tool = null;
    let upstreamStatus = null;
    let admissionOutcome = 'not_applicable';
    let outcome = 'success';
    let finalResponse;
    const respond = (response) => {
      finalResponse = response;
      return withRequestId(response, rid);
    };

    try {
      if (pathname === '/healthz') {
        if (!['GET', 'HEAD'].includes(method)) return respond(routeMethodError('GET, HEAD'));
        if (!hostedMcpEnabled(environment)) {
          return respond(jsonResponse(200, { status: 'disabled', enabled: false }, {}, { head: method === 'HEAD' }));
        }
        try { loadHostedMcpConfig(environment); } catch {
          outcome = 'misconfigured';
          return respond(jsonResponse(503, { status: 'misconfigured', enabled: false }, {}, { head: method === 'HEAD' }));
        }
        return respond(jsonResponse(200, { status: 'ok', enabled: true }, {}, { head: method === 'HEAD' }));
      }

      if (pathname === '/.well-known/oauth-protected-resource'
        || pathname === '/.well-known/oauth-protected-resource/mcp') {
        if (!['GET', 'HEAD'].includes(method)) return respond(routeMethodError('GET, HEAD'));
        try {
          config = loadHostedMcpConfig(environment);
          return respond(metadataResponse(config, method === 'HEAD'));
        } catch {
          outcome = 'misconfigured';
          return respond(jsonResponse(503, { error: 'hosted_mcp_unavailable' }));
        }
      }

      if (pathname !== '/mcp') return respond(jsonResponse(404, { error: 'not_found' }));
      if (method !== 'POST') return respond(routeMethodError('POST'));
      if (!hostedMcpEnabled(environment)) {
        throw new HostedHttpError(503, { error: 'hosted_mcp_disabled' });
      }
      config = loadHostedMcpConfig(environment);
      const timeoutSignal = AbortSignal.timeout(config.callTimeoutMs);
      const deadlineSignal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      const deadlineAt = startedAt + config.callTimeoutMs;
      const bytes = await boundedBody(request, deadlineSignal);
      if (!originAllowed(request, config.allowedOrigins)) {
        throw new HostedHttpError(403, { error: 'origin_not_allowed' });
      }

      let oauthServer;
      try {
        if (config.authMode === 'oauth') {
          oauthServer = createOAuthResourceServer({
            resource: config.canonicalUrl,
            issuer: config.oauthIssuer,
            jwksUri: config.oauthJwksUrl,
            introspectionEndpoint: config.oauthIntrospectionUrl,
            introspectionAuthorization: config.oauthIntrospectionAuthorization,
            fetchImpl,
            now,
            allowInsecureLoopback: config.allowInsecureLoopback,
          });
          authContext = await oauthServer.authenticate({
            authorization: request.headers.get('authorization'),
            requestId: rid,
            signal: deadlineSignal,
          });
        } else {
          authContext = staticAuthenticate(request, config);
        }
      } catch (error) {
        if (!(error instanceof OAuthResourceServerError)) throw error;
        if (error.status === 503) throw new HostedHttpError(503, { error: 'hosted_mcp_unavailable' });
        const requiredScope = tool ? HOSTED_MCP_OPERATION_SCOPES[tool] : undefined;
        throw new HostedHttpError(error.status, {
          error: error.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token',
        }, { 'www-authenticate': challenge(config, error, requiredScope) }, error.code);
      }

      tool = identifyHostedTool(bytes);
      let client;
      let lease;
      let product;
      let mcpServer;
      let mcpTransport;
      let releaseFailed = false;
      try {
        if (tool) {
          let requiredScope;
          try { requiredScope = requireHostedMcpScope(authContext, tool); } catch (error) {
            throw new HostedHttpError(403, { error: 'insufficient_scope' }, {
              'www-authenticate': challenge(config, error, HOSTED_MCP_OPERATION_SCOPES[tool]),
            }, 'insufficient_scope');
          }
          product = createHostedMcpProductClient({
            baseUrl: config.productBaseUrl,
            serviceCredential: config.productServiceCredential,
            requestId: rid,
            fetchImpl,
            signal: deadlineSignal,
          });
          let exchanged;
          try {
            exchanged = await product.exchange({
              subject: authContext.subject,
              workspaceId: authContext.workspaceId,
              scope: requiredScope,
            });
            lease = await product.acquire({
              subject: authContext.subject,
              workspaceId: authContext.workspaceId,
              operation: tool,
            });
            admissionOutcome = 'allowed';
          } catch (error) {
            if (!(error instanceof HostedMcpProductError)) throw error;
            admissionOutcome = error.code === 'rate_limit'
              ? error.details.limit === 'global' ? 'global_limited' : 'scope_limited'
              : 'unavailable';
            throw mapProductError(error, config, requiredScope);
          }
          const upstreamFetch = async (url, init) => {
            const signal = init?.signal
              ? AbortSignal.any([init.signal, deadlineSignal])
              : deadlineSignal;
            const response = await fetchImpl(url, { ...init, signal });
            upstreamStatus = response.status;
            return response;
          };
          const transport = createLucyHttpTransport({
            baseUrl: config.productBaseUrl,
            allowInsecureLoopback: config.allowInsecureLoopback,
            fetchImpl: upstreamFetch,
          });
          const remaining = Math.max(1, Math.min(40_000, Math.floor(deadlineAt - now())));
          client = new AgentMemoryClient({
            transport,
            token: exchanged.accessToken,
            permissions: [exchanged.scope],
            timeoutMs: remaining,
          });
        } else {
          client = new AgentMemoryClient({
            transport: async () => { throw new Error('Protocol-only request cannot reach Agent Memory.'); },
            token: 'protocol-only-no-upstream',
            permissions: authContext.scopes,
            timeoutMs: 1_000,
          });
        }

        mcpServer = await serverFactory({ client });
        mcpTransport = transportFactory({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          maxRequestBodySize: MAX_BODY_BYTES,
        });
        await mcpServer.connect(mcpTransport);
        finalResponse = await mcpTransport.handleRequest(cleanMcpRequest(request, bytes));
        if (finalResponse.status >= 400) outcome = 'protocol_error';
        else if (upstreamStatus !== null && upstreamStatus >= 400) outcome = 'upstream_error';
      } finally {
        try { if (mcpTransport) await mcpTransport.close(); } catch { outcome = 'cleanup_error'; }
        try { if (mcpServer) await mcpServer.close(); } catch { outcome = 'cleanup_error'; }
        if (lease !== undefined) {
          try { await product.release(lease); } catch {
            releaseFailed = true;
            admissionOutcome = 'release_unavailable';
          }
        }
        if (releaseFailed) outcome = 'release_unavailable';
      }
      return respond(finalResponse);
    } catch (error) {
      if (error instanceof HostedHttpError) {
        outcome = error.outcome;
        finalResponse = jsonResponse(error.status, error.body, error.headers);
      } else if (error instanceof HostedMcpConfigurationError) {
        outcome = 'misconfigured';
        finalResponse = jsonResponse(503, { error: 'hosted_mcp_unavailable' });
      } else {
        outcome = 'unavailable';
        finalResponse = jsonResponse(503, { error: 'hosted_mcp_unavailable' });
      }
      return respond(finalResponse);
    } finally {
      const status = finalResponse?.status ?? 200;
      emitHostedMcpLog(logger, {
        timestamp: new Date(now()).toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        event: 'hosted_mcp_request',
        request_id: rid,
        subject_hash: authContext && config ? hostedIdentityHash(config.logHashKey, authContext.subject) : null,
        workspace_hash: authContext && config ? hostedIdentityHash(config.logHashKey, authContext.workspaceId) : null,
        tool,
        latency_ms: Math.max(0, Math.round(now() - startedAt)),
        http_status: status,
        upstream_status: upstreamStatus,
        admission_outcome: admissionOutcome,
        outcome,
      });
    }
  };
}

export const handleHostedMcpRequest = createHostedMcpHandler();
