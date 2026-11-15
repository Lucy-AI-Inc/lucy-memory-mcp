import type { AgentMemoryClient } from '../client/client.mjs';

export interface LucyMemoryMcpHttpConfig {
  readonly host: string;
  readonly port: number;
  readonly authMode: 'none' | 'staging-static-bearer';
  readonly allowedOrigins: readonly string[];
  readonly staticBearerToken?: string;
}

export interface LucyMemoryMcpHttpRuntime {
  readonly server: import('node:http').Server;
  close(): Promise<void>;
}

export function loadLucyMemoryMcpHttpConfig(environment?: NodeJS.ProcessEnv): LucyMemoryMcpHttpConfig;
export function startLucyMemoryMcpHttp(options: {
  client: AgentMemoryClient;
  admission?: object;
  onOperabilityEvent?: (event: unknown) => void;
  host?: string;
  port?: number;
  authMode?: 'none' | 'staging-static-bearer';
  staticBearerToken?: string;
  allowedOrigins?: readonly string[];
  maxRequestBodySize?: number;
}): Promise<LucyMemoryMcpHttpRuntime>;
export function runLucyMemoryMcpHttp(options?: { environment?: NodeJS.ProcessEnv }): Promise<LucyMemoryMcpHttpRuntime>;
export function main(options?: {
  environment?: NodeJS.ProcessEnv;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  exit?: (code: number) => void;
  signals?: Pick<NodeJS.Process, 'once'>;
  runtimeFactory?: typeof runLucyMemoryMcpHttp;
}): Promise<(LucyMemoryMcpHttpRuntime & { shutdown(): Promise<boolean> }) | null>;
