import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import test from 'node:test';
import vercelHandler, { writeWebResponse } from '../../api/index.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('Vercel project source pins iad1, 2 GB, 60 seconds, and exact hosted routes', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.deepEqual(config.regions, ['iad1']);
  assert.deepEqual(config.functions['api/index.mjs'], {
    memory: 2048,
    maxDuration: 60,
    includeFiles: [
      '.github/skills/lucy-memory-first/SKILL.md',
      'contracts/agent-manifest.json',
      'schemas/**',
    ],
  });
  assert.deepEqual(config.rewrites, [
    { source: '/mcp', destination: '/api/index' },
    { source: '/healthz', destination: '/api/index' },
    { source: '/.well-known/oauth-protected-resource', destination: '/api/index' },
    { source: '/.well-known/oauth-protected-resource/mcp', destination: '/api/index' },
  ]);
  assert.equal(JSON.stringify(config).includes('secret'), false);
});

test('Vercel bundle always excludes TEST-ONLY OAuth/harness and infrastructure fixtures', () => {
  const ignored = read('.vercelignore');
  for (const required of ['scripts/e2e/', 'tests/', 'fixtures/', 'infra/', 'deploy/']) {
    assert.match(ignored, new RegExp(required.replace('/', '\\/')));
  }
  const adapter = read('api/index.mjs');
  assert.match(adapter, /handleHostedMcpRequest/);
  assert.doesNotMatch(adapter, /scripts\/e2e|test-oauth-as/);
});

test('Vercel environment example contains placeholders only and no database credentials', () => {
  const example = read('.env.vercel.example');
  for (const name of [
    'HOSTED_MCP_ENABLED', 'HOSTED_MCP_CANONICAL_URL', 'HOSTED_MCP_PRODUCT_BASE_URL',
    'HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL', 'HOSTED_MCP_OAUTH_ISSUER',
    'HOSTED_MCP_OAUTH_JWKS_URL', 'HOSTED_MCP_OAUTH_INTROSPECTION_URL',
    'HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION', 'HOSTED_MCP_LOG_HASH_KEY',
  ]) assert.match(example, new RegExp(`^${name}=`, 'm'));
  assert.doesNotMatch(example, /^(?:SUPABASE|DATABASE|POSTGRES|OPENAI|STRIPE)_/m);
  assert.match(example, /\[REDACTED_/);
});

test('exported Vercel entry accepts a web Request and returns the shared web Response', async () => {
  const prior = process.env.HOSTED_MCP_ENABLED;
  process.env.HOSTED_MCP_ENABLED = 'false';
  try {
    const response = await vercelHandler(new Request('https://mcp.example.test/healthz'));
    assert(response instanceof Response);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'disabled', enabled: false });
  } finally {
    if (prior === undefined) delete process.env.HOSTED_MCP_ENABLED;
    else process.env.HOSTED_MCP_ENABLED = prior;
  }
});

test('Vercel response piping settles when the client closes before finish', { timeout: 1_000 }, async () => {
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      queueMicrotask(() => this.emit('close'));
    },
  });
  response.writeHead = () => response;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
    },
  });

  await writeWebResponse(new Response(body), response);
  assert.equal(response.writableFinished, false);
});
