import type { AgentMemoryClient, PublicPermission } from '../client/index.js';
import type { LucyMemoryToolName } from './index.js';

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly PublicPermission[];
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
  toJSON(): Readonly<{ error: string; error_description: string }>;
}

export function createProtectedResourceMetadata(options: {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: PublicPermission[];
}): ProtectedResourceMetadata;

export function createOAuthResourceServer(options: {
  resource: string;
  issuer: string;
  audience?: string;
  jwksUri?: string;
  introspectionEndpoint?: string;
  introspectionAuthorization?: string;
  algorithms?: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  clockToleranceSeconds?: number;
  resolveMembership(claims: Readonly<{ issuer: string; subject: string }>): Promise<{
    userId: string;
    workspaceId: string;
  }>;
  createHostedClient(authContext: Readonly<{
    subject: string;
    workspaceId: string;
    scopes: readonly PublicPermission[];
  }>): Promise<AgentMemoryClient>;
  logger?(event: Readonly<Record<string, unknown>>): void;
  staticBearer?: { token: string; resources: string[] };
}): Readonly<{
  metadata: ProtectedResourceMetadata;
  authorize(request: {
    authorization: string;
    operation: LucyMemoryToolName;
    requestResource?: string;
    requestId?: string;
  }): Promise<Readonly<{
    client: AgentMemoryClient;
    identity: ResourceIdentity;
    scopes: readonly string[];
  }>>;
}>;
