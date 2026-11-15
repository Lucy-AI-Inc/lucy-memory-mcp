import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { types as utilTypes } from 'node:util';
import { AgentMemoryClient, mappedErrorRequestId, safePublicErrorRequestId } from '../client/client.mjs';
import {
  AgentMemoryError,
  AuthorizationFailureError,
  ValidationFailureError,
} from '../client/errors.mjs';
import { stableSerialize } from '../client/serialization.mjs';
import { MCP_SCHEMAS } from './schemas.mjs';
import { usageSkillText } from '../onboarding/usage.mjs';

export const LUCY_MEMORY_TOOL_NAMES = Object.freeze([
  'memory_recall',
  'memory_propose',
  'memory_proposal_status',
]);

const SAFE_ERROR_MESSAGES = Object.freeze({
  authentication_failure: 'Lucy authentication failed.',
  authorization_failure: 'Lucy authorization failed.',
  invalid_scope: 'The memory scope is invalid. Use {"kind":"user"}, {"kind":"workspace"}, or {"kind":"project","id":"project_..."}.',
  invalid_key: 'The memory key is invalid.',
  invalid_kind: 'The memory kind is invalid.',
  validation_failure: 'The memory request is invalid.',
  proposal_not_found: 'The proposal was not found or is not visible.',
  memory_not_found: 'The memory was not found or is not visible.',
  version_conflict: 'The expected memory version does not match.',
  lifecycle_conflict: 'The memory lifecycle does not permit this operation.',
  rate_limit: 'Lucy rate limited the request.',
  payload_too_large: 'The memory request is too large.',
  admission_unavailable: 'Lucy admission control is temporarily unavailable.',
  upstream_unavailable: 'Lucy is temporarily unavailable.',
  timeout: 'The Lucy request timed out.',
  malformed_response: 'Lucy returned a malformed response.',
  proposal_contract_incompatible: 'Lucy returned a proposal response incompatible with the frozen AM-01 contract. Ask the Lucy service operator to restore AM-01 compatibility, then retry.',
  internal_lucy_error: 'Lucy returned an internal error.',
  insufficient_credits: 'The workspace does not have enough Lucy credits for this Agent Memory operation.',
  billing_unavailable: 'Lucy billing is temporarily unavailable.',
});
const SAFE_ERROR_CODES = new Set(Object.keys(SAFE_ERROR_MESSAGES));
const RETRYABLE_ERROR_CODES = new Set(['rate_limit', 'upstream_unavailable', 'timeout', 'billing_unavailable']);
const INTERNAL_MCP_ERROR = Object.freeze({
  code: 'internal_mcp_error',
  message: 'Lucy Memory MCP could not complete the request.',
  retryable: false,
  status: null,
});
const CANONICAL_CLIENT_OPERATIONS = Object.freeze({
  memory_recall: AgentMemoryClient.prototype.recallCanonical,
  memory_propose: AgentMemoryClient.prototype.propose,
  memory_proposal_status: AgentMemoryClient.prototype.proposalStatus,
});
const AUTHORIZATION_FAILURE_PROTOTYPE = AuthorizationFailureError.prototype;
const VALIDATION_FAILURE_PROTOTYPE = ValidationFailureError.prototype;
const AGENT_MEMORY_CLIENT_PROTOTYPE = AgentMemoryClient.prototype;
const BOUNDARY_TYPE_ERROR = TypeError;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IS_FROZEN = Object.isFrozen;
const IS_PROXY = utilTypes.isProxy;
const REFLECT_APPLY = Reflect.apply;

export const LUCY_MEMORY_TOOLS = Object.freeze([
  Object.freeze({
    name: 'memory_recall',
    description: 'Recall active approved Lucy memory only. Use for durable preferences, identity, project decisions, or explicit remember/recall. Do not use for arithmetic, weather, news, or one-shot drafting.',
    annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    inputSchema: MCP_SCHEMAS.recallInput,
    outputSchema: MCP_SCHEMAS.canonicalRecallOutput,
  }),
  Object.freeze({
    name: 'memory_propose',
    description: 'Propose a durable Lucy memory write. Success means pending, not saved. Do not send secrets. Humans approve on Lucy unless they enabled auto memory.',
    annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
    inputSchema: MCP_SCHEMAS.proposalInput,
    outputSchema: MCP_SCHEMAS.proposalOutput,
  }),
  Object.freeze({
    name: 'memory_proposal_status',
    description: 'Read whether a Lucy proposal is pending, approved, rejected, expired, or superseded. Pending memory is not recallable.',
    annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    inputSchema: MCP_SCHEMAS.proposalStatusInput,
    outputSchema: MCP_SCHEMAS.proposalOutput,
  }),
]);

function ownDataValue(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function safeMcpError(error, operation) {
  try {
    if (!(error instanceof AgentMemoryError)) return { ...INTERNAL_MCP_ERROR };
    const code = ownDataValue(error, 'code');
    if (!SAFE_ERROR_CODES.has(code)) return { ...INTERNAL_MCP_ERROR };
    const candidateStatus = ownDataValue(error, 'status');
    const status = Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599
      ? candidateStatus
      : null;
    const requestId = safePublicErrorRequestId(mappedErrorRequestId(error));
    const candidateRetryAfter = ownDataValue(error, 'retryAfterMs');
    const retryAfter = Number.isSafeInteger(candidateRetryAfter) && candidateRetryAfter >= 0
      ? candidateRetryAfter
      : null;
    return {
      code,
      message: SAFE_ERROR_MESSAGES[code],
      retryable: operation === 'memory_propose' && RETRYABLE_ERROR_CODES.has(code),
      status,
      ...(requestId === null ? {} : { request_id: requestId }),
      ...(retryAfter === null ? {} : { retry_after: retryAfter }),
    };
  } catch {
    return { ...INTERNAL_MCP_ERROR };
  }
}

function admissionError(code, status, retryAfterMs = null) {
  const error = new AgentMemoryError(code, { code, status });
  if (retryAfterMs !== null) {
    Object.defineProperty(error, 'retryAfterMs', { value: retryAfterMs, enumerable: true });
  }
  return error;
}

function validateAdmission(admission) {
  if (admission === undefined) return Object.freeze({});
  if (admission === null || typeof admission !== 'object') throw new TypeError('admission must be an object.');
  const {
    authority, context, maxBodyBytes = Infinity, maxConcurrentPerTask = Infinity, ceilings,
  } = admission;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    if (maxBodyBytes !== Infinity) throw new TypeError('maxBodyBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxConcurrentPerTask) || maxConcurrentPerTask < 1) {
    if (maxConcurrentPerTask !== Infinity) throw new TypeError('maxConcurrentPerTask must be a positive safe integer.');
  }
  if (authority !== undefined) {
    if (authority === null || typeof authority.acquire !== 'function' || typeof authority.release !== 'function') {
      throw new TypeError('admission authority must implement acquire() and release().');
    }
    if (context === null || typeof context !== 'object'
      || !['subject', 'workspace', 'client', 'task'].every((key) => typeof context[key] === 'string' && context[key].length > 0)) {
      throw new TypeError('distributed admission requires subject, workspace, client, and task context.');
    }
  }
  return Object.freeze({ authority, context, maxBodyBytes, maxConcurrentPerTask, ceilings });
}

function recordOperabilityEvent(onOperabilityEvent, operation, outcome, startedAt) {
  if (typeof onOperabilityEvent !== 'function') return;
  try {
    const error = outcome === 'success' ? {} : {
      outcome: 'error',
      ...(['payload_too_large', 'rate_limit', 'admission_unavailable'].includes(outcome)
        ? { error_code: outcome }
        : {}),
      ...(outcome === 'rate_limit' ? { throttled: true } : {}),
    };
    Promise.resolve(onOperabilityEvent(Object.freeze({
      source: 'mcp',
      event: 'tool',
      operation,
      tool: operation,
      outcome: 'success',
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      ...error,
    }))).catch(() => {});
  } catch {
    // Observability must not change request behavior.
  }
}

async function requireClient(client) {
  try {
    if (IS_PROXY(client)
      || GET_PROTOTYPE_OF(client) !== AGENT_MEMORY_CLIENT_PROTOTYPE
      || !IS_FROZEN(client)) {
      throw new BOUNDARY_TYPE_ERROR('client must be an exact non-proxy AgentMemoryClient.');
    }
    await REFLECT_APPLY(CANONICAL_CLIENT_OPERATIONS.memory_recall, client, ['{']);
    throw new BOUNDARY_TYPE_ERROR('client must be an exact non-proxy AgentMemoryClient.');
  } catch (error) {
    const errorPrototype = IS_PROXY(error) ? null : GET_PROTOTYPE_OF(error);
    if (errorPrototype === AUTHORIZATION_FAILURE_PROTOTYPE
      || errorPrototype === VALIDATION_FAILURE_PROTOTYPE) return client;
    throw new BOUNDARY_TYPE_ERROR('client must be an exact non-proxy AgentMemoryClient.');
  }
}

export async function createLucyMemoryMcpServer({
  client, name = 'lucy-memory-mcp', version = '0.1.3', admission, onOperabilityEvent,
} = {}) {
  const memoryClient = await requireClient(client);
  if (onOperabilityEvent !== undefined && typeof onOperabilityEvent !== 'function') {
    throw new TypeError('onOperabilityEvent must be a function.');
  }
  const limits = validateAdmission(admission);
  let activeRequests = 0;
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} }, instructions: usageSkillText() },
  );

  server.setRequestHandler('tools/list', async () => ({ tools: LUCY_MEMORY_TOOLS }));
  server.setRequestHandler('tools/call', async ({ params }) => {
    const startedAt = performance.now();
    const metricOperation = Object.hasOwn(CANONICAL_CLIENT_OPERATIONS, params.name) ? params.name : null;
    let lease;
    let localSlot = false;
    let outcome = 'internal_error';
    try {
      const operation = CANONICAL_CLIENT_OPERATIONS[params.name];
      if (operation === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
      const argumentsJson = stableSerialize(params.arguments ?? {});
      if (Buffer.byteLength(argumentsJson, 'utf8') > limits.maxBodyBytes) {
        throw admissionError('payload_too_large', 413);
      }
      if (activeRequests >= limits.maxConcurrentPerTask) {
        throw admissionError('rate_limit', 429);
      }
      activeRequests += 1;
      localSlot = true;
      if (limits.authority) {
        let allowed;
        let admittedLease;
        let retryAfterMs = null;
        try {
          const decision = await limits.authority.acquire(Object.freeze({
            source: 'mcp',
            operation: params.name,
            ...limits.context,
            ...(limits.ceilings === undefined ? {} : { ceilings: limits.ceilings }),
          }));
          if (decision === null || typeof decision !== 'object') throw new TypeError();
          allowed = decision.allowed;
          if (typeof allowed !== 'boolean') throw new TypeError();
          if (allowed) {
            admittedLease = decision.lease;
            if (typeof admittedLease !== 'string' || admittedLease.length === 0) throw new TypeError();
          } else {
            const candidate = decision.retryAfterMs;
            retryAfterMs = Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
          }
        } catch {
          throw admissionError('admission_unavailable', 503);
        }
        if (!allowed) throw admissionError('rate_limit', 429, retryAfterMs);
        lease = admittedLease;
      }
      const result = await REFLECT_APPLY(operation, memoryClient, [argumentsJson]);
      // Keep billing correlation in tool text for acceptance/agents. Strip it from
      // structuredContent so frozen AM-01 outputSchema (additionalProperties:false) still validates.
      const { operation_id: _billingOperationId, ...am01Structured } = result && typeof result === 'object' && !Array.isArray(result)
        ? result
        : { ...(result ?? {}) };
      outcome = 'success';
      return {
        content: [{ type: 'text', text: stableSerialize(result) }],
        structuredContent: am01Structured,
      };
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      const payload = safeMcpError(error, params.name);
      outcome = payload.code;
      return {
        isError: true,
        content: [{ type: 'text', text: stableSerialize(payload) }],
      };
    } finally {
      if (lease !== undefined) {
        try {
          await limits.authority.release(lease);
        } catch {
          outcome = 'admission_release_error';
        }
      }
      if (localSlot) activeRequests -= 1;
      if (metricOperation !== null) {
        recordOperabilityEvent(onOperabilityEvent, metricOperation, outcome, startedAt);
      }
    }
  });

  return server;
}
