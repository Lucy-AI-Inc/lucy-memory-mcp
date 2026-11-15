#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listenIsolatedAm01 } from '../tests/e2e/isolated-am01-authority.mjs';
import { lucyMcpConfig } from '../src/integrations/hermes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS = ['memory_recall', 'memory_propose', 'memory_proposal_status'];
const DEPENDENCIES = ['LUC-1073', 'LUC-1074', 'LUC-1075', 'LUC-1076', 'LUC-1077', 'LUC-905'];
const HOSTED_GATES = [
  ['staging adapter and HTTPS endpoint', 'staging_adapter'],
  ['OAuth resource server', 'oauth_resource_server'],
  ['audience and client credentials', 'audience_client_credentials'],
  ['product credential exchange integration', 'exchange_integration'],
  ['two disposable workspaces', 'disposable_workspaces'],
  ['hosted revocation and TTL', 'revocation_ttl'],
  ['hosted limit and billing behavior', 'limit_billing'],
  ['sampled hosted log access', 'sampled_logs'],
  ['explicit auto-memory policy', 'auto_memory_policy'],
  ['deployment region selected', 'deployment_region'],
  ['public hostname selected', 'public_hostname'],
  ['Auto Scaling configuration selected', 'auto_scaling'],
];

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

export function privateBetaDecision({ local, external = {} }) {
  const gates = [
    ['local certification', local?.passed === true],
    ...DEPENDENCIES.map((id) => [`${id} resolved`, external.dependencies?.[id] === 'passed']),
    ...HOSTED_GATES.map(([name, key]) => [name, external.hosted_readiness?.[key]?.passed === true]),
    ['hosted connector SHA recorded', /^[0-9a-f]{40}$/.test(external.hosted_shas?.connector ?? '')],
    ['hosted service SHA recorded', /^[0-9a-f]{40}$/.test(external.hosted_shas?.service ?? '')],
    ['hosted harness SHA recorded', /^[0-9a-f]{40}$/.test(external.hosted_shas?.harness ?? '')],
    ['hosted Claude-compatible HTTP MCP conformance', external.http_mcp?.passed === true],
    ['hosted adversarial isolation suite', external.adversarial?.passed === true],
    ['real before/during chat comparison', external.chat_comparison?.evidence_mode === 'hosted' && external.chat_comparison?.passed === true],
    ['hosted kill switch with healthy chat', external.kill_switch?.passed === true && external.kill_switch?.chat_healthy === true],
    ['Linux Hermes install and rollback', external.hermes_rollback?.platform === 'linux' && external.hermes_rollback?.passed === true],
    ['support capacity and named owners', external.support?.capacity_confirmed === true && external.support?.owners?.length > 0],
  ].map(([name, passed]) => ({ name, passed, status: passed ? 'PASS' : 'BLOCKED' }));
  return {
    decision: gates.every(({ passed }) => passed) ? 'GO' : 'NO-GO',
    policy: 'fail_closed',
    gates,
    blockers: gates.filter(({ passed }) => !passed).map(({ name }) => name),
  };
}

export function renderGoNoGo(evidence) {
  const decision = evidence.go_no_go;
  return `# LUC-1078 private-beta go/no-go

- Decision: **${decision.decision}**
- Policy: \`${decision.policy}\`
- Evidence mode: \`${evidence.evidence_mode}\`
- Generated: \`${evidence.generated_at}\`
- Repository SHA: \`${evidence.repository.commit_sha}\`
- Evidence SHA-256: \`${evidence.evidence_sha256}\`

Local/mock results are not hosted proof. A gate remains blocked unless its external evidence was explicitly supplied and reviewed.

| Gate | Status |
| --- | --- |
${decision.gates.map(({ name, status }) => `| ${name} | ${status} |`).join('\n')}

## Blockers

${decision.blockers.length === 0 ? 'None.' : decision.blockers.map((blocker) => `- ${blocker}`).join('\n')}
`;
}

function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentage) - 1];
}

async function connect(baseUrl, token) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, 'src/mcp/bin.mjs')],
    cwd: ROOT,
    stderr: 'pipe',
    env: {
      LUCY_MEMORY_BASE_URL: baseUrl,
      LUCY_MEMORY_TOKEN: token,
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: 'true',
    },
  });
  const client = new Client({ name: 'lucy-private-beta-certifier', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function exerciseLifecycle(client, authority) {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const scope = { kind: 'project', id: `project_cert_${suffix}` };
  const key = `certification.${suffix}`;
  const proposal = await client.callTool({
    name: 'memory_propose',
    arguments: {
      operation: 'create', key, kind: 'fact', scope, content: 'Disposable private-beta certification record.',
      justification: 'Authorized disposable-workspace lifecycle certification.',
      idempotency_key: randomUUID(),
    },
  });
  if (proposal.isError || proposal.structuredContent?.status !== 'pending') {
    throw new Error(`Proposal did not enter pending state: ${JSON.stringify({
      isError: proposal.isError ?? false,
      structuredContent: proposal.structuredContent ?? null,
      content: proposal.content ?? null,
    })}`);
  }
  const before = await client.callTool({ name: 'memory_recall', arguments: { query: key, scope } });
  if (before.structuredContent?.results?.length !== 0) throw new Error('Pending proposal was recallable.');
  const approved = authority.approve(proposal.structuredContent.id);
  if (approved.status !== 200) throw new Error(`Test authority approval failed with ${approved.status}.`);
  const status = await client.callTool({
    name: 'memory_proposal_status',
    arguments: { proposal_id: proposal.structuredContent.id },
  });
  const after = await client.callTool({ name: 'memory_recall', arguments: { query: key, scope } });
  if (status.structuredContent?.status !== 'approved' || after.structuredContent?.results?.length !== 1) {
    throw new Error('Approved proposal was not observable through status and recall.');
  }
  return { passed: true, proposal_id: proposal.structuredContent.id, pending_not_recallable: true, approved_recallable: true };
}

async function sustainedLoad(client, durationMs, concurrency) {
  const latencies = [];
  let requests = 0;
  let errors = 0;
  const deadline = performance.now() + durationMs;
  const worker = async () => {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        await client.callTool({ name: 'memory_recall', arguments: { query: 'certification load', scope: { kind: 'workspace' } } });
      } catch {
        errors += 1;
      } finally {
        requests += 1;
        latencies.push(performance.now() - started);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return {
    passed: requests > 0 && errors === 0,
    duration_ms: durationMs,
    concurrency,
    requests,
    errors,
    error_rate: requests === 0 ? 1 : errors / requests,
    p50_ms: percentile(latencies, 0.5),
    p95_ms: percentile(latencies, 0.95),
  };
}

async function validateTemplates() {
  const [generic, cursor] = await Promise.all([
    readJson(resolve(ROOT, 'src/clients/generic.mcp.json')),
    readJson(resolve(ROOT, 'src/clients/cursor.json')),
  ]);
  const valid = (entry) => Boolean(entry?.command === 'lucy-memory-mcp'
    && entry?.env?.LUCY_MEMORY_BASE_URL
    && entry?.env?.LUCY_MEMORY_TOKEN);
  return {
    generic_inspector: { passed: valid(generic.mcpServers?.lucy), transport: 'stdio' },
    cursor: { passed: valid(cursor.mcpServers?.lucy), transport: 'stdio' },
    claude_compatible_http: {
      passed: false,
      status: 'external_gate',
      transport: 'streamable_http',
      endpoint: process.env.LUCY_MCP_HTTP_URL ?? null,
      reason: process.env.LUCY_MCP_HTTP_URL ? 'Hosted execution is not performed by local/mock certification.' : 'LUCY_MCP_HTTP_URL was not supplied.',
    },
  };
}

function compareChatInputs(before, during) {
  if (!before || !during) return null;
  const delta = (key) => Number.isFinite(before[key]) && Number.isFinite(during[key])
    ? during[key] - before[key]
    : null;
  return {
    p95_ms_delta: delta('p95_ms'),
    error_rate_delta: delta('error_rate'),
  };
}

function validateHermesPackage(baseUrl) {
  const artifact = {
    path: ROOT,
    node_path: process.execPath,
    entrypoint: resolve(ROOT, 'src/mcp/bin.mjs'),
    version: 'local',
    artifact_digest: '0'.repeat(64),
    source_git_sha: '0'.repeat(40),
    package_name: '@trylucy/agent-memory',
    package_version: '0.1.3',
    source_repository: 'Lucy-AI-Inc/lucy-memory-mcp',
    compatibility: { node: '>=20 <25', hermes: 'operator-verified' },
    receiptPath: resolve(ROOT, '.tmp/private-beta/hermes-receipt.json'),
  };
  const config = lucyMcpConfig({
    baseUrl, tokenEnv: 'LUCY_MEMORY_TOKEN', allowInsecureLoopback: true, artifact,
  });
  return {
    package_path: config.args[0],
    config_shape_passed: config.command === process.execPath && config.env.LUCY_MEMORY_TOKEN === '${LUCY_MEMORY_TOKEN}',
    native_rollback: process.platform === 'linux' ? 'not_run_locally' : 'requires_supported_linux_host',
  };
}

async function readJson(path) {
  if (!path) return null;
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function parseArgs(argv) {
  const options = { output: resolve(ROOT, '.tmp/private-beta/evidence.json'), durationMs: 2000, concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--output') options.output = resolve(value);
    if (argv[index] === '--external') options.external = resolve(value);
    if (argv[index] === '--before-chat') options.beforeChat = resolve(value);
    if (argv[index] === '--during-chat') options.duringChat = resolve(value);
    if (argv[index] === '--duration-ms') options.durationMs = Number(value);
    if (argv[index] === '--concurrency') options.concurrency = Number(value);
    if (argv[index].startsWith('--')) index += 1;
  }
  if (!Number.isInteger(options.durationMs) || options.durationMs < 100) throw new Error('--duration-ms must be an integer >= 100.');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency must be a positive integer.');
  return options;
}

export async function runCertification(options) {
  const generatedAt = new Date().toISOString();
  const authority = await listenIsolatedAm01();
  let connection;
  try {
    connection = await connect(authority.baseUrl, authority.token);
    const listed = await connection.client.listTools();
    const toolsPassed = JSON.stringify(listed.tools.map(({ name }) => name)) === JSON.stringify(TOOLS);
    const lifecycle = await exerciseLifecycle(connection.client, authority);
    const load = await sustainedLoad(connection.client, options.durationMs, options.concurrency);
    await connection.client.close();
    const shutdownPassed = true;
    const beforeChat = await readJson(options.beforeChat);
    const duringChat = await readJson(options.duringChat);
    const external = (await readJson(options.external)) ?? {};
    if (beforeChat || duringChat) {
      external.chat_comparison = {
        ...external.chat_comparison,
        inputs_present: Boolean(beforeChat && duringChat),
        before: beforeChat,
        during: duringChat,
        observed_delta: compareChatInputs(beforeChat, duringChat),
        input_sha256: {
          before: beforeChat ? sha256(beforeChat) : null,
          during: duringChat ? sha256(duringChat) : null,
        },
      };
    }
    const clients = await validateTemplates();
    const hermes = validateHermesPackage(authority.baseUrl);
    const local = {
      passed: toolsPassed && lifecycle.passed && load.passed && shutdownPassed
        && clients.generic_inspector.passed && clients.cursor.passed && hermes.config_shape_passed,
      mode: 'local_mock',
      tools: { passed: toolsPassed, discovered: listed.tools.map(({ name }) => name) },
      clients,
      lifecycle,
      sustained_load: load,
      kill_switch: {
        passed: shutdownPassed,
        scope: 'local MCP process only',
        chat_health: 'not_measured_locally',
      },
      hermes,
    };
    const evidence = {
      schema_version: '1',
      issue: 'LUC-1078',
      evidence_mode: 'local_mock',
      generated_at: generatedAt,
      repository: {
        commit_sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
      },
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      local,
      external_inputs: external,
      go_no_go: privateBetaDecision({ local, external }),
    };
    evidence.evidence_sha256 = sha256(evidence);
    return evidence;
  } finally {
    if (connection) await connection.client.close().catch(() => {});
    await authority.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await runCertification(options);
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const decisionOutput = options.output.slice(0, -extname(options.output).length) + '.md';
  await writeFile(decisionOutput, renderGoNoGo(evidence), 'utf8');
  process.stdout.write(`${evidence.go_no_go.decision}: ${options.output}; ${decisionOutput}\n`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
