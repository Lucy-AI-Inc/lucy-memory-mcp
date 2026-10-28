import { isIP } from 'node:net';
import { MalformedResponseError, ValidationFailureError } from './errors.mjs';

const PREFIX = '/api/lucy/agent-memory/v1';
const DEFAULT_MAX_RETRIES = 2;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_RETRY_AFTER_MS = 60_000;

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost') return true;
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(literal) === 4) return literal.split('.')[0] === '127';
  return isIP(literal) === 6 && literal === '::1';
}

function normalizeBaseUrl(baseUrl, allowInsecureLoopback) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || /[\r\n\0]/.test(baseUrl)) {
    throw new ValidationFailureError('baseUrl must be a non-empty http(s) URL.');
  }
  let url;
  try { url = new URL(baseUrl); } catch { throw new ValidationFailureError('baseUrl must be a valid URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationFailureError('baseUrl must use http or https.');
  }
  if (url.protocol === 'http:' && !(allowInsecureLoopback && isLoopbackHostname(url.hostname))) {
    throw new ValidationFailureError('baseUrl must use https; cleartext HTTP requires explicit loopback development opt-in.');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parseRetryAfterMs(value) {
  if (value == null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.trunc(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
  return undefined;
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

async function defaultSleep(ms, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForRetry(ms, signal, sleep) {
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([Promise.resolve().then(() => sleep(ms, signal)), aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readResponseBody(response, signal) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    throw new MalformedResponseError('Lucy response does not expose a bounded streaming body.', { status: response?.status });
  }

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* retain the bounded-response error */ }
        throw new MalformedResponseError(`Lucy response exceeds ${MAX_RESPONSE_BYTES} bytes.`, { status: response.status });
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { rawText: Buffer.concat(chunks, byteLength).toString('utf8'), byteLength };
}

function routeFor(operation, payload) {
  if (operation === 'recall') {
    return { method: 'POST', path: `${PREFIX}/recall`, body: payload };
  }
  if (operation === 'canonical-recall') {
    return { method: 'POST', path: `${PREFIX}/recall`, body: payload, projection: 'canonical-v1' };
  }
  if (operation === 'propose') {
    return { method: 'POST', path: `${PREFIX}/proposals`, body: payload };
  }
  if (operation === 'proposal-status') {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { parsed = {}; }
    const id = typeof parsed.proposal_id === 'string' ? parsed.proposal_id : '';
    return { method: 'GET', path: `${PREFIX}/proposals/${encodeURIComponent(id)}`, body: null };
  }
  throw new ValidationFailureError(`Unsupported Agent Memory operation: ${operation}`);
}

function idempotencyKey(payload) {
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.idempotency_key === 'string' ? parsed.idempotency_key : null;
  } catch {
    return null;
  }
}

function requestId(payload) {
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed.request_id === 'string' ? parsed.request_id : null;
  } catch {
    return null;
  }
}

function shouldRetry(operation, status, attempt, maxRetries) {
  if (operation !== 'propose') return false;
  return attempt < maxRetries && (status === 429 || status === 503 || status === 502 || status === 504);
}

export function createLucyHttpTransport({
  baseUrl,
  allowInsecureLoopback = false,
  fetchImpl = globalThis.fetch,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = defaultSleep,
} = {}) {
  if (typeof allowInsecureLoopback !== 'boolean') throw new ValidationFailureError('allowInsecureLoopback must be a boolean.');
  const origin = normalizeBaseUrl(baseUrl, allowInsecureLoopback);
  if (typeof fetchImpl !== 'function') throw new ValidationFailureError('fetchImpl must be a function.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new ValidationFailureError('maxRetries must be an integer from 0 through 5.');
  }

  return async function lucyHttpTransport(request) {
    const { operation, payload, accessToken, signal } = request;
    const route = routeFor(operation, payload);
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    };
    if (route.body != null) headers['content-type'] = 'application/json';
    if (route.projection) headers['x-lucy-memory-projection'] = route.projection;
    const key = route.method === 'POST' && operation === 'propose' ? idempotencyKey(payload) : null;
    if (key) headers['idempotency-key'] = key;
    const rid = requestId(payload);
    if (rid) headers['x-request-id'] = rid;

    let attempt = 0;
    let last;
    while (true) {
      throwIfAborted(signal);
      const response = await fetchImpl(origin + route.path, {
        method: route.method,
        headers,
        body: route.body,
        signal,
        redirect: 'error',
      });
      const { rawText, byteLength } = await readResponseBody(response, signal);
      let body = null;
      if (rawText.length > 0) {
        try { body = JSON.parse(rawText); } catch { body = rawText; }
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      const memoryOperationId = response.headers.get('x-lucy-memory-operation-id');
      last = {
        status: response.status,
        body,
        byteLength,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(typeof memoryOperationId === 'string' && memoryOperationId.length > 0
          ? { memoryOperationId }
          : {}),
      };
      if (!shouldRetry(operation, response.status, attempt, maxRetries)) return last;
      attempt += 1;
      const wait = retryAfterMs ?? 0;
      if (wait > 0) await waitForRetry(wait, signal, sleep);
    }
  };
}
