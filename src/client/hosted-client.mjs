import { AgentMemoryClient } from './client.mjs';
import {
  AuthenticationFailureError,
  AuthorizationFailureError,
  MalformedResponseError,
  ValidationFailureError,
} from './errors.mjs';

const PUBLIC_PERMISSIONS = new Set(['memory:read', 'memory:propose']);
const MAX_EXCHANGE_RESPONSE_BYTES = 16_384;
const MAX_EXCHANGED_CREDENTIAL_LIFETIME_MS = 15 * 60 * 1_000;

function credential(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new AuthenticationFailureError(`${name} must be a non-empty string without line breaks or NUL bytes.`);
  }
  return value;
}

function identity(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new ValidationFailureError(`${name} must be a non-empty string of at most 256 characters.`);
  }
  return value;
}

function permissions(value) {
  if (!Array.isArray(value)) throw new AuthorizationFailureError('Validated auth context scopes must be an array.');
  const allowed = [...new Set(value.filter((scope) => PUBLIC_PERMISSIONS.has(scope)))];
  if (allowed.length === 0) throw new AuthorizationFailureError('Validated auth context grants no Agent Memory permissions.');
  return allowed;
}

function exchangeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ValidationFailureError('exchangeUrl must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ValidationFailureError('exchangeUrl must be an HTTPS URL without credentials or a fragment.');
  }
  return url.href;
}

async function readBoundedJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new MalformedResponseError('Credential exchange response must expose a streaming body.');
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_EXCHANGE_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* retain the bounded-response error */ }
        throw new MalformedResponseError(`Credential exchange response exceeds ${MAX_EXCHANGE_RESPONSE_BYTES} bytes.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'));
  } catch {
    throw new MalformedResponseError('Credential exchange returned invalid JSON.');
  }
}

function validateExchangeResponse(value, requestedPermissions, clientAccessToken, serviceToken) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.token_type !== 'Bearer'
      || typeof value.expires_at !== 'string'
      || !Array.isArray(value.scopes)) {
    throw new MalformedResponseError('Credential exchange returned an invalid credential response.');
  }
  const accessToken = credential(value.access_token, 'Exchanged access_token');
  if (accessToken === clientAccessToken || accessToken === serviceToken) {
    throw new AuthenticationFailureError('Credential exchange did not issue a distinct Lucy credential.');
  }
  const expiresAt = Date.parse(value.expires_at);
  const remainingLifetime = expiresAt - Date.now();
  if (!Number.isFinite(expiresAt)
      || remainingLifetime <= 0
      || remainingLifetime > MAX_EXCHANGED_CREDENTIAL_LIFETIME_MS) {
    throw new AuthenticationFailureError('Credential exchange returned an invalid or non-short-lived credential.');
  }
  const granted = [...new Set(value.scopes)];
  if (granted.length === 0 || granted.some((scope) => (
    !PUBLIC_PERMISSIONS.has(scope) || !requestedPermissions.includes(scope)
  ))) {
    throw new AuthorizationFailureError('Credential exchange returned invalid or over-scoped permissions.');
  }
  return { accessToken, permissions: granted };
}

export async function createHostedAgentMemoryClient({
  authContext,
  exchangeUrl,
  serviceToken,
  transport,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  exchangeTimeoutMs = 5_000,
} = {}) {
  if (authContext === null || typeof authContext !== 'object' || Array.isArray(authContext)) {
    throw new AuthenticationFailureError('A validated server auth context is required.');
  }
  if (typeof transport !== 'function') throw new ValidationFailureError('transport must be a function.');
  if (typeof fetchImpl !== 'function') throw new ValidationFailureError('fetchImpl must be a function.');
  if (!Number.isInteger(exchangeTimeoutMs) || exchangeTimeoutMs < 1 || exchangeTimeoutMs > 30_000) {
    throw new ValidationFailureError('exchangeTimeoutMs must be an integer between 1 and 30000.');
  }

  const clientAccessToken = credential(authContext.clientAccessToken, 'Validated client access token');
  const exchangeServiceToken = credential(serviceToken, 'Credential exchange service token');
  if (exchangeServiceToken === clientAccessToken) {
    throw new AuthenticationFailureError('Credential exchange service token must differ from the client access token.');
  }
  const requestedPermissions = permissions(authContext.scopes);
  const request = {
    subject: identity(authContext.subject, 'Validated subject'),
    workspace_id: identity(authContext.workspaceId, 'Validated workspaceId'),
    scopes: requestedPermissions,
  };

  let response;
  try {
    response = await fetchImpl(exchangeEndpoint(exchangeUrl), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${exchangeServiceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(exchangeTimeoutMs),
    });
  } catch (error) {
    if (error instanceof ValidationFailureError) throw error;
    throw new AuthenticationFailureError('Lucy credential exchange failed.');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AuthenticationFailureError('Lucy credential exchange was rejected.', { status: response.status });
  }
  const exchanged = validateExchangeResponse(
    await readBoundedJson(response),
    requestedPermissions,
    clientAccessToken,
    exchangeServiceToken,
  );
  return new AgentMemoryClient({
    transport,
    token: exchanged.accessToken,
    permissions: exchanged.permissions,
    timeoutMs,
  });
}
