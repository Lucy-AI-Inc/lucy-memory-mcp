export class AgentMemoryError extends Error {
  constructor(message, { code = 'agent_memory_error', status = null, retryable = false, details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}
export class AuthenticationFailureError extends AgentMemoryError {
  constructor(message = 'Lucy authentication failed.', options = {}) {
    super(message, { code: 'authentication_failure', ...options, retryable: false });
  }
}
export class AuthorizationFailureError extends AgentMemoryError {
  constructor(message = 'Lucy authorization failed.', options = {}) {
    super(message, { code: 'authorization_failure', ...options, retryable: false });
  }
}
export class InvalidScopeError extends AgentMemoryError {
  constructor(message = 'The memory scope is invalid.', options = {}) {
    super(message, { code: 'invalid_scope', ...options, retryable: false });
  }
}
export class InvalidKeyError extends AgentMemoryError {
  constructor(message = 'The memory key is invalid.', options = {}) {
    super(message, { code: 'invalid_key', ...options, retryable: false });
  }
}
export class InvalidKindError extends AgentMemoryError {
  constructor(message = 'The memory kind is invalid.', options = {}) {
    super(message, { code: 'invalid_kind', ...options, retryable: false });
  }
}
export class ValidationFailureError extends AgentMemoryError {
  constructor(message = 'The memory request is invalid.', options = {}) {
    super(message, { code: 'validation_failure', ...options, retryable: false });
  }
}
export class ProposalNotFoundError extends AgentMemoryError {
  constructor(message = 'The proposal was not found or is not visible.', options = {}) {
    super(message, { code: 'proposal_not_found', ...options, retryable: false });
  }
}
export class MemoryNotFoundError extends AgentMemoryError {
  constructor(message = 'The memory was not found or is not visible.', options = {}) {
    super(message, { code: 'memory_not_found', ...options, retryable: false });
  }
}
export class VersionConflictError extends AgentMemoryError {
  constructor(message = 'The expected memory version does not match.', options = {}) {
    super(message, { code: 'version_conflict', ...options, retryable: false });
  }
}
export class LifecycleConflictError extends AgentMemoryError {
  constructor(message = 'The memory lifecycle does not permit this operation.', options = {}) {
    super(message, { code: 'lifecycle_conflict', ...options, retryable: false });
  }
}
export class RateLimitError extends AgentMemoryError {
  constructor(message = 'Lucy rate limited the request.', { retryAfterMs = null, ...options } = {}) {
    super(message, { code: 'rate_limit', ...options, retryable: true });
    this.retryAfterMs = retryAfterMs;
  }
}
export class UpstreamUnavailableError extends AgentMemoryError {
  constructor(message = 'Lucy is temporarily unavailable.', options = {}) {
    super(message, { code: 'upstream_unavailable', ...options, retryable: true });
  }
}
export class TimeoutError extends AgentMemoryError {
  constructor(message = 'The Lucy request timed out.', options = {}) {
    super(message, { code: 'timeout', ...options, retryable: true });
  }
}
export class MalformedResponseError extends AgentMemoryError {
  constructor(message = 'Lucy returned a malformed response.', options = {}) {
    super(message, { code: 'malformed_response', ...options, retryable: false });
  }
}
export class ProposalContractIncompatibilityError extends MalformedResponseError {
  constructor(message = 'Lucy returned a proposal response incompatible with the frozen AM-01 schema.', options = {}) {
    super(message, { code: 'proposal_contract_incompatible', ...options, retryable: false });
  }
}
export class InternalLucyError extends AgentMemoryError {
  constructor(message = 'Lucy returned an internal error.', options = {}) {
    super(message, { code: 'internal_lucy_error', ...options, retryable: false });
  }
}
export class InsufficientCreditsError extends AgentMemoryError {
  constructor(message = 'The workspace does not have enough Lucy credits for this Agent Memory operation.', options = {}) {
    super(message, { code: 'insufficient_credits', ...options, retryable: false });
  }
}
export class BillingUnavailableError extends AgentMemoryError {
  constructor(message = 'Lucy billing is temporarily unavailable.', options = {}) {
    super(message, { code: 'billing_unavailable', ...options, retryable: true });
  }
}
