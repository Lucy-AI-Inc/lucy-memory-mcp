import { compilePublicSchemas, isExpectedVersionSuccessor, SCHEMA_BASE } from '../../scripts/lib/am01.mjs';
import {
  InvalidKeyError, InvalidKindError, InvalidScopeError, MalformedResponseError,
  ProposalContractIncompatibilityError, ValidationFailureError,
} from './errors.mjs';

export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'decision', 'rule']);
export const MEMORY_LIFECYCLES = Object.freeze(['active', 'superseded', 'revoked', 'forgotten']);
export const PROPOSAL_LIFECYCLES = Object.freeze(['pending', 'approved', 'rejected', 'expired', 'superseded']);
export const SCOPE_KINDS = Object.freeze(['user', 'workspace', 'project']);
const registry = await compilePublicSchemas();
const schema = (name) => registry.ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`);
const KEY = /^[a-z](?:[a-z0-9]|[._-](?=[a-z0-9])){0,127}$/;
const PROJECT = /^project_[A-Za-z0-9_-]+$/;
const MEMORY = /^mem_[A-Za-z0-9_-]+$/;
const PROPOSAL = /^proposal_[A-Za-z0-9_-]+$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]+$/;
const AUTHORITY = new Set(['tenant', 'tenantid', 'tenantauthority', 'account', 'accountid', 'accountauthority']);

function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function object(value, label) {
  if (!plain(value)) throw new ValidationFailureError(`${label} must be a plain object.`);
}
function allowed(value, keys, label) {
  const extra = Object.keys(value).filter((key) => !keys.has(key));
  if (extra.length) throw new ValidationFailureError(`${label} contains unsupported fields: ${extra.sort().join(', ')}.`);
}
function noAuthority(value, path = 'request', seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new ValidationFailureError(`${path} must not contain circular values.`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY.has(key.replaceAll('_', '').replaceAll('-', '').toLowerCase())) {
      throw new ValidationFailureError(`${path}.${key} cannot supply tenant or account authority.`);
    }
    noAuthority(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
function bounded(value, label, { min = 1, max, bytes } = {}) {
  if (typeof value !== 'string' || [...value].length < min || (max !== undefined && [...value].length > max)) {
    throw new ValidationFailureError(`${label} must contain ${min} to ${max ?? 'unlimited'} Unicode scalars.`);
  }
  if (bytes !== undefined && Buffer.byteLength(value) > bytes) throw new ValidationFailureError(`${label} exceeds ${bytes} UTF-8 bytes.`);
}
function unique(value, label, max, validate) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new ValidationFailureError(`${label} must contain 1 to ${max} items.`);
  value.forEach(validate);
  if (new Set(value).size !== value.length) throw new ValidationFailureError(`${label} must contain unique items.`);
}
function matchesScope(left, right) { return left?.kind === right?.kind && left?.id === right?.id; }
function malformedUnlessValid(name, value, label, ErrorType = MalformedResponseError) {
  const validate = schema(name);
  if (!validate(value)) {
    const details = validate.errors?.map(({ instancePath, keyword, schemaPath }) => ({ instancePath, keyword, schemaPath }));
    throw new ErrorType(`${label} violates the frozen AM-01 schema.`, { details });
  }
}

export function validateScope(scope) {
  if (!plain(scope) || !SCOPE_KINDS.includes(scope.kind)) throw new InvalidScopeError('scope.kind must be user, workspace, or project.');
  const keys = scope.kind === 'project' ? new Set(['kind', 'id']) : new Set(['kind']);
  if (Object.keys(scope).length !== keys.size || Object.keys(scope).some((key) => !keys.has(key))) throw new InvalidScopeError(`${scope.kind} scope contains invalid fields.`);
  if (scope.kind === 'project' && (typeof scope.id !== 'string' || scope.id.length > 128 || !PROJECT.test(scope.id))) throw new InvalidScopeError('project scope requires a valid project_ id.');
  return scope;
}
export function validateKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new InvalidKeyError('key must use deterministic lowercase dot, underscore, or hyphen syntax.');
  return key;
}
export function validateKind(kind) {
  if (!MEMORY_KINDS.includes(kind)) throw new InvalidKindError(`kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
  return kind;
}
export function validateRecallRequest(request) {
  object(request, 'recall request'); noAuthority(request);
  allowed(request, new Set(['query', 'scope', 'keys', 'kinds', 'limit']), 'recall request');
  bounded(request.query, 'query', { max: 1024 }); validateScope(request.scope);
  if (request.keys !== undefined) unique(request.keys, 'keys', 20, validateKey);
  if (request.kinds !== undefined) unique(request.kinds, 'kinds', 4, validateKind);
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 5)) throw new ValidationFailureError('limit must be an integer between 1 and 5.');
  return request;
}
function commonProposal(request, keys) {
  noAuthority(request); allowed(request, keys, 'proposal request'); validateKey(request.key); validateScope(request.scope);
  bounded(request.content, 'content', { max: 2000, bytes: 8192 });
  bounded(request.justification, 'justification', { max: 500, bytes: 2048 });
  if (typeof request.idempotency_key !== 'string' || request.idempotency_key.length < 16 || request.idempotency_key.length > 128 || !IDEMPOTENCY.test(request.idempotency_key)) throw new ValidationFailureError('idempotency_key must contain 16 to 128 safe characters.');
  if (request.source_ref !== undefined) bounded(request.source_ref, 'source_ref', { max: 256 });
}
export function validateProposalRequest(request) {
  object(request, 'proposal request');
  if (request.operation === 'create') {
    commonProposal(request, new Set(['operation', 'key', 'kind', 'scope', 'content', 'justification', 'idempotency_key', 'source_ref'])); validateKind(request.kind);
  } else if (request.operation === 'replace') {
    commonProposal(request, new Set(['operation', 'memory_id', 'expected_version', 'key', 'scope', 'content', 'justification', 'idempotency_key', 'source_ref']));
    if (typeof request.memory_id !== 'string' || !MEMORY.test(request.memory_id)) throw new ValidationFailureError('replacement requires a valid memory_id.');
    if (!Number.isSafeInteger(request.expected_version) || request.expected_version < 1 || request.expected_version > 9007199254740990) throw new ValidationFailureError('replacement requires a valid expected_version.');
  } else throw new ValidationFailureError('operation must be create or replace.');
  return request;
}
export function validateProposalStatusRequest(request) {
  object(request, 'proposal status request'); noAuthority(request); allowed(request, new Set(['proposal_id']), 'proposal status request');
  if (typeof request.proposal_id !== 'string' || !PROPOSAL.test(request.proposal_id)) throw new ValidationFailureError('proposal_id must be valid.');
  return request;
}
function frozenRecord(entries) {
  const value = Object.create(null);
  for (const [key, child] of entries) value[key] = child;
  return Object.freeze(value);
}
function frozenList(value) {
  const copy = [];
  for (let index = 0; index < value.length; index += 1) copy.push(value[index]);
  return Object.freeze(copy);
}
function scopeDto(scope) {
  return frozenRecord(scope.kind === 'project' ? [['kind', scope.kind], ['id', scope.id]] : [['kind', scope.kind]]);
}
export function toRecallRequestDto(request) {
  validateRecallRequest(request);
  const entries = [['query', request.query], ['scope', scopeDto(request.scope)]];
  if (Object.hasOwn(request, 'keys')) entries.push(['keys', frozenList(request.keys)]);
  if (Object.hasOwn(request, 'kinds')) entries.push(['kinds', frozenList(request.kinds)]);
  if (Object.hasOwn(request, 'limit')) entries.push(['limit', request.limit]);
  return frozenRecord(entries);
}
export function toProposalRequestDto(request) {
  validateProposalRequest(request);
  const entries = request.operation === 'create'
    ? [['operation', 'create'], ['key', request.key], ['kind', request.kind], ['scope', scopeDto(request.scope)]]
    : [['operation', 'replace'], ['memory_id', request.memory_id], ['expected_version', request.expected_version], ['key', request.key], ['scope', scopeDto(request.scope)]];
  entries.push(['content', request.content], ['justification', request.justification], ['idempotency_key', request.idempotency_key]);
  if (Object.hasOwn(request, 'source_ref')) entries.push(['source_ref', request.source_ref]);
  return frozenRecord(entries);
}
export function toProposalStatusRequestDto(request) {
  validateProposalStatusRequest(request);
  return frozenRecord([['proposal_id', request.proposal_id]]);
}
export function validateRecallResponse(value, request) {
  malformedUnlessValid('recall-response', value, 'recall response');
  if (request && !matchesScope(value.scope, request.scope)) throw new MalformedResponseError('Recall response scope does not match the request.');
  for (const memory of value.results) {
    const receipt = memory.receipt;
    if (!matchesScope(value.scope, memory.scope) || memory.id !== receipt.memory_id || memory.version !== receipt.memory_version
      || memory.key !== receipt.key || memory.kind !== receipt.kind || !matchesScope(memory.scope, receipt.scope) || memory.status !== receipt.lifecycle) {
      throw new MalformedResponseError('recall response violates scope or receipt integrity.');
    }
  }
  return value;
}
export function validateProposalResponse(value, request) {
  malformedUnlessValid('proposal-status', value, 'proposal response', ProposalContractIncompatibilityError);
  if (value.status === 'approved' && (value.operation === 'create'
    ? value.result.memory_version !== 1
    : value.result.memory_id !== value.requested.memory_id || !isExpectedVersionSuccessor(value.requested.expected_version, value.result.memory_version))) {
    throw new MalformedResponseError('proposal response violates approved version semantics.');
  }
  if (request?.proposal_id && value.id !== request.proposal_id) throw new MalformedResponseError('Proposal response id does not match the request.');
  if (request?.operation) {
    const requested = value.requested;
    const mismatch = value.operation !== request.operation || requested.key !== request.key || !matchesScope(requested.scope, request.scope)
      || (request.operation === 'create' ? requested.kind !== request.kind
        : requested.memory_id !== request.memory_id || requested.expected_version !== request.expected_version);
    if (mismatch) throw new MalformedResponseError('Proposal response does not match the submitted proposal.');
  }
  return value;
}
export function validateErrorResponse(value) { malformedUnlessValid('error', value, 'error response'); return value; }
