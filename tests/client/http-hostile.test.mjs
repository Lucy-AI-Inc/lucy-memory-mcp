import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { MalformedResponseError, UpstreamUnavailableError, ValidationFailureError } from '../../src/client/errors.mjs';
import { createLucyHttpTransport } from '../../src/client/http-transport.mjs';

const USER = { kind: 'user' };
const TOKEN = 'super-secret-bearer-token-value';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test('HTTP transport fails closed on malformed JSON and hostile non-object bodies', async () => {
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => new Response('not-json{', { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const client = new AgentMemoryClient({
    transport, token: TOKEN, permissions: ['memory:read', 'memory:propose'],
  });
  await assert.rejects(client.recall(JSON.stringify({ query: 'n', scope: USER })), MalformedResponseError);
});

test('HTTP transport errors do not echo the bearer token', async () => {
  const transport = createLucyHttpTransport({
    baseUrl: 'https://example.test',
    maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      schema_version: '1',
      request_id: 'req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      error: { code: 'unauthenticated', message: `bad ${TOKEN}`, retryable: false },
    }), { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  const client = new AgentMemoryClient({
    transport, token: TOKEN, permissions: ['memory:read', 'memory:propose'],
  });
  const error = await client.recall(JSON.stringify({ query: 'n', scope: USER })).then(
    () => { throw new Error('expected reject'); },
    (value) => value,
  );
  assert.doesNotMatch(String(error), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(TOKEN));
});

test('HTTP transport rejects redirects before credentials can reach another origin', async (t) => {
  let redirectedRequests = 0;
  const redirectTarget = createServer((_request, response) => {
    redirectedRequests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ unexpected: true }));
  });
  const targetUrl = await listen(redirectTarget);
  const redirector = createServer((_request, response) => {
    response.writeHead(307, { location: `${targetUrl}/credential-sink` });
    response.end();
  });
  const redirectorUrl = await listen(redirector);
  t.after(async () => Promise.all([close(redirector), close(redirectTarget)]));

  const transport = createLucyHttpTransport({
    baseUrl: redirectorUrl,
    allowInsecureLoopback: true,
    maxRetries: 0,
  });
  const client = new AgentMemoryClient({ transport, token: TOKEN, permissions: ['memory:read'] });
  await assert.rejects(
    client.recall(JSON.stringify({ query: 'name', scope: USER })),
    UpstreamUnavailableError,
  );
  assert.equal(redirectedRequests, 0);
});

test('HTTP transport rejects a fourth operation', () => {
  const transport = createLucyHttpTransport({ baseUrl: 'https://example.test', maxRetries: 0 });
  assert.rejects(transport({ operation: 'resolve', payload: '{}', accessToken: TOKEN }), ValidationFailureError);
});
