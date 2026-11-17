// TEST-ONLY: excluded by .vercelignore. Invokes the exact exported Vercel handler.
import { createHmac } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const observerPath = process.env.HMCP_OBSERVER_PATH;
const observerKey = process.env.HMCP_OBSERVER_KEY;
const originalFetch = globalThis.fetch;
let lastClientDigest = null;

function digest(value) {
  return createHmac('sha256', observerKey).update(value, 'utf8').digest('base64url');
}

function observe(record) {
  if (!observerPath || !observerKey) return;
  appendFileSync(observerPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
}

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const headers = new Headers(init.headers);
  const authorization = headers.get('authorization');
  const isIntrospection = parsed.pathname.includes('introspect');
  const isHostedProduct = parsed.pathname.startsWith('/api/internal/hosted-mcp/v1/');
  const isAgentMemory = parsed.pathname.includes('/api/lucy/agent-memory/v1/');
  if (isIntrospection && typeof init.body === 'string') {
    const presented = new URLSearchParams(init.body).get('token');
    if (presented) {
      lastClientDigest = digest(presented);
      observe({
        event: 'hosted_mcp_fetch_observer_introspection',
        method: init.method ?? 'POST',
        path: parsed.pathname,
        status: null,
        value_digest: lastClientDigest,
      });
    }
  }
  if (isAgentMemory && authorization) {
    const upstreamDigest = digest(authorization.slice(7));
    observe({
      event: 'hosted_mcp_fetch_observer',
      method: init.method ?? 'GET',
      path: parsed.pathname,
      status: null,
      auth_scheme: authorization.startsWith('Bearer lucy_xc1.') ? 'bearer_lucy_xc1' : 'other',
      value_digest: upstreamDigest,
      client_upstream_equal: upstreamDigest === lastClientDigest,
      workspace_header_present: headers.has('x-lucy-workspace-id'),
    });
  }
  const response = await originalFetch(url, init);
  if (isHostedProduct) observe({
    event: 'hosted_mcp_fetch_observer_product',
    method: init.method ?? 'GET',
    path: parsed.pathname,
    status: response.status,
  });
  if (isAgentMemory) observe({
    event: 'hosted_mcp_fetch_observer_result',
    method: init.method ?? 'GET',
    path: parsed.pathname,
    status: response.status,
  });
  return response;
};

const { default: vercelHandler } = await import('../../api/index.mjs');
const server = createServer((request, response) => {
  vercelHandler(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":"hosted_mcp_unavailable"}');
  });
});

server.listen(3191, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'hmcp_adapter_ready', port: 3191 }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
