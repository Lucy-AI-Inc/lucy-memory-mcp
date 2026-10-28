import type { AgentMemoryTransport } from './index.js';

export interface LucyHttpTransportOptions {
  baseUrl: string;
  /** Development-only opt-in for cleartext HTTP to literal loopback/localhost endpoints. */
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createLucyHttpTransport(options: LucyHttpTransportOptions): AgentMemoryTransport;
