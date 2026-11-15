export interface VersionEvidence {
  package_version: string;
  image_digest?: string;
  image_git_sha?: string;
}
export interface OperabilityEvent {
  event: 'tool' | 'upstream' | 'kill_switch';
  operation: string;
  outcome: 'success' | 'error' | 'disabled';
  duration_ms: number;
  trace_id?: string;
  error_code?: string;
  status?: number;
  throttled?: boolean;
}
export type OperabilityEmitter = (event: OperabilityEvent) => Readonly<Record<string, unknown>>;
export function workspaceHash(workspaceId: unknown, salt: unknown): string | undefined;
export function versionEvidence(environment?: NodeJS.ProcessEnv): Readonly<VersionEvidence>;
export function hostedMcpDisabledResponse(): Readonly<{
  status: 503;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export function createOperabilityEmitter(options?: {
  write?: (record: Readonly<Record<string, unknown>>) => void;
  service?: string;
  workspaceId?: string;
  workspaceSalt?: string;
  now?: () => string;
}): OperabilityEmitter;
