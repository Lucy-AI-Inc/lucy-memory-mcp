#!/usr/bin/env node
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AgentMemoryClient } from '../client/client.mjs';
import { loadLucyMemoryMcpConfig, resolveLucyMemoryAdmission, resolveLucyMemoryTransport } from './config.mjs';
import { createShutdownController, McpLifecycleError, runLifecycleStage, safeLifecycleDiagnostic } from './lifecycle.mjs';
import { createLucyMemoryMcpServer } from './server.mjs';

const json = (response, status, body, headers = {}) => {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    ...headers,
  });
  response.end(content);
};

const methodNotAllowed = (response, allow) => json(response, 405, { error: 'method_not_allowed' }, { allow });

function parseAllowedOrigins(value) {
  if (value === undefined || value === '') return Object.freeze([]);
  const origins = value.split(',').map((entry) => entry.trim());
  const parsed = new Set();
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new McpLifecycleError('CONFIGURATION_ERROR');
    }
    if (!origin || (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || parsed.has(url.origin)) {
      throw new McpLifecycleError('CONFIGURATION_ERROR');
    }
    parsed.add(url.origin);
  }
  return Object.freeze([...parsed]);
}

export function loadLucyMemoryMcpHttpConfig(environment = process.env) {
  const host = environment.HOST ?? '0.0.0.0';
  const port = Number(environment.PORT ?? 3000);
  const authMode = environment.LUCY_MCP_HTTP_AUTH_MODE ?? 'none';
  const staticBearerToken = environment.LUCY_MCP_HTTP_STATIC_BEARER_TOKEN;
  if (typeof host !== 'string' || !host || /[\r\n\0]/.test(host)
    || !Number.isSafeInteger(port) || port < 1 || port > 65_535
    || (authMode !== 'none' && authMode !== 'staging-static-bearer')
    || (authMode === 'staging-static-bearer'
      && (environment.NODE_ENV === 'production' || typeof staticBearerToken !== 'string'
        || !staticBearerToken || /[\r\n\0]/.test(staticBearerToken)))) {
    throw new McpLifecycleError('CONFIGURATION_ERROR');
  }
  return Object.freeze({
    host,
    port,
    authMode,
    allowedOrigins: parseAllowedOrigins(environment.LUCY_MCP_HTTP_ALLOWED_ORIGINS),
    ...(authMode === 'staging-static-bearer' ? { staticBearerToken } : {}),
  });
}

function originAllowed(request, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || allowedOrigins.length === 0) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

function bearerAllowed(request, expected) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function writeWebResponse(webResponse, response) {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (!webResponse.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(webResponse.body);
    body.once('error', reject);
    response.once('error', reject);
    response.once('finish', resolve);
    body.pipe(response);
  });
}

export async function startLucyMemoryMcpHttp({
  client,
  admission,
  onOperabilityEvent,
  host = '0.0.0.0',
  port = 3000,
  authMode = 'none',
  staticBearerToken,
  allowedOrigins = [],
  maxRequestBodySize,
} = {}) {
  const active = new Set();
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, 'GET, HEAD');
        return;
      }
      const body = JSON.stringify({ status: 'ok' });
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (pathname !== '/mcp') {
      json(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }
    if (!originAllowed(request, allowedOrigins)) {
      json(response, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (authMode === 'staging-static-bearer' && !bearerAllowed(request, staticBearerToken)) {
      json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }

    let product;
    let transport;
    let closePromise;
    let finishLifecycle;
    const lifecycle = new Promise((resolve) => {
      finishLifecycle = resolve;
    });
    const abort = () => {
      request.destroy();
      response.destroy();
      return lifecycle;
    };
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = Promise.allSettled([
        ...(transport ? [transport.close()] : []),
        ...(product ? [product.close()] : []),
      ]).then(() => undefined);
      return closePromise;
    };
    active.add(abort);
    try {
      product = await createLucyMemoryMcpServer({ client, admission, onOperabilityEvent });
      if (request.destroyed) return;
      transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
        ...(maxRequestBodySize === undefined ? {} : { maxRequestBodySize }),
      });
      await product.connect(transport);
      const webRequest = new Request(new URL(request.url ?? '/', 'http://localhost'), {
        method: 'POST',
        headers: request.headers,
        body: request,
        duplex: 'half',
      });
      await writeWebResponse(await transport.handleRequest(webRequest), response);
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'internal_error' });
      else response.destroy();
    } finally {
      await close();
      active.delete(abort);
      finishLifecycle();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closing;
  return Object.freeze({
    server,
    close() {
      if (closing) return closing;
      const listenerClosed = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
      for (const socket of sockets) socket.destroy();
      closing = Promise.all([
        listenerClosed,
        Promise.allSettled([...active].map((abort) => abort())),
      ]).then(() => undefined);
      return closing;
    },
  });
}

export async function runLucyMemoryMcpHttp({ environment = process.env } = {}) {
  const http = await runLifecycleStage('CONFIGURATION_ERROR', () => loadLucyMemoryMcpHttpConfig(environment));
  const config = await runLifecycleStage('CONFIGURATION_ERROR', () => loadLucyMemoryMcpConfig(environment));
  const transport = await runLifecycleStage('TRANSPORT_LOAD_ERROR', () => resolveLucyMemoryTransport(config));
  const admission = await resolveLucyMemoryAdmission(config);
  const client = new AgentMemoryClient({
    transport,
    token: config.token,
    permissions: config.permissions,
    timeoutMs: config.timeoutMs,
  });
  return runLifecycleStage('STARTUP_ERROR', () => startLucyMemoryMcpHttp({
    client,
    ...admission,
    ...http,
    maxRequestBodySize: admission.admission.maxBodyBytes,
  }));
}

export async function main({
  environment = process.env,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
  signals = process,
  runtimeFactory = runLucyMemoryMcpHttp,
} = {}) {
  let runtime;
  try {
    runtime = await runtimeFactory({ environment });
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
