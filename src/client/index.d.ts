export type MemoryKind = 'fact' | 'preference' | 'decision' | 'rule';
export type MemoryLifecycle = 'active' | 'superseded' | 'revoked' | 'forgotten';
export type ProposalLifecycle = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
export type PublicPermission = 'memory:read' | 'memory:propose';

export type UserScope = Readonly<{ kind: 'user' }>;
export type WorkspaceScope = Readonly<{ kind: 'workspace' }>;
export type ProjectScope = Readonly<{ kind: 'project'; id: `project_${string}` }>;
export type MemoryScope = UserScope | WorkspaceScope | ProjectScope;

export interface ReceiptRelation {
  type: 'supersedes';
  memory_id: `mem_${string}`;
  memory_version: number;
}

export interface MemoryReceipt {
  schema_version: '1';
  id: `rcpt_${string}`;
  memory_id: `mem_${string}`;
  memory_version: number;
  key: string;
  kind: MemoryKind;
  scope: MemoryScope;
  lifecycle: MemoryLifecycle;
  authority: { type: 'human_approved' };
  authoritative_at: string;
  issued_at: string;
  provenance: { type: 'governed_record'; ref: string };
  relations: ReceiptRelation[];
}

export interface ActiveMemory {
  schema_version: '1';
  id: `mem_${string}`;
  version: number;
  key: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  status: 'active';
  receipt: MemoryReceipt;
}

export interface RecallRequest {
  query: string;
  scope: MemoryScope;
  keys?: string[];
  kinds?: MemoryKind[];
  limit?: number;
}

export interface RecallResponse {
  schema_version: '1';
  request_id: `req_${string}`;
  as_of: string;
  consistency: 'canonical_active';
  scope: MemoryScope;
  results: ActiveMemory[];
  notices: string[];
  /** Present when Lucy returns x-lucy-memory-operation-id; attached after AM-01 validation. */
  operation_id?: string;
}

export type CanonicalApprovalStatus = 'user_approved' | 'approved' | 'replayed' | 'controller_approved';
export interface CanonicalProvenance {
  type: 'lucy_canonical';
  record_id: string;
  proposal_id: string | null;
  canonical_payload_hash: string | null;
  written_at: string;
}
export interface CanonicalRecallResult {
  record_id: string;
  key: string | null;
  kind: string;
  scope: MemoryScope;
  content: string;
  status: 'active';
  persisted: true;
  /** Native approval state; controller_approved does not claim a human receipt. */
  approval_status: CanonicalApprovalStatus;
  version: number | null;
  provenance: CanonicalProvenance;
}
export interface CanonicalRecallResponse {
  schema_version: 'canonical-recall-1';
  request_id: `req_${string}`;
  as_of: string;
  consistency: 'canonical_active';
  scope: MemoryScope;
  results: CanonicalRecallResult[];
  notices: [];
  operation_id?: string;
}

export interface CreateProposalRequest {
  operation: 'create';
  key: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  justification: string;
  idempotency_key: string;
  source_ref?: string;
}

export interface ReplaceProposalRequest {
  operation: 'replace';
  memory_id: `mem_${string}`;
  expected_version: number;
  key: string;
  scope: MemoryScope;
  content: string;
  justification: string;
  idempotency_key: string;
  source_ref?: string;
}

export type ProposalRequest = CreateProposalRequest | ReplaceProposalRequest;

export interface ProposalResult {
  memory_id: `mem_${string}`;
  memory_version: number;
  receipt_id: `rcpt_${string}`;
}

export interface ProposalStatus {
  schema_version: '1';
  id: `proposal_${string}`;
  proposal_version: 1;
  operation: 'create' | 'replace';
  status: ProposalLifecycle;
  requested: {
    memory_id?: `mem_${string}`;
    expected_version?: number;
    key: string;
    kind: MemoryKind;
    scope: MemoryScope;
  };
  relations: [];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  result: ProposalResult | null;
  /** Present when Lucy returns x-lucy-memory-operation-id; attached after AM-01 validation. */
  operation_id?: string;
}

export interface ProposalStatusRequest {
  proposal_id: `proposal_${string}`;
}

export interface TransportRequest {
  operation: 'recall' | 'canonical-recall' | 'propose' | 'proposal-status';
  payload: string;
  accessToken: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  body: unknown;
  byteLength: number;
  retryAfterMs?: number;
  /** Echo of Lucy response header x-lucy-memory-operation-id when present. */
  memoryOperationId?: string;
}

export type AgentMemoryTransport = (request: Readonly<TransportRequest>) => Promise<TransportResponse>;

export interface AgentMemoryClientOptions {
  transport: AgentMemoryTransport;
  token: string;
  permissions: PublicPermission[];
  timeoutMs?: number;
}

export type RecallRequestJson = string;
export type ProposalRequestJson = string;
export type ProposalStatusRequestJson = string;

export { createLucyHttpTransport, type LucyHttpTransportOptions } from './http-transport.js';

export class AgentMemoryClient {
  constructor(options: AgentMemoryClientOptions);
  recall(requestJson: RecallRequestJson): Promise<RecallResponse>;
  recallCanonical(requestJson: RecallRequestJson): Promise<CanonicalRecallResponse>;
  propose(requestJson: ProposalRequestJson): Promise<ProposalStatus>;
  proposalStatus(requestJson: ProposalStatusRequestJson): Promise<ProposalStatus>;
}

export interface AgentMemoryErrorOptions {
  code?: string;
  status?: number | null;
  retryable?: boolean;
  details?: unknown;
}

export class AgentMemoryError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(message: string, options?: AgentMemoryErrorOptions);
}

export class AuthenticationFailureError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class AuthorizationFailureError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class InvalidScopeError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class InvalidKeyError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class InvalidKindError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class ValidationFailureError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class ProposalNotFoundError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class MemoryNotFoundError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class VersionConflictError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class LifecycleConflictError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class UpstreamUnavailableError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class TimeoutError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class MalformedResponseError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class InternalLucyError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class InsufficientCreditsError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class BillingUnavailableError extends AgentMemoryError { constructor(message?: string, options?: AgentMemoryErrorOptions); }
export class RateLimitError extends AgentMemoryError {
  readonly retryAfterMs: number | null;
  constructor(message?: string, options?: AgentMemoryErrorOptions & { retryAfterMs?: number | null });
}

export const MEMORY_KINDS: readonly MemoryKind[];
export const MEMORY_LIFECYCLES: readonly MemoryLifecycle[];
export const PROPOSAL_LIFECYCLES: readonly ProposalLifecycle[];
export const SCOPE_KINDS: readonly MemoryScope['kind'][];

export function stableSerialize(value: unknown): string;
export function validateScope(scope: unknown): MemoryScope;
export function validateKey(key: unknown): string;
export function validateKind(kind: unknown): MemoryKind;
export function validateRecallRequest(request: unknown): RecallRequest;
export function validateProposalRequest(request: unknown): ProposalRequest;
export function validateProposalStatusRequest(request: unknown): ProposalStatusRequest;
export function validateRecallResponse(value: unknown, request?: RecallRequest): RecallResponse;
export function validateCanonicalRecallResponse(value: unknown, request?: RecallRequest): CanonicalRecallResponse;
export function validateProposalResponse(value: unknown, request?: ProposalRequest | ProposalStatusRequest): ProposalStatus;
