import type { AgentMemoryClient, PublicPermission } from '../client/index.js';
import type { LucyMemoryToolName } from './index.js';

export type HostedMcpScope = 'memory:read' | 'memory:propose';
export type HostedMcpOperation = 'memory_recall' | 'memory_propose' | 'memory_proposal_status';

export interface HostedMcpAuthContext {
  readonly subject: string;
  readonly workspaceId: string;
  readonly scopes: readonly HostedMcpScope[];
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly HostedMcpScope[];
  readonly bearer_methods_supported: readonly ['header'];
}

export interface ResourceIdentity {
  readonly userId: string;
  readonly workspaceId: string;
  readonly subject: string;
}

export class OAuthResourceServerError extends Error {
  readonly code: 'invalid_token' | 'insufficient_scope' | 'temporarily_unavailable';
  readonly status: number;
  readonly missing: boolean;
  toJSON(): Readonly<{ error: string; error_description: string }>;
}

export declare const HOSTED_MCP_OPERATION_SCOPES: Readonly<Record<HostedMcpOperation, HostedMcpScope>>;
export declare const HOSTED_MCP_SUPPORTED_SCOPES: readonly HostedMcpScope[];

export declare function requireHostedMcpScope(
  context: HostedMcpAuthContext,
  operation: HostedMcpOperation,
): HostedMcpScope;

export declare function createProtectedResourceMetadata(options: {
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly HostedMcpScope[];
  allowInsecureLoopback?: boolean;
}): ProtectedResourceMetadata;

interface CommonResourceServerOptions {
  resource: string;
  issuer: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  clockToleranceSeconds?: number;
  requestTimeoutMs?: number;
  allowInsecureLoopback?: boolean;
  logger?: (event: Readonly<Record<string, unknown>>) => void;
}

export interface HostedOAuthResourceServerOptions extends CommonResourceServerOptions {
  algorithms?: readonly ('RS256' | 'ES256')[];
  jwksUri: string;
  introspectionEndpoint: string;
  introspectionAuthorization: string;
}

export interface LegacyOAuthResourceServerOptions extends CommonResourceServerOptions {
  audience?: string;
  algorithms?: readonly string[];
  jwksUri?: string;
  introspectionEndpoint?: string;
  introspectionAuthorization?: string;
  resolveMembership(claims: Readonly<{ issuer: string; subject: string }>): Promise<{
    userId: string;
    workspaceId: string;
  }>;
  createHostedClient(authContext: Readonly<{
    subject: string;
    workspaceId: string;
    scopes: readonly PublicPermission[];
  }>): Promise<AgentMemoryClient>;
  staticBearer?: { token: string; resources: readonly string[] };
}

export interface HostedOAuthResourceServer {
  readonly metadata: ProtectedResourceMetadata;
  authenticate(input: {
    authorization?: string | null;
    requestResource?: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<HostedMcpAuthContext>;
}

export interface LegacyOAuthResourceServer {
  readonly metadata: ProtectedResourceMetadata;
  authorize(request: {
    authorization: string;
    operation: LucyMemoryToolName;
    requestResource?: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<Readonly<{
    client: AgentMemoryClient;
    identity: ResourceIdentity;
    scopes: readonly PublicPermission[];
  }>>;
}

export declare function createOAuthResourceServer(
  options: LegacyOAuthResourceServerOptions,
): LegacyOAuthResourceServer;

export declare function createOAuthResourceServer(
  options: HostedOAuthResourceServerOptions,
): HostedOAuthResourceServer;
