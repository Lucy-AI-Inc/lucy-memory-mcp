import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vercelHandler, { writeWebResponse } from '../../api/index.mjs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const gitFiles = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);

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

test('Vercel packed source includes the usage skill and excludes TEST-ONLY files', () => {
  const tracked = gitFiles(['ls-files', '-z']);
  const ignored = new Set(gitFiles(['ls-files', '-ciz', '--exclude-from=.vercelignore']));
  const packed = tracked.filter((path) => !ignored.has(path));
  const config = JSON.parse(read('vercel.json'));
  const includeFiles = config.functions['api/index.mjs'].includeFiles;
  const bundled = packed.filter((path) => includeFiles.some((pattern) => (
    pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern
  )));

  assert.ok(bundled.includes('.github/skills/lucy-memory-first/SKILL.md'));
  assert.equal(packed.some((path) => path.startsWith('.github/')
    && path !== '.github/skills/lucy-memory-first/SKILL.md'), false);
  for (const prefix of ['scripts/e2e/', 'tests/', 'fixtures/', 'infra/', 'deploy/']) {
    assert.equal(packed.some((path) => path.startsWith(prefix)), false, `${prefix} was packed`);
  }
  for (const path of ['scripts/private-beta-certify.mjs', 'scripts/hosted-mcp-drill.mjs']) {
    assert.equal(packed.includes(path), false, `${path} was packed`);
  }
});

test('onboarding usage is importable when the usage skill file is missing', async (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'lucy-missing-skill-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  mkdirSync(join(temporaryRoot, 'src/onboarding'), { recursive: true });
  mkdirSync(join(temporaryRoot, 'contracts'));
  copyFileSync(new URL('../../src/onboarding/usage.mjs', import.meta.url),
    join(temporaryRoot, 'src/onboarding/usage.mjs'));
  copyFileSync(new URL('../../contracts/agent-manifest.json', import.meta.url),
    join(temporaryRoot, 'contracts/agent-manifest.json'));

  const usage = await import(pathToFileURL(join(temporaryRoot, 'src/onboarding/usage.mjs')));
  assert.equal(usage.LUCY_USAGE_SKILL, '');
  assert.equal(usage.usageSkillText(), '');
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

test('Vercel response piping settles when the client already closed', { timeout: 1_000 }, async () => {
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  response.writeHead = () => response;
  response.destroy();
  await new Promise((resolve) => response.once('close', resolve));

  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
    },
    cancel() {
      cancelled = true;
    },
  });

  await writeWebResponse(new Response(body), response);
  assert.equal(cancelled, true);
  assert.equal(response.writableFinished, false);
});
