#!/usr/bin/env node
// Disposable cross-repository LUC-1078 proof. Requires Docker and network; never run against shared projects.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  E2E_CASES,
  E2E_GATE_IDS,
  E2E_PORTS,
  assertSanitizedEvidence,
  denverTimestamp,
  migrationAuthority,
  pkceChallenge,
  requireAbsoluteDirectory,
  rewriteSupabaseConfig,
  sha256File,
} from './lib.mjs';

process.env.HMCP_E2E_DISPOSABLE = '1';

const ROOT = resolve(import.meta.dirname, '../..');
const PRODUCT = requireAbsoluteDirectory(process.env.HMCP_PRODUCT_WT, 'HMCP_PRODUCT_WT');
const EVIDENCE = requireAbsoluteDirectory(process.env.HMCP_EVIDENCE_DIR, 'HMCP_EVIDENCE_DIR');
const SUPABASE_VERSION = '2.122.0';
const PRODUCT_URL = `http://127.0.0.1:${E2E_PORTS.product}`;
const MCP_URL = `http://127.0.0.1:${E2E_PORTS.mcp}/mcp`;
const OAUTH_URL = `http://127.0.0.1:${E2E_PORTS.oauth}`;
const ALICE = '11111111-1111-1111-1111-111111111111';
const WORKSPACE_A = '22222222-2222-2222-2222-222222222222';
const BOB = '33333333-3333-3333-3333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-4444-444444444444';
const SERVICE_CREDENTIAL = randomBytes(32).toString('base64url');
const UPSTREAM_SECRET = randomBytes(32).toString('base64url');
const LOG_KEY = randomBytes(32).toString('base64url');
const BINDING_CREDENTIAL = randomBytes(32).toString('base64url');
const INTROSPECTION_AUTHORIZATION = `Basic ${randomBytes(32).toString('base64url')}`;
const CONTROL_CREDENTIAL = randomBytes(32).toString('base64url');
const OBSERVER_KEY = randomBytes(32).toString('base64url');
const ALICE_PASSWORD = randomBytes(24).toString('base64url');
const BOB_PASSWORD = randomBytes(24).toString('base64url');
const MEMORY_MARKER = `hmcp-${randomBytes(12).toString('hex')}`;

async function fetch(input, init = {}) {
  const timeout = AbortSignal.timeout(30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return globalThis.fetch(input, { ...init, signal });
}

mkdirSync(EVIDENCE, { recursive: true, mode: 0o700 });
mkdirSync(join(EVIDENCE, 'logs'), { recursive: true, mode: 0o700 });
mkdirSync(join(EVIDENCE, 'assertions'), { recursive: true, mode: 0o700 });
const PRODUCT_LOG = join(EVIDENCE, 'logs/product.ndjson');
const MCP_LOG = join(EVIDENCE, 'logs/mcp.ndjson');
const OAUTH_LOG = join(EVIDENCE, 'logs/oauth.ndjson');
const OBSERVER_LOG = join(EVIDENCE, 'logs/observer.ndjson');

const tempRoot = mkdtempSync(join(tmpdir(), 'lucy-hmcp-e2e-'));
const PRODUCT_RAW_LOG = join(tempRoot, 'product.raw.log');
const MCP_RAW_LOG = join(tempRoot, 'mcp.raw.log');
const OAUTH_RAW_LOG = join(tempRoot, 'oauth.raw.log');
const projectId = `lucy-hmcp-e2e-${randomBytes(6).toString('hex')}`;
writeFileSync(join(tempRoot, '.hmcp-owned'), `${projectId}\n`, { mode: 0o600 });

const children = new Set();
let productProcess;
let adapterProcess;
let oauthProcess;
let stackStarted = false;
let keepOnFailure = process.argv.includes('--keep-on-failure');
const allowDirty = process.argv.includes('--allow-dirty');
const results = [];
const admissionEvidence = {};
const oldSchemaEvidence = {};
const sensitiveValues = new Set([
  SERVICE_CREDENTIAL, UPSTREAM_SECRET, LOG_KEY, BINDING_CREDENTIAL,
  INTROSPECTION_AUTHORIZATION, CONTROL_CREDENTIAL, OBSERVER_KEY,
  ALICE_PASSWORD, BOB_PASSWORD, MEMORY_MARKER,
  'disposable local hosted MCP proof',
]);

function rememberSensitive(value) {
  if (typeof value === 'string' && value) sensitiveValues.add(value);
  return value;
}

function safeFailureDetail(error) {
  let detail = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
  for (const value of sensitiveValues) detail = detail.replaceAll(value, '[REDACTED]');
  detail = detail
    .replace(/lucy_xc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_UPSTREAM_CREDENTIAL]')
    .replace(/(?:[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return detail.slice(0, 240);
}

function assertSafeEvidenceText(value) {
  for (const secret of sensitiveValues) {
    if (value.includes(secret)) throw new Error('refusing to persist sensitive evidence value');
  }
  if (/authorization/i.test(value)
    || /lucy_xc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)
    || /Bearer\s+\S+/i.test(value)) {
    throw new Error('refusing to persist credential-shaped evidence');
  }
}

function commandName(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

async function run(command, args, { cwd = ROOT, env = process.env, allowFailure = false } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });
  if (code !== 0 && !allowFailure) throw new Error(`${basename(command)} failed (${code}): ${stderr.slice(-1000)}`);
  return { code, stdout, stderr };
}

function spawnLogged(command, args, { cwd, env, logPath }) {
  const output = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  child.once('close', () => output.end());
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

function extractJsonLog(source, target) {
  const records = existsSync(source)
    ? readFileSync(source, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch { return []; }
      if (!value || typeof value !== 'object') return [];
      const serialized = JSON.stringify(value);
      assertSafeEvidenceText(serialized);
      return [serialized];
    })
    : [];
  writeFileSync(target, records.length ? `${records.join('\n')}\n` : '', { mode: 0o600 });
}

function refreshEvidenceLogs() {
  extractJsonLog(PRODUCT_RAW_LOG, PRODUCT_LOG);
  extractJsonLog(MCP_RAW_LOG, MCP_LOG);
  extractJsonLog(OAUTH_RAW_LOG, OAUTH_LOG);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveClose) => child.once('close', resolveClose)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10_000)).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
}

async function waitForHttp(url, { status = 200, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      last = response.status;
      if (response.status === status) return response;
    } catch (error) { last = error?.code ?? error?.name; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`readiness timeout for ${url} (last=${last})`);
}

function supabaseArgs(...args) {
  return ['-y', `supabase@${SUPABASE_VERSION}`, ...args];
}

async function supabase(...args) {
  return run(commandName('npx'), supabaseArgs(...args), { cwd: tempRoot });
}

function stageSupabase({ oldSchema = false } = {}) {
  const source = resolve(PRODUCT, 'supabase');
  const target = resolve(tempRoot, 'supabase');
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(resolve(source, 'migrations'), resolve(target, 'migrations'), { recursive: true });
  for (const name of ['seed.sql', 'templates']) {
    const from = resolve(source, name);
    if (existsSync(from)) cpSync(from, resolve(target, name), { recursive: true });
  }
  const config = rewriteSupabaseConfig(readFileSync(resolve(source, 'config.toml'), 'utf8'), projectId);
  writeFileSync(resolve(target, 'config.toml'), config, { mode: 0o600 });
  const migration = resolve(target, 'migrations/20261116051300_hosted_mcp_admission.sql');
  if (!existsSync(migration)) throw new Error('required hosted admission migration is missing');
  if (oldSchema) rmSync(migration);
}

function parseStatus(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Supabase status did not return JSON');
  const value = JSON.parse(raw.slice(start, end + 1));
  const pick = (...names) => names.map((name) => value[name]).find((entry) => typeof entry === 'string' && entry);
  const status = {
    apiUrl: pick('API_URL', 'api_url'),
    anonKey: pick('ANON_KEY', 'anon_key'),
    serviceKey: pick('SERVICE_ROLE_KEY', 'service_role_key'),
    dbUrl: pick('DB_URL', 'db_url'),
  };
  if (!status.apiUrl || !status.anonKey || !status.serviceKey) throw new Error('Supabase status is incomplete');
  return status;
}

async function startStack({ oldSchema = false } = {}) {
  stageSupabase({ oldSchema });
  // From this point cleanup owns this uniquely named project even if startup
  // fails after creating only a subset of containers.
  stackStarted = true;
  await supabase('start');
  await supabase('db', 'reset');
  const status = parseStatus((await supabase('status', '--output', 'json')).stdout);
  rememberSensitive(status.anonKey);
  rememberSensitive(status.serviceKey);
  rememberSensitive(status.dbUrl);
  return status;
}

async function stopStack() {
  if (!stackStarted) return;
  const marker = readFileSync(join(tempRoot, '.hmcp-owned'), 'utf8').trim();
  if (marker !== projectId || !/^lucy-hmcp-e2e-[a-f0-9]{12}$/.test(marker)) {
    throw new Error('refusing to stop unowned Supabase stack');
  }
  await supabase('stop', '--no-backup');
  stackStarted = false;
}

async function serviceRest(status, path, { method = 'GET', body, prefer } = {}) {
  return fetch(`${status.apiUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: status.serviceKey,
      authorization: `Bearer ${status.serviceKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(prefer ? { prefer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createUser(status, { id, email, password, name }) {
  const response = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: status.serviceKey,
      authorization: `Bearer ${status.serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id, email, password, email_confirm: true,
      user_metadata: { full_name: name },
    }),
  });
  if (!response.ok) throw new Error(`create user failed: ${response.status}`);
}

async function seed(status) {
  await createUser(status, { id: ALICE, email: 'alice-hmcp@example.test', password: ALICE_PASSWORD, name: 'Alice HMCP' });
  await createUser(status, { id: BOB, email: 'bob-hmcp@example.test', password: BOB_PASSWORD, name: 'Bob HMCP' });
  const profiles = await serviceRest(status, 'profiles?on_conflict=id', {
    method: 'POST',
    body: [
      { id: ALICE, email: 'alice-hmcp@example.test', full_name: 'Alice HMCP' },
      { id: BOB, email: 'bob-hmcp@example.test', full_name: 'Bob HMCP' },
    ],
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  if (!profiles.ok) throw new Error(`profile seed failed: ${profiles.status}`);
  const workspaces = [
    { id: WORKSPACE_A, slug: 'hmcp-workspace-a', name: 'HMCP Workspace A', owner_user_id: ALICE, plan_code: 'free', status: 'active' },
    { id: WORKSPACE_B, slug: 'hmcp-workspace-b', name: 'HMCP Workspace B', owner_user_id: BOB, plan_code: 'free', status: 'active' },
  ];
  const created = await serviceRest(status, 'workspaces?on_conflict=id', {
    method: 'POST', body: workspaces, prefer: 'resolution=merge-duplicates,return=minimal',
  });
  if (!created.ok) throw new Error(`workspace seed failed: ${created.status}`);
  // Creating the two fixed owned workspaces first lets authoritative onboarding
  // reuse them instead of bootstrapping extra default workspaces.
  for (const [userId, fullName] of [[ALICE, 'Alice HMCP'], [BOB, 'Bob HMCP']]) {
    const onboarding = await serviceRest(status, 'rpc/complete_account_onboarding', {
      method: 'POST',
      body: {
        p_user_id: userId,
        p_full_name: fullName,
        p_age: 30,
        p_occupation: 'Local test fixture',
        p_accepted_terms: true,
        p_accepted_privacy: true,
        p_terms_version: '2026-05-01',
        p_privacy_version: '2026-05-01',
      },
    });
    if (!onboarding.ok) throw new Error(`onboarding seed failed: ${onboarding.status}`);
  }
  const membership = await serviceRest(status, 'workspace_members?on_conflict=workspace_id,user_id', {
    method: 'POST',
    body: { workspace_id: WORKSPACE_B, user_id: ALICE, role: 'member', status: 'active' },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  if (!membership.ok) throw new Error(`membership seed failed: ${membership.status}`);
  const settings = await serviceRest(status, 'user_settings?on_conflict=user_id', {
    method: 'POST',
    body: [{ user_id: ALICE, auto_memory: false }, { user_id: BOB, auto_memory: false }],
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  if (!settings.ok) throw new Error(`settings seed failed: ${settings.status}`);
  const workspaceCheck = await serviceRest(status, 'workspaces?select=id');
  if (!workspaceCheck.ok || (await workspaceCheck.json()).length !== 2) {
    throw new Error('disposable seed must contain exactly two workspaces');
  }
}

async function login(status, email, password) {
  const response = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status}`);
  return rememberSensitive((await response.json()).access_token);
}

function productEnvironment(status, enabled = true) {
  return {
    ...process.env,
    NODE_ENV: 'development',
    LUCY_LAUNCH_MODE: 'test',
    PORT: String(E2E_PORTS.product),
    SUPABASE_URL: status.apiUrl,
    SUPABASE_ANON_KEY: status.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: status.serviceKey,
    LUCY_SUPABASE_SERVICE_ROLE_KEY: status.serviceKey,
    NEXT_PUBLIC_SUPABASE_URL: status.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.anonKey,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.anonKey,
    NEXT_PUBLIC_API_BASE_URL: PRODUCT_URL,
    HOSTED_MCP_PRODUCT_ENABLED: enabled ? 'true' : 'false',
    HOSTED_MCP_SERVICE_CREDENTIAL_CURRENT: SERVICE_CREDENTIAL,
    HOSTED_MCP_UPSTREAM_SIGNING_SECRET_CURRENT: UPSTREAM_SECRET,
    HOSTED_MCP_UPSTREAM_TTL_SECONDS: '900',
    OAUTH_WORKSPACE_BINDING_URL: `${OAUTH_URL}/internal/bind`,
    OAUTH_WORKSPACE_BINDING_CREDENTIAL: BINDING_CREDENTIAL,
  };
}

function adapterEnvironment(enabled = true) {
  return {
    ...process.env,
    VERCEL_ENV: 'development',
    HOSTED_MCP_ENABLED: enabled ? 'true' : 'false',
    HOSTED_MCP_CANONICAL_URL: MCP_URL,
    HOSTED_MCP_PRODUCT_BASE_URL: PRODUCT_URL,
    HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: SERVICE_CREDENTIAL,
    HOSTED_MCP_OAUTH_ISSUER: OAUTH_URL,
    HOSTED_MCP_OAUTH_JWKS_URL: `${OAUTH_URL}/jwks`,
    HOSTED_MCP_OAUTH_INTROSPECTION_URL: `${OAUTH_URL}/introspect`,
    HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION: INTROSPECTION_AUTHORIZATION,
    HOSTED_MCP_LOG_HASH_KEY: LOG_KEY,
    HOSTED_MCP_ALLOW_INSECURE_LOOPBACK: 'true',
    HMCP_OBSERVER_PATH: OBSERVER_LOG,
    HMCP_OBSERVER_KEY: OBSERVER_KEY,
  };
}

async function startOAuth() {
  oauthProcess = spawnLogged(process.execPath, [resolve(ROOT, 'scripts/e2e/test-oauth-as.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HMCP_BINDING_CREDENTIAL: BINDING_CREDENTIAL,
      HMCP_INTROSPECTION_AUTHORIZATION: INTROSPECTION_AUTHORIZATION,
      HMCP_CONTROL_CREDENTIAL: CONTROL_CREDENTIAL,
    },
    logPath: OAUTH_RAW_LOG,
  });
  await waitForHttp(`${OAUTH_URL}/.well-known/oauth-authorization-server`);
}

async function startProduct(status, enabled = true) {
  const next = resolve(PRODUCT, 'node_modules/.bin', process.platform === 'win32' ? 'next.cmd' : 'next');
  productProcess = spawnLogged(next, ['dev', '--webpack', '-p', String(E2E_PORTS.product)], {
    cwd: PRODUCT, env: productEnvironment(status, enabled), logPath: PRODUCT_RAW_LOG,
  });
  await waitForHttp(`${PRODUCT_URL}/api/health`);
}

async function restartProduct(status, enabled) {
  await stopChild(productProcess);
  await startProduct(status, enabled);
}

async function startAdapter(enabled = true) {
  adapterProcess = spawnLogged(process.execPath, [resolve(ROOT, 'scripts/e2e/node-adapter.mjs')], {
    cwd: ROOT, env: adapterEnvironment(enabled), logPath: MCP_RAW_LOG,
  });
  await waitForHttp(`http://127.0.0.1:${E2E_PORTS.mcp}/healthz`);
}

async function restartAdapter(enabled) {
  await stopChild(adapterProcess);
  await startAdapter(enabled);
}

async function oauthControl(path, body) {
  const response = await fetch(`${OAUTH_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CONTROL_CREDENTIAL}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  if (!response.ok && response.status !== 302) throw new Error(`OAuth control failed: ${path} ${response.status}`);
  return response;
}

async function authorizeWorkspace(sessionToken, workspaceId, scope = 'memory:read memory:propose') {
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const authorize = new URL(`${OAUTH_URL}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: 'hmcp-e2e-client', redirect_uri: `${OAUTH_URL}/callback`,
    scope, state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
  });
  const started = await fetch(authorize);
  assert.equal(started.status, 200);
  const { authorization_id: authorizationId } = await started.json();
  const binding = await fetch(`${PRODUCT_URL}/api/oauth/workspace-binding`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ authorization_id: authorizationId, workspace_id: workspaceId }),
  });
  assert.equal(binding.status, 200);
  const approved = await fetch(`${OAUTH_URL}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorization_id: authorizationId }), redirect: 'manual',
  });
  assert.equal(approved.status, 302);
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, `${OAUTH_URL}/callback`);
  assert.equal(redirect.searchParams.get('state'), state);
  const tokenResponse = await fetch(`${OAUTH_URL}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: 'hmcp-e2e-client',
      redirect_uri: `${OAUTH_URL}/callback`, code: redirect.searchParams.get('code'), code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  return rememberSensitive((await tokenResponse.json()).access_token);
}

async function mintToken({ subject = ALICE, workspaceId = WORKSPACE_A, scope = 'memory:read memory:propose', claimOverrides = {} } = {}) {
  const response = await oauthControl('/__test/mint', {
    subject, workspace_id: workspaceId, scope, claim_overrides: claimOverrides,
  });
  return rememberSensitive((await response.json()).access_token);
}

async function rawMcp(token, body, headers = {}) {
  return fetch(MCP_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body,
  });
}

async function openMcpClient(token, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    authProvider: { token: async () => token },
    requestInit: { headers },
    onInsufficientScope: 'throw',
  });
  const client = new Client({ name: 'hmcp-e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function directAdmission(path, body) {
  const requestId = `req_${randomBytes(16).toString('hex')}`;
  const response = await fetch(`${PRODUCT_URL}/api/internal/hosted-mcp/v1/${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json', authorization: `Bearer ${SERVICE_CREDENTIAL}`,
      'content-type': 'application/json', 'x-request-id': requestId,
    },
    body: JSON.stringify(path === 'admission/acquire' ? { ...body, client_id: 'lucy-memory-mcp', request_id: requestId } : body),
  });
  const parsed = await response.json();
  if (typeof parsed.lease === 'string') rememberSensitive(parsed.lease);
  return { response, body: parsed };
}

function observerRecords() {
  if (!existsSync(OBSERVER_LOG)) return [];
  return readFileSync(OBSERVER_LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function productObserverCount() {
  return observerRecords().filter(({ event }) => event === 'hosted_mcp_fetch_observer_product').length;
}

async function releaseLeases(leases) {
  await Promise.allSettled(leases.map((lease) => directAdmission('admission/release', { lease })));
}

async function record(id, action) {
  const started = Date.now();
  try {
    const detail = await action();
    const safe = typeof detail === 'string' ? detail : 'ok';
    results.push({ id, gate_ids: E2E_GATE_IDS[id], status: 'PASS', detail: safe, duration_ms: Date.now() - started });
    console.log(`E2E_CASE ${id} PASS ${safe}`);
  } catch (error) {
    const detail = safeFailureDetail(error);
    results.push({ id, gate_ids: E2E_GATE_IDS[id], status: 'FAIL', detail, duration_ms: Date.now() - started });
    console.log(`E2E_CASE ${id} FAIL ${detail}`);
  }
}

function toolBody(name, args, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

async function main() {
  const mcpSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const productSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: PRODUCT })).stdout.trim();
  const npmVersion = (await run(commandName('npm'), ['--version'])).stdout.trim();
  const mcpDirty = (await run('git', ['status', '--porcelain'], { cwd: ROOT })).stdout.trim().length > 0;
  const productDirty = (await run('git', ['status', '--porcelain'], { cwd: PRODUCT })).stdout.trim().length > 0;
  if ((mcpDirty || productDirty) && !allowDirty) {
    throw new Error('dirty checkout refused; use --allow-dirty only for non-certifying developer evidence');
  }
  const migrationFiles = readdirSync(resolve(PRODUCT, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql')).map((name) => resolve(PRODUCT, 'supabase/migrations', name));
  const migration = migrationAuthority(migrationFiles);
  assert.equal(basename(migration), '20261116051300_hosted_mcp_admission.sql');

  await startOAuth();
  let status = await startStack();
  writeFileSync(join(EVIDENCE, 'supabase-config.json'), `${JSON.stringify(assertSanitizedEvidence({
    disposable_project_id: projectId,
    ports: E2E_PORTS,
    db_major_version: 17,
    source: 'PRODUCT supabase/config.toml rewritten in owned temporary directory',
  }), null, 2)}\n`);
  writeFileSync(join(EVIDENCE, 'hosted-config.json'), `${JSON.stringify(assertSanitizedEvidence({
    mcp: {
      canonical_url: MCP_URL,
      product_origin: PRODUCT_URL,
      oauth_issuer: OAUTH_URL,
      auth_mode: 'oauth',
      enabled: true,
      call_timeout_ms: 55_000,
    },
    product: {
      enabled: true,
      upstream_ttl_seconds: 900,
      admission_authority: 'owned local Postgres',
    },
  }), null, 2)}\n`);
  await seed(status);
  await startProduct(status, true);
  await startAdapter(true);
  const aliceSession = await login(status, 'alice-hmcp@example.test', ALICE_PASSWORD);
  const bobSession = await login(status, 'bob-hmcp@example.test', BOB_PASSWORD);
  let aliceToken;
  let bobToken;
  let mcp;
  let proposalId;

  await record('oauth_code_flow', async () => {
    aliceToken = await authorizeWorkspace(aliceSession, WORKSPACE_A);
    bobToken = await authorizeWorkspace(bobSession, WORKSPACE_B);
    return 'PKCE S256 workspace binding completed before code exchange';
  });
  await record('initialize', async () => {
    mcp = await openMcpClient(aliceToken);
    assert.equal(mcp.client.getServerVersion().name, 'lucy-memory-mcp');
    return 'official pinned MCP client initialized over Streamable HTTP';
  });
  await record('tools_list', async () => {
    const listed = await mcp.client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name), ['memory_recall', 'memory_propose', 'memory_proposal_status']);
    assert.equal(listed.tools.length, 3);
    return 'exact three-tool surface';
  });
  await record('recall', async () => {
    const recalled = await mcp.client.callTool({ name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' } } });
    assert.equal(recalled.isError, undefined);
    assert.equal(recalled.structuredContent.consistency, 'canonical_active');
    return 'canonical empty recall accepted';
  });
  await record('propose', async () => {
    const proposed = await mcp.client.callTool({
      name: 'memory_propose',
      arguments: {
        operation: 'create', key: `e2e.${MEMORY_MARKER}`, kind: 'fact', scope: { kind: 'user' },
        content: MEMORY_MARKER, justification: 'disposable local hosted MCP proof', idempotency_key: randomUUID(),
      },
    });
    assert.equal(proposed.isError, undefined);
    assert.equal(proposed.structuredContent.status, 'pending');
    proposalId = rememberSensitive(proposed.structuredContent.id);
    return 'pending proposal returned';
  });
  await record('proposal_status', async () => {
    const statusResult = await mcp.client.callTool({ name: 'memory_proposal_status', arguments: { proposal_id: proposalId } });
    assert.equal(statusResult.structuredContent.status, 'pending');
    return 'pending status observed';
  });
  await record('pending_not_recallable', async () => {
    const pendingRecall = await mcp.client.callTool({ name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' } } });
    assert.equal(JSON.stringify(pendingRecall.structuredContent.results).includes(MEMORY_MARKER), false);
    const decoded = await run(resolve(PRODUCT, 'node_modules/.bin/tsx'), [resolve(ROOT, 'scripts/e2e/decode-proposal.mts'), PRODUCT, proposalId], { cwd: PRODUCT });
    const approval = await fetch(`${PRODUCT_URL}/api/lucy/proposals/${encodeURIComponent(decoded.stdout.trim())}/approve`, {
      method: 'POST', headers: { authorization: `Bearer ${aliceSession}`, 'x-lucy-workspace-id': WORKSPACE_A },
    });
    assert.equal(approval.status, 200);
    const approvedRecall = await mcp.client.callTool({ name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' } } });
    assert.equal(JSON.stringify(approvedRecall.structuredContent.results).includes(MEMORY_MARKER), true);
    return 'pending invisible, then human approval made it recallable';
  });
  await record('missing_token', async () => {
    const response = await rawMcp(null, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_token' });
    assert.match(response.headers.get('www-authenticate'), /\.well-known\/oauth-protected-resource\/mcp/);
    return '401 invalid_token with path-suffixed metadata challenge';
  });
  await record('wrong_audience_resource', async () => {
    const before = productObserverCount();
    const token = await mintToken({ claimOverrides: { aud: 'http://wrong.invalid/mcp', resource: 'http://wrong.invalid/mcp' } });
    const response = await rawMcp(token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    assert.equal(response.status, 401);
    assert.equal(productObserverCount(), before);
    return 'wrong audience/resource rejected before PRODUCT';
  });
  await record('expired_early_token', async () => {
    const seconds = Math.floor(Date.now() / 1000);
    for (const overrides of [{ exp: seconds - 60 }, { nbf: seconds + 60 }]) {
      const token = await mintToken({ claimOverrides: overrides });
      assert.equal((await rawMcp(token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status, 401);
    }
    return 'expired and not-before-future tokens rejected';
  });
  await record('revoked_token', async () => {
    const token = await mintToken();
    await oauthControl('/revoke', { token });
    assert.equal((await rawMcp(token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status, 401);
    return 'introspection revocation enforced';
  });
  await record('introspection_unreachable', async () => {
    const before = productObserverCount();
    await oauthControl('/__test/control', { introspection_available: false });
    try {
      const response = await rawMcp(aliceToken, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'hosted_mcp_unavailable' });
      assert.equal(productObserverCount(), before);
    } finally {
      await oauthControl('/__test/control', { introspection_available: true });
    }
    return 'provider outage failed closed';
  });
  await record('missing_scope', async () => {
    const token = await mintToken({ scope: 'memory:read' });
    const response = await rawMcp(token, toolBody('memory_propose', {}));
    assert.equal(response.status, 403);
    assert.match(response.headers.get('www-authenticate'), /error="insufficient_scope".*scope="memory:propose"/);
    return '403 exact propose scope challenge';
  });
  await record('cross_workspace', async () => {
    const other = await openMcpClient(bobToken);
    try {
      const recalled = await other.client.callTool({ name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' } } });
      const statusResult = await other.client.callTool({ name: 'memory_proposal_status', arguments: { proposal_id: proposalId } });
      assert.equal(JSON.stringify(recalled).includes(MEMORY_MARKER), false);
      assert.equal(JSON.stringify(statusResult).includes(MEMORY_MARKER), false);
      assert.equal(statusResult.isError, true);
    } finally { await other.close(); }
    return 'workspace B cannot observe workspace A memory/proposal';
  });
  await record('workspace_override', async () => {
    const before = observerRecords().length;
    const overridden = await openMcpClient(aliceToken, { 'x-lucy-workspace-id': WORKSPACE_B });
    try {
      const recalled = await overridden.client.callTool({ name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' } } });
      assert.equal(JSON.stringify(recalled).includes(MEMORY_MARKER), true);
      const invalid = await overridden.client.callTool({
        name: 'memory_recall', arguments: { query: MEMORY_MARKER, scope: { kind: 'user' }, workspace_id: WORKSPACE_B },
      });
      assert.equal(invalid.isError, true);
    } finally { await overridden.close(); }
    const upstream = observerRecords().slice(before)
      .filter(({ event }) => event === 'hosted_mcp_fetch_observer');
    assert(upstream.length > 0);
    assert(upstream.every(({ workspace_header_present: present }) => present === false));
    return 'header stripped upstream and tool workspace field schema-rejected';
  });
  await record('no_passthrough', async () => {
    const observations = readFileSync(OBSERVER_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const upstream = observations.filter(({ event }) => event === 'hosted_mcp_fetch_observer');
    assert(upstream.length > 0);
    assert(upstream.every((entry) => entry.auth_scheme === 'bearer_lucy_xc1' && entry.client_upstream_equal === false));
    return 'observer proves client and upstream credentials differ';
  });
  await record('raw_body_limit', async () => {
    const before = productObserverCount();
    assert.equal((await rawMcp(aliceToken, ' '.repeat(8_193))).status, 413);
    assert.equal(productObserverCount(), before);
    const base = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const boundary = `${' '.repeat(8_192 - Buffer.byteLength(base))}${base}`;
    assert.notEqual((await rawMcp(aliceToken, boundary)).status, 413);
    return '8193 rejected and 8192 accepted by size gate';
  });
  await record('scope_concurrency', async () => {
    const leases = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const acquired = await directAdmission('admission/acquire', {
          subject: ALICE, workspace_id: WORKSPACE_A, operation: 'memory_recall',
        });
        assert.equal(acquired.response.status, 200);
        leases.push(acquired.body.lease);
      }
      const rejected = await rawMcp(aliceToken, toolBody('memory_recall', { query: 'limit', scope: { kind: 'user' } }));
      assert.equal(rejected.status, 429);
      assert.equal((await rejected.json()).limit, 'scope');
    } finally { await releaseLeases(leases); }
    admissionEvidence.scope_concurrency = 'database-backed sixth call rejected';
    return 'scope concurrency 5 enforced';
  });
  await record('scope_rate', async () => {
    for (let index = 0; index < 120; index += 1) {
      const acquired = await directAdmission('admission/acquire', {
        subject: BOB, workspace_id: WORKSPACE_B, operation: 'memory_propose',
      });
      assert.equal(acquired.response.status, 200);
      await directAdmission('admission/release', { lease: acquired.body.lease });
    }
    const token = await mintToken({ subject: BOB, workspaceId: WORKSPACE_B, scope: 'memory:propose' });
    const rejected = await rawMcp(token, toolBody('memory_propose', {}));
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).limit, 'scope');
    admissionEvidence.scope_rate = 'database-backed 121st admission rejected';
    return 'scope rate 120/5min enforced';
  });
  await record('global_cap', async () => {
    const leases = [];
    try {
      for (let index = 0; index < 50; index += 1) {
        const acquired = await directAdmission('admission/acquire', {
          subject: randomUUID(), workspace_id: randomUUID(), operation: 'memory_proposal_status',
        });
        assert.equal(acquired.response.status, 200);
        leases.push(acquired.body.lease);
      }
      const rejected = await rawMcp(aliceToken, toolBody('memory_proposal_status', { proposal_id: proposalId }));
      assert.equal(rejected.status, 429);
      assert.equal((await rejected.json()).limit, 'global');
    } finally { await releaseLeases(leases); }
    const recovered = await rawMcp(aliceToken, toolBody('memory_proposal_status', { proposal_id: proposalId }));
    assert.notEqual(recovered.status, 429);
    admissionEvidence.global_cap = '50 held globally; release restored capacity';
    return 'global 50 cap and release recovery enforced';
  });
  await record('mcp_kill_switch', async () => {
    await restartAdapter(false);
    try {
      const response = await rawMcp(aliceToken, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      assert.equal(response.status, 503);
      assert.equal((await fetch(`${PRODUCT_URL}/api/health`)).status, 200);
      const health = await (await fetch(`http://127.0.0.1:${E2E_PORTS.mcp}/healthz`)).json();
      assert.equal(health.enabled, false);
    } finally { await restartAdapter(true); }
    return 'MCP switch disabled calls without affecting PRODUCT health';
  });
  await record('product_kill_switch', async () => {
    await restartProduct(status, false);
    try {
      const response = await rawMcp(aliceToken, toolBody('memory_recall', { query: 'switch', scope: { kind: 'user' } }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'hosted_mcp_disabled' });
      assert.equal((await fetch(`${PRODUCT_URL}/api/health`)).status, 200);
    } finally { await restartProduct(status, true); }
    return 'PRODUCT switch disabled hosted calls without affecting health';
  });
  await mcp.close();
  await record('log_redaction', async () => {
    refreshEvidenceLogs();
    const logs = [MCP_LOG, PRODUCT_LOG, OAUTH_LOG, OBSERVER_LOG].map((path) => readFileSync(path, 'utf8')).join('\n');
    for (const forbidden of sensitiveValues) {
      assert.equal(logs.includes(forbidden), false);
    }
    assert.doesNotMatch(logs, /authorization/i);
    const parsedMcp = readFileSync(MCP_LOG, 'utf8').split('\n').filter((line) => line.includes('hosted_mcp_request')).map(JSON.parse);
    assert(parsedMcp.some((entry) => entry.request_id && entry.subject_hash?.startsWith('h1:')));
    const terminalKeys = [
      'admission_outcome', 'event', 'http_status', 'latency_ms', 'level', 'outcome',
      'request_id', 'subject_hash', 'timestamp', 'tool', 'upstream_status', 'workspace_hash',
    ];
    assert(parsedMcp.length > 0);
    for (const entry of parsedMcp) assert.deepEqual(Object.keys(entry).sort(), terminalKeys);
    writeFileSync(join(EVIDENCE, 'assertions/redaction.json'), `${JSON.stringify({ passed: true, files_scanned: 4 }, null, 2)}\n`);
    return 'required hashes present; known sensitive values absent';
  });

  await stopChild(adapterProcess);
  await stopChild(productProcess);
  await stopStack();
  status = await startStack({ oldSchema: true });
  await seed(status);
  await startProduct(status, true);
  await startAdapter(true);
  await record('old_schema', async () => {
    const session = await login(status, 'alice-hmcp@example.test', ALICE_PASSWORD);
    const token = await authorizeWorkspace(session, WORKSPACE_A);
    const before = existsSync(OBSERVER_LOG) ? readFileSync(OBSERVER_LOG, 'utf8').split('\n').length : 0;
    const response = await rawMcp(token, toolBody('memory_recall', { query: 'old-schema', scope: { kind: 'user' } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'hosted_mcp_unavailable' });
    assert.equal((await fetch(`${PRODUCT_URL}/api/health`)).status, 200);
    const afterLines = readFileSync(OBSERVER_LOG, 'utf8').split('\n').slice(before).filter(Boolean).map(JSON.parse);
    assert.equal(afterLines.some(({ event }) => event === 'hosted_mcp_fetch_observer'), false);
    oldSchemaEvidence.result = 'hosted 503, product health 200, no Agent Memory fetch';
    return 'missing admission schema failed closed without upstream call';
  });
  refreshEvidenceLogs();

  const manifest = assertSanitizedEvidence({
    evidence_mode: mcpDirty || productDirty ? 'local_non_certifying_dirty' : 'local_certifying',
    mcp_sha: mcpSha,
    product_sha: productSha,
    mcp_dirty: mcpDirty,
    product_dirty: productDirty,
    allow_dirty: allowDirty,
    node_version: process.version,
    npm_version: npmVersion,
    supabase_cli_version: SUPABASE_VERSION,
    mcp_sdk_version: JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).dependencies['@modelcontextprotocol/server'],
    migration_filename: basename(migration),
    migration_sha256: sha256File(migration),
    timestamp_utc: new Date().toISOString(),
    timestamp_america_denver: denverTimestamp(),
    ports: E2E_PORTS,
    command: 'HMCP_PRODUCT_WT=<absolute> HMCP_EVIDENCE_DIR=<absolute> node scripts/e2e/hosted-local.mjs',
  });
  writeFileSync(join(EVIDENCE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(EVIDENCE, 'dependency-inventory.json'), `${JSON.stringify({
    node: process.version,
    npm: npmVersion,
    supabase_cli: SUPABASE_VERSION,
    modelcontextprotocol_server: JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).dependencies['@modelcontextprotocol/server'],
    modelcontextprotocol_client: JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).devDependencies['@modelcontextprotocol/client'],
    package_lock_sha256: sha256File(resolve(ROOT, 'package-lock.json')),
  }, null, 2)}\n`);
  writeFileSync(join(EVIDENCE, 'assertions/admission.json'), `${JSON.stringify(admissionEvidence, null, 2)}\n`);
  writeFileSync(join(EVIDENCE, 'assertions/old-schema.json'), `${JSON.stringify(oldSchemaEvidence, null, 2)}\n`);
}

function writeResultEvidence() {
  const harnessFailure = fatal ? safeFailureDetail(fatal) : null;
  writeFileSync(join(EVIDENCE, 'results.json'), `${JSON.stringify(assertSanitizedEvidence({
    harness_status: harnessFailure ? 'FAIL' : 'PASS',
    harness_failure: harnessFailure,
    results,
  }), null, 2)}\n`);
  const xml = (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="hosted-mcp-local" tests="${results.length}" failures="${results.filter(({ status: value }) => value === 'FAIL').length}" errors="${harnessFailure ? 1 : 0}">\n${results.map((result) => `  <testcase name="${result.id}" classname="${result.gate_ids.join(',')}" time="${result.duration_ms / 1000}">${result.status === 'FAIL' ? `<failure message="${xml(result.detail)}" />` : ''}</testcase>`).join('\n')}${harnessFailure ? `\n  <system-err>${xml(harnessFailure)}</system-err>` : ''}\n</testsuite>\n`;
  writeFileSync(join(EVIDENCE, 'junit.xml'), junit);
}

function writeEvidenceSums() {
  const evidenceFiles = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== 'SHA256SUMS') evidenceFiles.push(path);
    }
  }
  walk(EVIDENCE);
  const sums = evidenceFiles.sort().map((path) => `${sha256File(path)}  ${relative(EVIDENCE, path)}`).join('\n');
  writeFileSync(join(EVIDENCE, 'SHA256SUMS'), `${sums}\n`);
}

let fatal;
try {
  await main();
} catch (error) {
  fatal = error;
  appendFileSync(join(EVIDENCE, 'harness-error.txt'), `${safeFailureDetail(error)}\n`, { mode: 0o600 });
} finally {
  await Promise.allSettled([stopChild(adapterProcess), stopChild(productProcess), stopChild(oauthProcess)]);
  let cleanupStatus = 'complete';
  try { await stopStack(); } catch (error) {
    cleanupStatus = 'failed';
    if (!fatal) fatal = error;
  }
  const completedIds = new Set(results.map(({ id }) => id));
  for (const id of E2E_CASES) {
    if (!completedIds.has(id)) {
      const detail = 'not run after harness failure';
      results.push({ id, gate_ids: E2E_GATE_IDS[id], status: 'FAIL', detail, duration_ms: 0 });
      console.log(`E2E_CASE ${id} FAIL ${detail}`);
    }
  }
  const failed = results.filter(({ status }) => status === 'FAIL').length + (fatal ? 1 : 0);
  const total = E2E_CASES.length;
  const finalStatus = failed === 0 && results.length === total ? 'PASS' : 'FAIL';
  const passed = results.filter(({ status }) => status === 'PASS').length;
  writeFileSync(join(EVIDENCE, 'assertions/cleanup.json'), `${JSON.stringify({
    owned_project_stopped: cleanupStatus === 'complete',
    temporary_workdir_removal: !keepOnFailure || failed === 0 ? 'scheduled' : 'preserved_for_failure_diagnosis',
  }, null, 2)}\n`);
  writeResultEvidence();
  writeFileSync(join(EVIDENCE, finalStatus), `${finalStatus} ${passed}/${total}\n`);
  writeFileSync(join(EVIDENCE, 'report.txt'), `E2E_RESULT ${finalStatus} ${passed}/${total}\n`);
  writeEvidenceSums();
  console.log(`E2E_RESULT ${finalStatus} ${passed}/${total}`);
  if (!keepOnFailure || failed === 0) rmSync(tempRoot, { recursive: true, force: true });
  if (fatal) console.error(safeFailureDetail(fatal));
  if (failed > 0 || results.length !== total) process.exitCode = 1;
}
