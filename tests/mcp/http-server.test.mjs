import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import {
  loadLucyMemoryMcpHttpConfig,
  startLucyMemoryMcpHttp,
} from '../../src/mcp/http.mjs';

const client = () => new AgentMemoryClient({
  transport: async () => { throw new Error('not used'); },
  token: 'upstream-token',
  permissions: ['memory:read', 'memory:propose'],
});

async function runtime(options = {}) {
  const running = await startLucyMemoryMcpHttp({
    client: client(),
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
  const { port } = running.server.address();
  return { running, url: `http://127.0.0.1:${port}` };
}

test('HTTP configuration is strict and defaults are production-safe', () => {
  assert.deepEqual(loadLucyMemoryMcpHttpConfig({}), {
    host: '0.0.0.0',
    port: 3000,
    authMode: 'none',
    allowedOrigins: [],
  });
  assert.deepEqual(loadLucyMemoryMcpHttpConfig({
    HOST: '127.0.0.1',
    PORT: '8080',
    LUCY_MCP_HTTP_ALLOWED_ORIGINS: 'https://one.example,http://localhost:3000',
  }).allowedOrigins, ['https://one.example', 'http://localhost:3000']);

  for (const value of [
    ',',
    'https://one.example,https://one.example',
    'https://user@example.com',
    'https://one.example/path',
    'https://one.example?query=yes',
    'https://one.example#fragment',
    'ftp://one.example',
    'not-an-origin',
  ]) {
    assert.throws(() => loadLucyMemoryMcpHttpConfig({ LUCY_MCP_HTTP_ALLOWED_ORIGINS: value }));
  }
  assert.throws(() => loadLucyMemoryMcpHttpConfig({
    NODE_ENV: 'production',
    LUCY_MCP_HTTP_AUTH_MODE: 'staging-static-bearer',
    LUCY_MCP_HTTP_STATIC_BEARER_TOKEN: 'secret',
  }));
  assert.throws(() => loadLucyMemoryMcpHttpConfig({
    LUCY_MCP_HTTP_AUTH_MODE: 'staging-static-bearer',
  }));
});

test('health and MCP routes enforce the frozen method contract', async (t) => {
  const { running, url } = await runtime();
  t.after(() => running.close());

  const health = await fetch(`${url}/healthz`, {
    headers: { origin: 'https://blocked.example', authorization: 'Bearer wrong' },
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await health.json(), { status: 'ok' });

  const head = await fetch(`${url}/healthz`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength('{"status":"ok"}')));
  assert.equal(await head.text(), '');

  const healthMethod = await fetch(`${url}/healthz`, { method: 'POST' });
  assert.equal(healthMethod.status, 405);
  assert.equal(healthMethod.headers.get('allow'), 'GET, HEAD');

  const mcpMethod = await fetch(`${url}/mcp`);
  assert.equal(mcpMethod.status, 405);
  assert.equal(mcpMethod.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${url}/missing`)).status, 404);
});

test('MCP origin and staging bearer controls are exact', async (t) => {
  const { running, url } = await runtime({
    allowedOrigins: ['https://allowed.example'],
    authMode: 'staging-static-bearer',
    staticBearerToken: 'secret',
  });
  t.after(() => running.close());
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  assert.equal((await fetch(`${url}/mcp`, {
    method: 'POST', headers: { ...headers, origin: 'https://blocked.example', authorization: 'Bearer secret' }, body,
  })).status, 403);
  assert.equal((await fetch(`${url}/mcp`, {
    method: 'POST', headers: { ...headers, origin: 'https://allowed.example' }, body,
  })).status, 401);
  const accepted = await fetch(`${url}/mcp`, {
    method: 'POST', headers: { ...headers, origin: 'https://allowed.example', authorization: 'Bearer secret' }, body,
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).result.serverInfo.name, 'lucy-memory-mcp');

  const nonBrowser = await fetch(`${url}/mcp`, {
    method: 'POST', headers: { ...headers, authorization: 'Bearer secret' }, body,
  });
  assert.equal(nonBrowser.status, 200);
});

test('raw request limits reject oversized bodies before JSON parsing', async (t) => {
  const { running, url } = await runtime({ maxRequestBodySize: 16 });
  t.after(() => running.close());
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{"not":"valid protocol payload"}',
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, -32000);
});

test('shutdown aborts incomplete active request bodies', async () => {
  const { running } = await runtime();
  const { port } = running.server.address();
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write([
    'POST /mcp HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/json',
    'Content-Length: 100',
    '',
    '{',
  ].join('\r\n'));

  try {
    await Promise.race([
      running.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 500)),
    ]);
  } finally {
    socket.destroy();
  }
});

test('shutdown awaits cleanup already started by an aborted request', async () => {
  const { running } = await runtime();
  const { port } = running.server.address();
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write([
    'POST /mcp HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Content-Type: application/json',
    'Content-Length: 100',
    '',
    '{',
  ].join('\r\n'));
  socket.destroy();
  await once(running.server, 'request');

  await Promise.race([
    running.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timed out')), 500)),
  ]);
});
