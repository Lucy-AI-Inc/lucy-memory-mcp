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
export declare class OAuthResourceServerError extends Error {
  readonly code: 'invalid_token' | 'insufficient_scope' | 'temporarily_unavailable';
  readonly status: 401 | 403 | 503;
  readonly missing: boolean;
  toJSON(): { error: string; error_description: string };
}
export declare const HOSTED_MCP_OPERATION_SCOPES: Readonly<Record<HostedMcpOperation, HostedMcpScope>>;
export declare const HOSTED_MCP_SUPPORTED_SCOPES: readonly HostedMcpScope[];
export declare function requireHostedMcpScope(context: HostedMcpAuthContext, operation: HostedMcpOperation): HostedMcpScope;
export declare function createProtectedResourceMetadata(options: {
  resource: string;
  authorizationServers: readonly string[];
  scopesSupported?: readonly HostedMcpScope[];
  allowInsecureLoopback?: boolean;
}): ProtectedResourceMetadata;
export declare function createOAuthResourceServer(options: {
  resource: string;
  issuer: string;
  jwksUri: string;
  introspectionEndpoint: string;
  introspectionAuthorization: string;
  algorithms?: readonly ('RS256' | 'ES256')[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  clockToleranceSeconds?: number;
  requestTimeoutMs?: number;
  allowInsecureLoopback?: boolean;
  logger?: (event: Readonly<Record<string, unknown>>) => void;
}): {
  readonly metadata: ProtectedResourceMetadata;
  authenticate(input: {
    authorization?: string | null;
    requestResource?: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<HostedMcpAuthContext>;
};
