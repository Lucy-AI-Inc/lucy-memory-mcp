import type { Server } from '@modelcontextprotocol/server';
import type { AgentMemoryClient } from '../client/index.js';

export type LucyMemoryToolName = 'memory_recall' | 'memory_propose' | 'memory_proposal_status';
export interface McpSafeError {
  code: string;
  message: string;
  retryable: boolean;
  status: number | null;
  request_id?: `req_${string}`;
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
}
export const LUCY_MEMORY_TOOL_NAMES: readonly LucyMemoryToolName[];
export const LUCY_MEMORY_TOOLS: readonly LucyMemoryToolDefinition[];
export function safeMcpError(error: unknown, operation?: LucyMemoryToolName): McpSafeError;
export function createLucyMemoryMcpServer(options: LucyMemoryMcpServerOptions): Promise<Server>;
