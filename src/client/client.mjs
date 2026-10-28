import {
  AgentMemoryError, AuthenticationFailureError, AuthorizationFailureError, InternalLucyError, InvalidScopeError,
  LifecycleConflictError, MalformedResponseError, MemoryNotFoundError, ProposalNotFoundError, RateLimitError,
  TimeoutError, UpstreamUnavailableError, ValidationFailureError, VersionConflictError,
  InsufficientCreditsError, BillingUnavailableError,
} from './errors.mjs';
import { parseRequestJson, stableSerialize } from './serialization.mjs';
import {
  toProposalRequestDto, toProposalStatusRequestDto, toRecallRequestDto, validateErrorResponse,
  validateProposalResponse, validateRecallResponse,
} from './validation.mjs';
import { validateCanonicalRecallResponse } from './canonical-validation.mjs';

const REQUEST_LIMITS = Object.freeze({ recall: 8192, 'canonical-recall': 8192, propose: 12288 });
// Match the existing canonical recall request_id limit without changing the public error schema.
const MAX_PUBLIC_ERROR_REQUEST_ID_LENGTH = 256;
const PUBLIC_ERROR_REQUEST_ID = /^req_[A-Za-z0-9_-]+$/;
const MAPPED_ERROR_REQUEST_IDS = new WeakMap();

export function safePublicErrorRequestId(value) {
  return typeof value === 'string'
    && value.length <= MAX_PUBLIC_ERROR_REQUEST_ID_LENGTH
    && PUBLIC_ERROR_REQUEST_ID.exec(value)?.[0] === value
    ? value
    : null;
}

export function mappedErrorRequestId(error) {
  return safePublicErrorRequestId(MAPPED_ERROR_REQUEST_IDS.get(error));
}

function permissions(value) {
  if (!Array.isArray(value) || value.some((item) => !['memory:read', 'memory:propose'].includes(item))) {
    throw new ValidationFailureError('permissions may contain only memory:read and memory:propose.');
  }
  return new Set(value);
}
function responseMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || !('body' in value)
    || (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0))) {
    throw new MalformedResponseError('Transport returned invalid response metadata.');
  }
  let canonicalBytes;
  try { canonicalBytes = Buffer.byteLength(stableSerialize(value.body)); }
  catch { throw new MalformedResponseError('Transport returned a non-serializable response body.'); }
  if (value.byteLength < canonicalBytes) throw new MalformedResponseError('Transport response byte length is inconsistent.');
  return value;
}
function mapError(response, operation) {
  validateErrorResponse(response.body);
  const { code } = response.body.error;
  const requestId = safePublicErrorRequestId(response.body.request_id);
  const options = {
    status: response.status,
    details: requestId === null ? { lucyCode: code } : { lucyCode: code, request_id: requestId },
  };
  const correlate = (error) => {
    if (requestId !== null) MAPPED_ERROR_REQUEST_IDS.set(error, requestId);
    return error;
  };
  if (response.status === 401 || code === 'unauthenticated') return correlate(new AuthenticationFailureError(undefined, options));
  if (response.status === 403 || code === 'forbidden') return correlate(new AuthorizationFailureError(undefined, options));
  if (code === 'insufficient_credits' || response.status === 402) return correlate(new InsufficientCreditsError(undefined, options));
  if (code === 'billing_unavailable') return correlate(new BillingUnavailableError(undefined, options));
  if (code === 'invalid_scope') return correlate(new InvalidScopeError(undefined, options));
  if (code === 'version_conflict') return correlate(new VersionConflictError(undefined, options));
  if (code === 'conflict') return correlate(new LifecycleConflictError(undefined, options));
  if (response.status === 404 || code === 'not_found_or_not_visible') {
    return correlate(operation === 'proposal-status'
      ? new ProposalNotFoundError(undefined, options)
      : new MemoryNotFoundError(undefined, options));
  }
  if (response.status === 429 || code === 'rate_limited') return correlate(new RateLimitError(undefined, { ...options, retryAfterMs: response.retryAfterMs ?? null }));
  if ([502, 503, 504].includes(response.status) || code === 'service_unavailable') return correlate(new UpstreamUnavailableError(undefined, options));
  if (response.status >= 500) return correlate(new InternalLucyError(undefined, options));
  return correlate(new ValidationFailureError(undefined, options));
}

export class AgentMemoryClient {
  #permissions;
  #timeoutMs;
  #token;
  #transport;

  constructor({ transport, token, permissions: configuredPermissions, timeoutMs = 10_000 } = {}) {
    if (typeof transport !== 'function') throw new ValidationFailureError('transport must be a function.');
    if (typeof token !== 'string' || token.length === 0 || /[\r\n\0]/.test(token)) throw new AuthenticationFailureError('token must be a non-empty string without line breaks or NUL bytes.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new ValidationFailureError('timeoutMs must be an integer between 1 and 300000.');
    this.#transport = transport;
    this.#token = token;
    this.#permissions = permissions(configuredPermissions);
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  async recall(requestJson) {
    this.#require('memory:read');
    const request = toRecallRequestDto(parseRequestJson(requestJson, 'recall request', 8192));
    return this.#invoke('recall', request, validateRecallResponse);
  }
  async recallCanonical(requestJson) {
    this.#require('memory:read');
    const request = toRecallRequestDto(parseRequestJson(requestJson, 'canonical recall request', 8192));
    return this.#invoke('canonical-recall', request, validateCanonicalRecallResponse);
  }
  async propose(requestJson) {
    this.#require('memory:propose');
    const request = toProposalRequestDto(parseRequestJson(requestJson, 'proposal request', 12288));
    return this.#invoke('propose', request, validateProposalResponse);
  }
  async proposalStatus(requestJson) {
    this.#require('memory:read');
    const request = toProposalStatusRequestDto(parseRequestJson(requestJson, 'proposal status request', 8192));
    return this.#invoke('proposal-status', request, validateProposalResponse);
  }
  #require(permission) {
    if (!this.#permissions.has(permission)) throw new AuthorizationFailureError(`The client configuration is missing ${permission}.`, { details: { permission } });
  }
  async #invoke(operation, request, validate) {
    const payload = stableSerialize(request);
    const limit = REQUEST_LIMITS[operation];
    if (limit && Buffer.byteLength(payload) > limit) throw new ValidationFailureError(`${operation} request exceeds ${limit} UTF-8 bytes.`);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TimeoutError(`Lucy request exceeded ${this.#timeoutMs}ms.`)); }, this.#timeoutMs);
    });
    let raw;
    try {
      raw = await Promise.race([
        Promise.resolve().then(() => this.#transport(Object.freeze({ operation, payload, accessToken: this.#token, signal: controller.signal }))),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof AgentMemoryError) throw error;
      if (controller.signal.aborted || error?.name === 'TimeoutError') throw new TimeoutError(`Lucy request exceeded ${this.#timeoutMs}ms.`);
      throw new UpstreamUnavailableError('Lucy transport failed.');
    } finally { clearTimeout(timer); }
    const response = responseMetadata(raw);
    if ((operation === 'recall' || operation === 'canonical-recall') && response.byteLength > 65536) throw new MalformedResponseError('Recall response exceeds 65536 UTF-8 bytes.', { status: response.status });
    if (response.status < 200 || response.status >= 300) throw mapError(response, operation);
    const validated = validate(response.body, request);
    const headerValue = response.memoryOperationId;
    if (typeof headerValue === 'string' && /^memory-[a-f0-9]{32}$/i.test(headerValue)) {
      return { ...validated, operation_id: headerValue };
    }
    return validated;
  }
}
