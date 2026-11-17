const MAX_RESPONSE_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE = /^[0-9a-f]{64}\.[0-9a-f]{64}$/;
const OPERATIONS = new Set(['memory_recall', 'memory_propose', 'memory_proposal_status']);
const SCOPES = new Set(['memory:read', 'memory:propose']);

export class HostedMcpProductError extends Error {
  constructor(code, status = 503, details = {}) {
    super(code);
    this.name = 'HostedMcpProductError';
    this.code = code;
    this.status = status;
    this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}

function dependencySignal(parent, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function boundedJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new HostedMcpProductError('hosted_mcp_unavailable');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* preserve bounded failure */ }
        throw new HostedMcpProductError('hosted_mcp_unavailable');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HostedMcpProductError) throw error;
    throw new HostedMcpProductError('hosted_mcp_unavailable');
  } finally {
    reader.releaseLock?.();
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HostedMcpProductError('hosted_mcp_unavailable');
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function productFailure(response, body) {
  if (response.status === 403 && body.error === 'hosted_mcp_forbidden') {
    return new HostedMcpProductError('insufficient_scope', 403);
  }
  if (response.status === 503 && body.error === 'hosted_mcp_disabled') {
    return new HostedMcpProductError('hosted_mcp_disabled', 503);
  }
  return new HostedMcpProductError('hosted_mcp_unavailable', 503);
}

export function createHostedMcpProductClient({
  baseUrl,
  serviceCredential,
  requestId,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof baseUrl !== 'string' || typeof serviceCredential !== 'string'
    || !/^req_[a-f0-9]{32}$/.test(requestId) || typeof fetchImpl !== 'function') {
    throw new TypeError('Invalid hosted PRODUCT client configuration.');
  }
  const headers = Object.freeze({
    accept: 'application/json',
    authorization: `Bearer ${serviceCredential}`,
    'content-type': 'application/json',
    'x-request-id': requestId,
  });

  async function call(path, body, timeoutMs, { includeRequestSignal = true } = {}) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: dependencySignal(includeRequestSignal ? signal : undefined, timeoutMs),
      });
    } catch {
      throw new HostedMcpProductError('hosted_mcp_unavailable');
    }
    if (response.headers?.get?.('x-request-id') !== requestId) {
      throw new HostedMcpProductError('hosted_mcp_unavailable');
    }
    const parsed = await boundedJson(response);
    return { response, body: parsed };
  }

  return Object.freeze({
    async exchange({ subject, workspaceId, scope }) {
      if (!UUID.test(subject) || !UUID.test(workspaceId) || !SCOPES.has(scope)) {
        throw new TypeError('Invalid credential exchange input.');
      }
      const { response, body } = await call('/api/internal/hosted-mcp/v1/credential-exchange', {
        subject,
        workspace_id: workspaceId,
        scopes: [scope],
      }, 5_000);
      if (response.status !== 200) throw productFailure(response, body);
      if (!exactKeys(body, ['access_token', 'token_type', 'expires_at', 'scopes'])
        || typeof body.access_token !== 'string'
        || !/^lucy_xc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.access_token)
        || body.access_token === serviceCredential
        || body.token_type !== 'Bearer'
        || !Array.isArray(body.scopes)
        || body.scopes.length !== 1
        || body.scopes[0] !== scope) {
        throw new HostedMcpProductError('hosted_mcp_unavailable');
      }
      const expiresAt = Date.parse(body.expires_at);
      const lifetime = expiresAt - Date.now();
      if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== body.expires_at
        || lifetime <= 0 || lifetime > 900_000) {
        throw new HostedMcpProductError('hosted_mcp_unavailable');
      }
      return Object.freeze({ accessToken: body.access_token, scope });
    },

    async acquire({ subject, workspaceId, operation }) {
      if (!UUID.test(subject) || !UUID.test(workspaceId) || !OPERATIONS.has(operation)) {
        throw new TypeError('Invalid admission acquire input.');
      }
      const { response, body } = await call('/api/internal/hosted-mcp/v1/admission/acquire', {
        subject,
        workspace_id: workspaceId,
        operation,
        client_id: 'lucy-memory-mcp',
        request_id: requestId,
      }, 5_000);
      const rateLimitKeys = body.retry_after_ms === undefined
        ? ['error', 'limit']
        : ['error', 'limit', 'retry_after_ms'];
      if (response.status === 429 && exactKeys(body, rateLimitKeys) && body.error === 'rate_limit'
        && ['global', 'scope'].includes(body.limit)
        && (body.retry_after_ms === undefined
          || (Number.isSafeInteger(body.retry_after_ms) && body.retry_after_ms >= 0))) {
        throw new HostedMcpProductError('rate_limit', 429, {
          limit: body.limit,
          ...(body.retry_after_ms === undefined ? {} : { retryAfterMs: body.retry_after_ms }),
        });
      }
      if (response.status !== 200) throw productFailure(response, body);
      if (!exactKeys(body, ['allowed', 'lease', 'expires_in_ms'])
        || body.allowed !== true || !LEASE.test(body.lease) || body.expires_in_ms !== 60_000) {
        throw new HostedMcpProductError('hosted_mcp_unavailable');
      }
      return body.lease;
    },

    async release(lease) {
      if (!LEASE.test(lease)) throw new TypeError('Invalid admission lease.');
      // Cleanup has its own budget so an expired 55-second call deadline cannot
      // suppress the required best-effort lease release.
      const { response, body } = await call(
        '/api/internal/hosted-mcp/v1/admission/release',
        { lease },
        2_000,
        { includeRequestSignal: false },
      );
      if (response.status !== 200 || !exactKeys(body, ['released']) || body.released !== true) {
        throw productFailure(response, body);
      }
    },
  });
}
