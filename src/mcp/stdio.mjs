#!/usr/bin/env node
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { fileURLToPath } from 'node:url';
import { AgentMemoryClient } from '../client/client.mjs';
import { loadLucyMemoryMcpConfig, resolveLucyMemoryTransport } from './config.mjs';
import { createShutdownController, runLifecycleStage, safeLifecycleDiagnostic } from './lifecycle.mjs';
import { createLucyMemoryMcpServer } from './server.mjs';

export function modulePathFromUrl(url) {
  return fileURLToPath(url);
}

export async function startLucyMemoryMcpStdio({ client, stdin = process.stdin, stdout = process.stdout, maxBufferSize = 1_048_576 } = {}) {
  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize });
  const handle = serveStdio(
    () => createLucyMemoryMcpServer({ client }),
    { transport, legacy: 'serve' },
  );
  return Object.freeze({ close: async () => handle.close() });
}

export async function runLucyMemoryMcpStdio({ environment = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  const config = await runLifecycleStage('CONFIGURATION_ERROR', () => loadLucyMemoryMcpConfig(environment));
  const transport = await runLifecycleStage('TRANSPORT_LOAD_ERROR', () => resolveLucyMemoryTransport(config));
  const client = new AgentMemoryClient({
    transport,
    token: config.token,
    permissions: config.permissions,
    timeoutMs: config.timeoutMs,
  });
  return runLifecycleStage('STARTUP_ERROR', () => startLucyMemoryMcpStdio({ client, stdin, stdout }));
}

export async function main({ environment = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  exit = (code) => process.exit(code), signals = process, runtimeFactory = runLucyMemoryMcpStdio } = {}) {
  let runtime;
  try {
    runtime = await runtimeFactory({ environment, stdin, stdout });
  } catch (error) {
    stderr.write(safeLifecycleDiagnostic(error));
    exit(1);
    return null;
  }
  let shutdownExitCode = 1;
  const shutdown = createShutdownController({
    close: runtime.close,
    writeDiagnostic: (diagnostic) => stderr.write(diagnostic),
    setExitCode: (code) => { shutdownExitCode = code; },
  });
  let signalHandled = false;
  const onSignal = () => {
    if (signalHandled) return;
    signalHandled = true;
    shutdown().finally(() => exit(shutdownExitCode));
  };
  signals.once('SIGINT', onSignal);
  signals.once('SIGTERM', onSignal);
  return Object.freeze({ ...runtime, shutdown });
}
