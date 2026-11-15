import type { Server } from '@modelcontextprotocol/server';
import type { AgentMemoryClient } from '../client/index.js';

export type LucyMemoryToolName = 'memory_recall' | 'memory_propose' | 'memory_proposal_status';
export interface McpSafeError {
  code: string;
  message: string;
  retryable: boolean;
  status: number | null;
  request_id?: `req_${string}`;
  retry_after?: number;
}
export interface LucyMemoryToolDefinition {
  readonly name: LucyMemoryToolName;
  readonly description: string;
  readonly annotations: Readonly<Record<string, boolean>>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}
export interface LucyMemoryMcpServerOptions {
  client: AgentMemoryClient;
  name?: string;
  version?: string;
  admission?: LucyMemoryAdmissionOptions;
  onOperabilityEvent?: (event: LucyMemoryMcpOperabilityEvent) => void | Promise<void>;
}
export interface LucyMemoryAdmissionContext {
  readonly subject: string;
  readonly workspace: string;
  readonly client: string;
  readonly task: string;
}
export interface LucyMemoryAdmissionDecision {
  readonly allowed: boolean;
  readonly lease?: string;
  readonly retryAfterMs?: number;
}
export interface LucyMemoryAdmissionAuthority {
  acquire(request: Readonly<LucyMemoryAdmissionContext & {
    source: 'mcp';
    operation: LucyMemoryToolName;
    ceilings?: Readonly<Record<string, number>>;
  }>): Promise<LucyMemoryAdmissionDecision>;
  release(lease: string): Promise<void>;
}
export interface LucyMemoryAdmissionOptions {
  authority?: LucyMemoryAdmissionAuthority;
  context?: LucyMemoryAdmissionContext;
  maxBodyBytes?: number;
  maxConcurrentPerTask?: number;
  ceilings?: Readonly<Record<string, number>>;
}
export interface LucyMemoryMcpOperabilityEvent {
  readonly source: 'mcp';
  readonly event: 'tool';
  readonly operation: LucyMemoryToolName;
  readonly tool: LucyMemoryToolName;
  readonly outcome: 'success' | 'error';
  readonly duration_ms: number;
  readonly error_code?: 'payload_too_large' | 'rate_limit' | 'admission_unavailable';
  readonly throttled?: true;
}
export const LUCY_MEMORY_TOOL_NAMES: readonly LucyMemoryToolName[];
export const LUCY_MEMORY_TOOLS: readonly LucyMemoryToolDefinition[];
export function safeMcpError(error: unknown, operation?: LucyMemoryToolName): McpSafeError;
export function createLucyMemoryMcpServer(options: LucyMemoryMcpServerOptions): Promise<Server>;
