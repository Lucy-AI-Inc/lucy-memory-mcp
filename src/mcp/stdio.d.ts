import type { Readable, Writable } from 'node:stream';
import type { AgentMemoryClient } from '../client/index.js';

export interface LucyMemoryStdioRuntime {
  readonly close: () => Promise<void>;
}
export interface LucyMemoryStdioOptions {
  client: AgentMemoryClient;
  stdin?: Readable;
  stdout?: Writable;
  maxBufferSize?: number;
}
export function modulePathFromUrl(url: URL | string): string;
export function startLucyMemoryMcpStdio(options: LucyMemoryStdioOptions): Promise<LucyMemoryStdioRuntime>;
export function runLucyMemoryMcpStdio(options?: {
  environment?: Record<string, string | undefined>;
  stdin?: Readable;
  stdout?: Writable;
}): Promise<LucyMemoryStdioRuntime>;
export function main(options?: {
  environment?: Record<string, string | undefined>;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  exit?: (code: number) => void;
  signals?: { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown };
  runtimeFactory?: typeof runLucyMemoryMcpStdio;
}): Promise<(LucyMemoryStdioRuntime & { readonly shutdown: () => Promise<boolean> }) | null>;
