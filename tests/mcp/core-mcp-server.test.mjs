import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client, InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { AgentMemoryError, AuthorizationFailureError, InsufficientCreditsError, BillingUnavailableError } from '../../src/client/errors.mjs';
import { loadLucyMemoryMcpConfig } from '../../src/mcp/config.mjs';
import { createShutdownController } from '../../src/mcp/lifecycle.mjs';
import { MCP_SCHEMAS, containsExternalSchemaReference } from '../../src/mcp/schemas.mjs';
import { createLucyMemoryMcpServer, LUCY_MEMORY_TOOLS, safeMcpError } from '../../src/mcp/server.mjs';
import { main, modulePathFromUrl } from '../../src/mcp/stdio.mjs';

const USER = Object.freeze({ kind: 'user' });
const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const PACKAGE_LOCK = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
const PATCHED_MCP_SDK_VERSION = '2.3.1';
const MCP_2026_07_28 = '2026-07-28';
const FROZEN_TOOL_NAMES = Object.freeze([
  'memory_recall',
  'memory_propose',
  'memory_proposal_status',
]);
const recallRequest = () => ({ query: 'profile', scope: USER });
const proposeRequest = () => ({
  operation: 'create', key: 'profile.name', kind: 'fact', scope: USER, content: 'Ada',
  justification: 'User stated this.', idempotency_key: 'idem_123456789012',
});
function stdioBinTransport() {
  const serverEntry = new URL('../../src/mcp/bin.mjs', import.meta.url);
  const mockTransport = new URL('./mock/space%20path/transport%20%23module.mjs', import.meta.url);
  return new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(serverEntry)],
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stderr: 'pipe',
    env: {
      LUCY_MEMORY_TOKEN: 'test-token',
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_TRANSPORT_MODULE: mockTransport.href,
      LUCY_MEMORY_TIMEOUT_MS: '1000',
    },
  });
}
async function assertFrozenLucyToolSurface(client) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), [...FROZEN_TOOL_NAMES]);
  assert.equal(listed.tools.length, 3);
  assert.equal(listed.tools.some(({ name }) => /write|approve|reject|delete|restore|resolve/i.test(name)), false);
  const recalled = await client.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(recalled.isError, undefined);
  assert.equal(recalled.structuredContent.consistency, 'canonical_active');
  const proposed = await client.callTool({ name: 'memory_propose', arguments: proposeRequest() });
  assert.equal(proposed.isError, undefined);
  assert.equal(proposed.structuredContent.status, 'pending');
  assert.equal('saved' in proposed.structuredContent, false);
  const status = await client.callTool({ name: 'memory_proposal_status', arguments: { proposal_id: 'proposal_test' } });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.id, 'proposal_test');
}
const response = (body, status = 200) => ({ status, body, byteLength: Buffer.byteLength(JSON.stringify(body)) });
const recallResponse = () => ({
  schema_version: 'canonical-recall-1', request_id: 'req_test', as_of: '2026-08-20T00:00:00.000Z',
  consistency: 'canonical_active', scope: USER, results: [], notices: [],
});
const errorResponse = (code, status, retryable = false, message = code) => response({
  schema_version: '1', request_id: 'req_error', error: { code, message, retryable },
}, status);
const errorPayload = (result) => JSON.parse(result.content[0].text);
const proposalFixture = () => JSON.parse(readFileSync(new URL('../../fixtures/v1/positive/proposal-pending.json', import.meta.url), 'utf8'));

function proposalResponseFor(request) {
  const pending = proposalFixture();
  return {
    ...pending,
    id: request.proposal_id ?? 'proposal_test',
    requested: request.operation === 'create'
      ? { key: request.key, kind: request.kind, scope: request.scope }
      : pending.requested,
  };
}

async function harnessForAgentClient(t, agentClient) {
  const server = await createLucyMemoryMcpServer({ client: agentClient });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'am03-in-memory-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion().version, PACKAGE.version);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

async function inMemoryHarness(t, agentTransport, { permissions = ['memory:read', 'memory:propose'], timeoutMs = 1000 } = {}) {
  return harnessForAgentClient(t, new AgentMemoryClient({
    transport: agentTransport, token: 'test-token', permissions, timeoutMs,
  }));
}

test('core MCP server exports exactly the three frozen Lucy memory tools', async () => {
  assert.equal(PACKAGE.dependencies['@modelcontextprotocol/server'], PATCHED_MCP_SDK_VERSION);
  assert.equal(PACKAGE.dependencies['@modelcontextprotocol/client'], undefined);
  assert.equal(PACKAGE.devDependencies['@modelcontextprotocol/client'], PATCHED_MCP_SDK_VERSION);
  assert.equal('@modelcontextprotocol/sdk' in PACKAGE.dependencies, false);
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
  const api = await import('../../src/mcp/server.mjs');
  assert.deepEqual(api.LUCY_MEMORY_TOOL_NAMES, [
    'memory_recall',
    'memory_propose',
    'memory_proposal_status',
  ]);
  assert.equal(typeof api.createLucyMemoryMcpServer, 'function');
  assert.equal(new Set(LUCY_MEMORY_TOOLS.map(({ name }) => name)).size, 3);
});

test('MCP SDK dependencies stay patched and production-separated', () => {
  assert.equal(PACKAGE.dependencies['@modelcontextprotocol/server'], PATCHED_MCP_SDK_VERSION);
  assert.equal(PACKAGE.dependencies['@modelcontextprotocol/client'], undefined);
  assert.equal(PACKAGE.devDependencies['@modelcontextprotocol/server'], undefined);
  assert.equal(PACKAGE.devDependencies['@modelcontextprotocol/client'], PATCHED_MCP_SDK_VERSION);

  const lockRoot = PACKAGE_LOCK.packages[''];
  assert.equal(lockRoot.dependencies['@modelcontextprotocol/server'], PATCHED_MCP_SDK_VERSION);
  assert.equal(lockRoot.dependencies['@modelcontextprotocol/client'], undefined);
  assert.equal(lockRoot.devDependencies['@modelcontextprotocol/server'], undefined);
  assert.equal(lockRoot.devDependencies['@modelcontextprotocol/client'], PATCHED_MCP_SDK_VERSION);

  const lockedSdkVersions = { client: new Set(), core: new Set(), server: new Set() };
  for (const [path, metadata] of Object.entries(PACKAGE_LOCK.packages)) {
    const match = path.match(/node_modules\/@modelcontextprotocol\/(client|core|server)$/);
    if (match) lockedSdkVersions[match[1]].add(metadata.version);
  }
  for (const versions of Object.values(lockedSdkVersions)) {
    assert.deepEqual([...versions], [PATCHED_MCP_SDK_VERSION]);
  }
  assert.equal(PACKAGE_LOCK.packages['node_modules/@modelcontextprotocol/server'].dev, undefined);
  assert.equal(PACKAGE_LOCK.packages['node_modules/@modelcontextprotocol/client'].dev, true);
});

test('configuration loads only the frozen permissions and bounded timeout', () => {
  const config = loadLucyMemoryMcpConfig({
    LUCY_MEMORY_TOKEN: 'token',
    LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
    LUCY_MEMORY_TIMEOUT_MS: '2500',
    LUCY_MEMORY_TRANSPORT_MODULE: 'file:///tmp/transport.mjs',
  });
  assert.deepEqual(config.permissions, ['memory:read', 'memory:propose']);
  assert.equal(config.timeoutMs, 2500);
  assert.equal(config.allowInsecureLoopback, false);
  const loopbackConfig = loadLucyMemoryMcpConfig({
    LUCY_MEMORY_TOKEN: 'token',
    LUCY_MEMORY_PERMISSIONS: 'memory:read',
    LUCY_MEMORY_BASE_URL: 'http://127.0.0.1:9000',
    LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: 'true',
  });
  assert.equal(loopbackConfig.allowInsecureLoopback, true);
  assert.throws(() => loadLucyMemoryMcpConfig({
    LUCY_MEMORY_TOKEN: 'token', LUCY_MEMORY_PERMISSIONS: 'memory:write',
    LUCY_MEMORY_TRANSPORT_MODULE: 'file:///tmp/transport.mjs',
  }), (error) => error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => loadLucyMemoryMcpConfig({
    LUCY_MEMORY_TOKEN: 'token', LUCY_MEMORY_PERMISSIONS: 'memory:read', LUCY_MEMORY_TIMEOUT_MS: '0',
    LUCY_MEMORY_TRANSPORT_MODULE: 'file:///tmp/transport.mjs',
  }), (error) => error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => loadLucyMemoryMcpConfig({
    LUCY_MEMORY_TOKEN: 'token', LUCY_MEMORY_PERMISSIONS: 'memory:read',
    LUCY_MEMORY_BASE_URL: 'http://127.0.0.1:9000', LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: 'yes',
  }), (error) => error.code === 'CONFIGURATION_ERROR');
});

test('generic MCP client completes handshake, tools/list, and all three calls through the real bin entry', async (t) => {
  const serverEntry = new URL('../../src/mcp/bin.mjs', import.meta.url);
  const mockTransport = new URL('./mock/space%20path/transport%20%23module.mjs', import.meta.url);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(serverEntry)],
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stderr: 'pipe',
    env: {
      LUCY_MEMORY_TOKEN: 'test-token',
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_TRANSPORT_MODULE: mockTransport.href,
      LUCY_MEMORY_TIMEOUT_MS: '1000',
    },
  });
  const client = new Client({ name: 'am03-test-client', version: '1.0.0' });
  t.after(async () => client.close());
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), LATEST_PROTOCOL_VERSION);
  const instructions = client.getInstructions();
  assert.match(instructions, /concise literal, distinctive substrings/);
  assert.match(instructions, /spelling and spacing variants/);
  assert.match(instructions, /Scope is an object, never a string/);
  assert.match(instructions, /user `\{ "kind": "user" \}`/);
  assert.match(instructions, /workspace `\{ "kind": "workspace" \}`/);
  assert.match(instructions, /project `\{ "kind": "project", "id": "<project-id>" \}`/);
  assert.match(instructions, /`\{ "query": "database", "scope": \{ "kind": "user" \} \}`/);
  assert.match(instructions, /known keys, kinds, and scopes/);
  assert.match(instructions, /Broaden or narrow/);
  assert.match(instructions, /one empty result/);
  assert.match(instructions, /zero matches from authentication, authorization, or service errors/);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), [
    'memory_recall',
    'memory_propose',
    'memory_proposal_status',
  ]);
  assert.equal(listed.tools.some(({ name }) => /write|approve|reject|delete|restore|resolve/i.test(name)), false);
  const recallTool = listed.tools.find(({ name }) => name === 'memory_recall');
  assert.equal(recallTool.inputSchema.$defs.common.$defs.scope.oneOf[2].properties.id.maxLength, 128);
  assert.equal(recallTool.annotations.idempotentHint, false);
  const proposeTool = listed.tools.find(({ name }) => name === 'memory_propose');
  assert.deepEqual(Object.keys(proposeTool.inputSchema.properties).sort(), [
    'content', 'expected_version', 'idempotency_key', 'justification', 'key', 'kind',
    'memory_id', 'operation', 'scope', 'source_ref',
  ]);
  assert.deepEqual(proposeTool.inputSchema.properties.operation.enum, ['create', 'replace']);
  assert.equal(proposeTool.inputSchema.properties.content.$ref, '#/$defs/common/$defs/content');
  assert.equal(proposeTool.inputSchema.$defs.common.$defs.content.maxLength, 2000);
  assert.equal(proposeTool.inputSchema.$defs.common.$defs.justification.maxLength, 500);
  assert.equal(proposeTool.inputSchema.additionalProperties, false);
  assert.equal(proposeTool.annotations.idempotentHint, true);
  assert.equal(listed.tools.find(({ name }) => name === 'memory_proposal_status').annotations.idempotentHint, false);

  const recalled = await client.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(recalled.isError, undefined);
  assert.equal(recalled.structuredContent.consistency, 'canonical_active');

  const proposed = await client.callTool({ name: 'memory_propose', arguments: proposeRequest() });
  assert.equal(proposed.isError, undefined);
  assert.equal(proposed.structuredContent.status, 'pending');
  assert.equal('saved' in proposed.structuredContent, false);

  const status = await client.callTool({ name: 'memory_proposal_status', arguments: { proposal_id: 'proposal_test' } });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.id, 'proposal_test');
  assert.equal(client.getProtocolEra(), 'legacy');
});

test('pinned 2026-07-28 client negotiates the modern era over stdio', async (t) => {
  const transport = stdioBinTransport();
  const client = new Client(
    { name: 'am03-modern-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: MCP_2026_07_28 } } },
  );
  t.after(async () => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'modern');
  assert.equal(client.getNegotiatedProtocolVersion(), MCP_2026_07_28);
  await assertFrozenLucyToolSurface(client);
});

test('legacy stdio client still interoperates without expanding Lucy tool authority', async (t) => {
  const transport = stdioBinTransport();
  const client = new Client({ name: 'am03-legacy-interop-client', version: '1.0.0' });
  t.after(async () => client.close());
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'legacy');
  assert.equal(client.getNegotiatedProtocolVersion(), LATEST_PROTOCOL_VERSION);
  await assertFrozenLucyToolSurface(client);
});

test('malformed arguments and missing configured permission return protocol-safe errors', async (t) => {
  const client = await inMemoryHarness(t, async () => response(recallResponse()), { permissions: ['memory:read'] });
  const malformed = await client.callTool({ name: 'memory_recall', arguments: { scope: USER } });
  assert.equal(malformed.isError, true);
  assert.equal('structuredContent' in malformed, false);
  assert.equal(errorPayload(malformed).code, 'validation_failure');
  const missingPermission = await client.callTool({ name: 'memory_propose', arguments: proposeRequest() });
  assert.equal(missingPermission.isError, true);
  assert.equal('structuredContent' in missingPermission, false);
  assert.equal(errorPayload(missingPermission).code, 'authorization_failure');
});

test('upstream permission, transport, timeout, and malformed-response failures are normalized without raw causes', async (t) => {
  const forbidden = await inMemoryHarness(t, async () => errorResponse('forbidden', 403, false, 'token=EXAMPLE_NOT_A_SECRET internal diagnostic'));
  const forbiddenResult = await forbidden.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(forbiddenResult.isError, true);
  assert.equal('structuredContent' in forbiddenResult, false);
  assert.equal(errorPayload(forbiddenResult).code, 'authorization_failure');
  assert.equal(errorPayload(forbiddenResult).message, 'Lucy authorization failed.');
  assert.doesNotMatch(forbiddenResult.content[0].text, /EXAMPLE_NOT_A_SECRET|internal diagnostic/i);

  const failed = await inMemoryHarness(t, async () => { throw new Error('secret-token raw upstream cause'); });
  const failedResult = await failed.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(failedResult.isError, true);
  assert.equal(errorPayload(failedResult).code, 'upstream_unavailable');
  assert.equal(errorPayload(failedResult).retryable, false);
  assert.doesNotMatch(failedResult.content[0].text, /secret-token|raw upstream/i);

  let observedSignal;
  const timedOut = await inMemoryHarness(t, async ({ signal }) => {
    observedSignal = signal;
    return new Promise(() => {});
  }, { timeoutMs: 5 });
  const timeoutResult = await timedOut.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(timeoutResult.isError, true);
  assert.equal(errorPayload(timeoutResult).code, 'timeout');
  assert.equal(errorPayload(timeoutResult).retryable, false);
  assert.equal(observedSignal.aborted, true);

  const malformed = await inMemoryHarness(t, async () => ({ status: 200, body: { unexpected: true }, byteLength: 19 }));
  const malformedResult = await malformed.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(malformedResult.isError, true);
  assert.equal(errorPayload(malformedResult).code, 'malformed_response');
});

test('transient MCP errors are retryable only for idempotency-key-backed proposals', async (t) => {
  const cases = [
    ['memory_recall', recallRequest(), false],
    ['memory_propose', proposeRequest(), true],
    ['memory_proposal_status', { proposal_id: 'proposal_test' }, false],
  ];
  for (const [name, argumentsForTool, retryable] of cases) {
    const client = await inMemoryHarness(t, async () => errorResponse('service_unavailable', 503, true));
    const result = await client.callTool({ name, arguments: argumentsForTool });
    assert.equal(result.isError, true);
    assert.deepEqual(errorPayload(result), {
      code: 'upstream_unavailable',
      message: 'Lucy is temporarily unavailable.',
      retryable,
      status: 503,
      request_id: 'req_error',
    });
  }
});

test('MCP tools expose only bounded schema-valid backend error request IDs', async (t) => {
  const validId = 'req_backend-error_123';
  const unsafeIds = [
    [undefined, true],
    ['not_a_request_id', true],
    [`req_${'a'.repeat(253)}`, false],
    ['req_control\nvalue', true],
    ['req_safe\n', true],
  ];

  const valid = await inMemoryHarness(t, async () => response({
    schema_version: '1', request_id: validId,
    error: { code: 'forbidden', message: 'private backend message', retryable: false },
  }, 403));
  const validResult = await valid.callTool({ name: 'memory_recall', arguments: recallRequest() });
  assert.equal(validResult.isError, true);
  assert.deepEqual(errorPayload(validResult), {
    code: 'authorization_failure',
    message: 'Lucy authorization failed.',
    retryable: false,
    status: 403,
    request_id: validId,
  });
  assert.doesNotMatch(validResult.content[0].text, /private backend message/);

  for (const [requestId, envelopeIsMalformed] of unsafeIds) {
    const client = await inMemoryHarness(t, async () => {
      const body = {
        schema_version: '1',
        error: { code: 'forbidden', message: 'private backend message', retryable: false },
      };
      if (requestId !== undefined) body.request_id = requestId;
      return response(body, 403);
    });
    const result = await client.callTool({ name: 'memory_recall', arguments: recallRequest() });
    assert.equal(result.isError, true);
    assert.deepEqual(errorPayload(result), {
      code: envelopeIsMalformed ? 'malformed_response' : 'authorization_failure',
      message: envelopeIsMalformed ? 'Lucy returned a malformed response.' : 'Lucy authorization failed.',
      retryable: false,
      status: envelopeIsMalformed ? null : 403,
    });
    assert.equal('request_id' in errorPayload(result), false);
    assert.doesNotMatch(result.content[0].text, /private backend message|not_a_request_id|control|req_safe|a{32}/);
  }
});

test('successful malformed proposal responses fail closed with a safe AM-01 compatibility error', async (t) => {
  const privateContent = 'private proposal content Authorization: Bearer EXAMPLE_NOT_A_SECRET';
  const malformedCases = [
    ['pending with decided_at', (body) => ({ ...body, decided_at: '2026-08-09T10:05:00Z' })],
    ['missing relations', ({ relations, ...body }) => body],
    ['missing expires_at', ({ expires_at, ...body }) => body],
    ['unexpected request_id', (body) => ({ ...body, request_id: 'req_internal_EXAMPLE_NOT_A_SECRET' })],
    ['unexpected internal requested payload', (body) => ({ ...body, requested: { ...body.requested, content: privateContent } })],
  ];
  for (const [tool, argumentsForTool] of [
    ['memory_propose', proposeRequest()],
    ['memory_proposal_status', { proposal_id: 'proposal_test' }],
  ]) {
    await t.test(`${tool}: valid frozen fixture passes`, async (t) => {
      const client = await inMemoryHarness(t, async ({ payload }) => response(proposalResponseFor(JSON.parse(payload)), 202));
      const result = await client.callTool({ name: tool, arguments: argumentsForTool });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.status, 'pending');
    });
    for (const [name, mutate] of malformedCases) {
      await t.test(`${tool}: ${name}`, async (t) => {
        const client = await inMemoryHarness(t, async ({ payload }) => response(mutate(proposalResponseFor(JSON.parse(payload))), 202));
        const result = await client.callTool({ name: tool, arguments: argumentsForTool });
        const payload = errorPayload(result);
        assert.equal(result.isError, true);
        assert.equal('structuredContent' in result, false);
        assert.deepEqual(payload, {
          code: 'proposal_contract_incompatible',
          message: 'Lucy returned a proposal response incompatible with the frozen AM-01 contract. Ask the Lucy service operator to restore AM-01 compatibility, then retry.',
          retryable: false,
          status: null,
        });
        assert.doesNotMatch(result.content[0].text, /EXAMPLE_NOT_A_SECRET|private proposal content|Bearer|request_id|requested/i);
      });
    }
  }
});

test('oversized calls and unknown fourth tools fail before gaining authority', async (t) => {
  let transportCalls = 0;
  const client = await inMemoryHarness(t, async () => { transportCalls += 1; return response(recallResponse()); });
  const oversized = await client.callTool({ name: 'memory_propose', arguments: { ...proposeRequest(), content: 'x'.repeat(9000) } });
  assert.equal(oversized.isError, true);
  assert.equal(errorPayload(oversized).code, 'validation_failure');
  await assert.rejects(client.callTool({ name: 'memory_approve', arguments: {} }),
    (error) => error.code === ProtocolErrorCode.InvalidParams);
  assert.equal(transportCalls, 0);
});

test('MCP schemas preserve frozen inputs and advertise the strict canonical recall output', () => {
  assert.equal(LUCY_MEMORY_TOOLS[0].inputSchema, MCP_SCHEMAS.recallInput);
  assert.equal(LUCY_MEMORY_TOOLS[0].outputSchema, MCP_SCHEMAS.canonicalRecallOutput);
  assert.equal(LUCY_MEMORY_TOOLS[1].inputSchema, MCP_SCHEMAS.proposalInput);
  assert.equal(LUCY_MEMORY_TOOLS[1].outputSchema, MCP_SCHEMAS.proposalOutput);
  assert.equal(LUCY_MEMORY_TOOLS[2].inputSchema, MCP_SCHEMAS.proposalStatusInput);
  assert.equal(LUCY_MEMORY_TOOLS[2].outputSchema, MCP_SCHEMAS.proposalOutput);
  for (const schema of Object.values(MCP_SCHEMAS)) assert.equal(containsExternalSchemaReference(schema), false);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(MCP_SCHEMAS)) assert.doesNotThrow(() => ajv.compile(schema), name);
  const recallFixture = recallResponse();
  const proposalFixture = JSON.parse(readFileSync(new URL('../../fixtures/v1/positive/proposal-pending.json', import.meta.url), 'utf8'));
  assert.equal(ajv.compile(MCP_SCHEMAS.canonicalRecallOutput)(recallFixture), true);
  assert.equal(ajv.compile(MCP_SCHEMAS.proposalOutput)(proposalFixture), true);
});

test('unknown AgentMemoryError codes collapse to a fixed internal MCP code', () => {
  const maliciousCode = ['token', 'lucy', 'sk', 'secret'].join('_');
  const malicious = new AgentMemoryError('Authorization: Bearer EXAMPLE_NOT_A_SECRET', {
    code: maliciousCode, status: 500, retryable: true,
  });
  assert.deepEqual(safeMcpError(malicious), {
    code: 'internal_mcp_error',
    message: 'Lucy Memory MCP could not complete the request.',
    retryable: false,
    status: null,
  });
  const safeCodes = [
    'authentication_failure', 'authorization_failure', 'invalid_scope', 'invalid_key', 'invalid_kind',
    'validation_failure', 'proposal_not_found', 'memory_not_found', 'version_conflict', 'lifecycle_conflict',
    'rate_limit', 'upstream_unavailable', 'timeout', 'malformed_response', 'internal_lucy_error',
    'insufficient_credits', 'billing_unavailable',
  ];
  for (const code of safeCodes) {
    const result = safeMcpError(new AgentMemoryError('token=EXAMPLE_NOT_A_SECRET /example/private', { code, status: 400 }));
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_NOT_A_SECRET|\/example\/private/);
  }
});

test('billing errors stay distinct on the MCP surface', () => {
  const credits = safeMcpError(new InsufficientCreditsError('token=EXAMPLE_NOT_A_SECRET', { status: 402 }));
  assert.deepEqual(credits, {
    code: 'insufficient_credits',
    message: 'The workspace does not have enough Lucy credits for this Agent Memory operation.',
    retryable: false,
    status: 402,
  });
  const billingError = new BillingUnavailableError('token=EXAMPLE_NOT_A_SECRET', { status: 503 });
  const billing = safeMcpError(billingError, 'memory_propose');
  assert.equal(billing.code, 'billing_unavailable');
  assert.equal(billing.retryable, true);
  assert.equal(billing.status, 503);
  assert.equal(safeMcpError(billingError, 'memory_recall').retryable, false);
  assert.equal(safeMcpError(billingError, 'memory_proposal_status').retryable, false);
  assert.equal(safeMcpError(billingError).retryable, false);
  assert.doesNotMatch(JSON.stringify(credits), /EXAMPLE_NOT_A_SECRET/);
});

test('server rejects structural client substitutes outside the AgentMemoryClient authority boundary', async () => {
  const structuralSubstitute = {
    recall: async () => recallResponse(),
    propose: async () => ({}),
    proposalStatus: async () => ({}),
  };
  await assert.rejects(
    createLucyMemoryMcpServer({ client: structuralSubstitute }),
    /client must be an exact non-proxy AgentMemoryClient/,
  );
});

test('server rejects frozen exact-prototype structural substitutes at the nominal boundary', async () => {
  const forgedClient = Object.freeze(Object.create(AgentMemoryClient.prototype));
  await assert.rejects(
    Promise.resolve().then(() => createLucyMemoryMcpServer({ client: forgedClient })),
    /client must be an exact non-proxy AgentMemoryClient/,
  );
});

test('nominal admission ignores mutable AgentMemoryError Symbol.hasInstance hooks', async () => {
  const forgedClient = Object.freeze(Object.create(AgentMemoryClient.prototype));
  const original = Object.getOwnPropertyDescriptor(AgentMemoryError, Symbol.hasInstance);
  Object.defineProperty(AgentMemoryError, Symbol.hasInstance, {
    configurable: true,
    value: () => true,
  });
  try {
    await assert.rejects(
      createLucyMemoryMcpServer({ client: forgedClient }),
      /client must be an exact non-proxy AgentMemoryClient/,
    );
  } finally {
    if (original) Object.defineProperty(AgentMemoryError, Symbol.hasInstance, original);
    else delete AgentMemoryError[Symbol.hasInstance];
  }
});

test('nominal admission uses captured reflection instead of mutable Object.getPrototypeOf', async () => {
  const forgedClient = Object.freeze(Object.create(AgentMemoryClient.prototype));
  const original = Object.getPrototypeOf;
  Object.getPrototypeOf = (value) => (
    value === forgedClient ? AgentMemoryClient.prototype : AuthorizationFailureError.prototype
  );
  try {
    await assert.rejects(
      createLucyMemoryMcpServer({ client: forgedClient }),
      /client must be an exact non-proxy AgentMemoryClient/,
    );
  } finally {
    Object.getPrototypeOf = original;
  }
});

test('nominal admission ignores mutable AgentMemoryClient Symbol.hasInstance hooks', async () => {
  const forgedClient = Object.freeze(Object.create(AgentMemoryClient.prototype));
  const original = Object.getOwnPropertyDescriptor(AgentMemoryClient, Symbol.hasInstance);
  Object.defineProperty(AgentMemoryClient, Symbol.hasInstance, {
    configurable: true,
    value: () => { throw new AuthorizationFailureError(); },
  });
  try {
    await assert.rejects(
      createLucyMemoryMcpServer({ client: forgedClient }),
      /client must be an exact non-proxy AgentMemoryClient/,
    );
  } finally {
    if (original) Object.defineProperty(AgentMemoryClient, Symbol.hasInstance, original);
    else delete AgentMemoryClient[Symbol.hasInstance];
  }
});

test('nominal admission uses captured Reflect.apply for its private-brand probe', async () => {
  const forgedClient = Object.freeze(Object.create(AgentMemoryClient.prototype));
  const original = Reflect.apply;
  Reflect.apply = (target, thisArgument, argumentsList) => (
    target === AgentMemoryClient.prototype.recall && thisArgument === forgedClient
      ? Promise.reject(new AuthorizationFailureError())
      : original(target, thisArgument, argumentsList)
  );
  try {
    await assert.rejects(
      createLucyMemoryMcpServer({ client: forgedClient }),
      /client must be an exact non-proxy AgentMemoryClient/,
    );
  } finally {
    Reflect.apply = original;
  }
});

test('server rejects subclasses and proxies outside the exact AgentMemoryClient authority boundary', async () => {
  const transport = async () => response(recallResponse());
  const options = {
    transport, token: 'test-token', permissions: ['memory:read', 'memory:propose'], timeoutMs: 1000,
  };
  class OverridingClient extends AgentMemoryClient {}
  const subclass = new OverridingClient(options);
  const genuineClient = new AgentMemoryClient(options);
  const transparentProxy = new Proxy(genuineClient, {});
  const prototypeSpoofingProxy = new Proxy({}, {
    getPrototypeOf: () => AgentMemoryClient.prototype,
  });

  for (const client of [subclass, transparentProxy, prototypeSpoofingProxy]) {
    await assert.rejects(
      Promise.resolve().then(() => createLucyMemoryMcpServer({ client })),
      /client must be an exact non-proxy AgentMemoryClient/,
    );
  }
});

test('server dispatches only captured canonical AgentMemoryClient operations', async (t) => {
  const proposalResponse = {
    schema_version: '1', id: 'proposal_test', status: 'pending', operation: 'create', proposal_version: 1,
    requested: { key: 'profile.name', kind: 'fact', scope: USER }, result: null, relations: [],
    created_at: '2026-08-20T00:00:00.000Z', decided_at: null, expires_at: '2026-08-27T00:00:00.000Z',
  };
  const authoritativeCalls = [];
  const transport = async ({ operation }) => {
    authoritativeCalls.push(operation);
    return response(operation === 'recall' ? recallResponse() : proposalResponse);
  };
  const client = new AgentMemoryClient({
    transport, token: 'test-token', permissions: ['memory:read', 'memory:propose'], timeoutMs: 1000,
  });
  const harness = await harnessForAgentClient(t, client);
  const originalRecallCanonical = AgentMemoryClient.prototype.recallCanonical;
  let overrideCalls = 0;
  AgentMemoryClient.prototype.recallCanonical = async () => {
    overrideCalls += 1;
    return recallResponse();
  };
  try {
    await harness.callTool({ name: 'memory_recall', arguments: recallRequest() });
    await harness.callTool({ name: 'memory_propose', arguments: proposeRequest() });
    await harness.callTool({ name: 'memory_proposal_status', arguments: { proposal_id: 'proposal_test' } });
  } finally {
    AgentMemoryClient.prototype.recallCanonical = originalRecallCanonical;
  }
  assert.equal(overrideCalls, 0);
  assert.deepEqual(authoritativeCalls, ['canonical-recall', 'propose', 'proposal-status']);
});

test('tool annotations are deeply immutable across server instances', async (t) => {
  for (const tool of LUCY_MEMORY_TOOLS) assert.equal(Object.isFrozen(tool.annotations), true);
  assert.throws(() => { LUCY_MEMORY_TOOLS[0].annotations.readOnlyHint = false; }, TypeError);
  const client = await inMemoryHarness(t, async () => response(recallResponse()));
  const listed = await client.listTools();
  const recall = listed.tools.find(({ name }) => name === 'memory_recall');
  const propose = listed.tools.find(({ name }) => name === 'memory_propose');
  const status = listed.tools.find(({ name }) => name === 'memory_proposal_status');
  assert.equal(recall.annotations.readOnlyHint, true);
  assert.equal(recall.annotations.idempotentHint, false);
  assert.equal(propose.annotations.destructiveHint, false);
  assert.equal(propose.annotations.idempotentHint, true);
  assert.equal(status.annotations.readOnlyHint, true);
  assert.equal(status.annotations.idempotentHint, false);
});

test('safe MCP errors permit retries only for idempotent proposals and validate status without exposing hostile metadata', () => {
  const hostile = new AgentMemoryError('token=EXAMPLE_NOT_A_SECRET', {
    code: 'timeout',
    status: 'postgresql://example@invalid.example',
    retryable: 'Authorization: Bearer EXAMPL...CRET',
  });
  assert.deepEqual(safeMcpError(hostile, 'memory_propose'), {
    code: 'timeout',
    message: 'The Lucy request timed out.',
    retryable: true,
    status: null,
  });
  const bounded = new AgentMemoryError('hidden', { code: 'rate_limit', status: 429, retryable: false });
  assert.deepEqual(safeMcpError(bounded, 'memory_recall'), {
    code: 'rate_limit',
    message: 'Lucy rate limited the request.',
    retryable: false,
    status: 429,
  });
  let detailReads = 0;
  const arbitraryDetails = new Proxy({ request_id: 'req_untrusted_details' }, {
    get() { detailReads += 1; throw new Error('untrusted detail getter'); },
  });
  assert.deepEqual(safeMcpError(new AgentMemoryError('hidden', {
    code: 'timeout', status: 504, details: arbitraryDetails,
  }), 'memory_proposal_status'), {
    code: 'timeout',
    message: 'The Lucy request timed out.',
    retryable: false,
    status: 504,
  });
  assert.equal(detailReads, 0);
  Object.defineProperty(hostile, 'status', { configurable: true, get() { throw new Error('secret getter'); } });
  assert.doesNotThrow(() => safeMcpError(hostile, 'memory_propose'));
  assert.equal(safeMcpError(hostile, 'memory_propose').status, null);
});

test('startup failures emit only deterministic diagnostics and never contaminate stdout', async () => {
  const throwingTransport = new URL('./mock/throwing-transport.mjs', import.meta.url).href;
  const stdout = new PassThrough();
  const stdoutChunks = [];
  stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  const diagnostics = [];
  const exits = [];
  const result = await main({
    environment: {
      LUCY_MEMORY_TOKEN: 'EXAMPLE_NOT_A_SECRET',
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_TRANSPORT_MODULE: throwingTransport,
    },
    stdin: new PassThrough(), stdout,
    stderr: { write: (value) => { diagnostics.push(String(value)); return true; } },
    exit: (code) => exits.push(code),
  });
  assert.equal(result, null);
  assert.deepEqual(exits, [1]);
  assert.equal(Buffer.concat(stdoutChunks).length, 0);
  assert.equal(diagnostics.join(''), 'TRANSPORT_LOAD_ERROR: Lucy Memory MCP transport could not be loaded.\n');
  assert.doesNotMatch(diagnostics.join(''), /bearer|api[_-]?key|authorization|postgres|\/home\/private/i);

  const configDiagnostics = [];
  const configExits = [];
  await main({
    environment: {
      LUCY_MEMORY_TOKEN: 'Authorization: Bearer EXAMPLE_NOT_A_SECRET',
      LUCY_MEMORY_PERMISSIONS: 'memory:write',
      LUCY_MEMORY_TRANSPORT_MODULE: throwingTransport,
    },
    stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: { write: (value) => { configDiagnostics.push(String(value)); return true; } },
    exit: (code) => configExits.push(code),
  });
  assert.deepEqual(configExits, [1]);
  assert.equal(configDiagnostics.join(''), 'CONFIGURATION_ERROR: Lucy Memory MCP configuration is invalid.\n');
  assert.doesNotMatch(configDiagnostics.join(''), /bearer|fake-secret|memory:write/i);

  const startupDiagnostics = [];
  const startupExits = [];
  await main({
    runtimeFactory: async () => { throw new Error('Authorization: Bearer EXAMPLE_NOT_A_SECRET postgresql://example@invalid.example /example/private'); },
    stderr: { write: (value) => { startupDiagnostics.push(String(value)); return true; } },
    exit: (code) => startupExits.push(code),
  });
  assert.deepEqual(startupExits, [1]);
  assert.equal(startupDiagnostics.join(''), 'STARTUP_ERROR: Lucy Memory MCP could not start.\n');
  assert.doesNotMatch(startupDiagnostics.join(''), /bearer|postgres|\/example\/private/i);
});

test('shutdown is idempotent, exits zero on success, and safely fails nonzero', async () => {
  let closes = 0;
  const successCodes = [];
  const success = createShutdownController({
    close: async () => { closes += 1; },
    writeDiagnostic: () => assert.fail('unexpected diagnostic'),
    setExitCode: (code) => successCodes.push(code),
  });
  assert.deepEqual(await Promise.all([success(), success()]), [true, true]);
  assert.equal(closes, 1);
  assert.deepEqual(successCodes, [0]);

  const diagnostics = [];
  const failureCodes = [];
  const failure = createShutdownController({
    close: async () => { throw new Error('Authorization: Bearer EXAMPLE_NOT_A_SECRET /example/private postgresql://invalid.example'); },
    writeDiagnostic: (value) => diagnostics.push(value),
    setExitCode: (code) => failureCodes.push(code),
  });
  assert.equal(await failure(), false);
  assert.deepEqual(failureCodes, [1]);
  assert.equal(diagnostics.join(''), 'SHUTDOWN_ERROR: Lucy Memory MCP could not shut down cleanly.\n');
  assert.doesNotMatch(diagnostics.join(''), /bearer|\/example\/private|postgres/i);
});

test('SIGINT and SIGTERM share one idempotent graceful shutdown', async () => {
  const signals = new EventEmitter();
  const exits = [];
  const mockTransport = new URL('./mock/mock-agent-memory-transport.mjs', import.meta.url).href;
  const runtime = await main({
    environment: {
      LUCY_MEMORY_TOKEN: 'test-token',
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_TRANSPORT_MODULE: mockTransport,
    },
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), signals,
    exit: (code) => exits.push(code),
  });
  assert.ok(runtime);
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  assert.equal(await runtime.shutdown(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [0]);

  const failingSignals = new EventEmitter();
  const failingExits = [];
  const failingDiagnostics = [];
  const failingRuntime = await main({
    runtimeFactory: async () => ({ server: {}, transport: {}, close: async () => {
      throw new Error('Authorization: Bearer EXAMPLE_NOT_A_SECRET /example/private');
    } }),
    signals: failingSignals,
    stderr: { write: (value) => { failingDiagnostics.push(String(value)); return true; } },
    exit: (code) => failingExits.push(code),
  });
  failingSignals.emit('SIGTERM');
  assert.equal(await failingRuntime.shutdown(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failingExits, [1]);
  assert.equal(failingDiagnostics.join(''), 'SHUTDOWN_ERROR: Lucy Memory MCP could not shut down cleanly.\n');
  assert.doesNotMatch(failingDiagnostics.join(''), /bearer|\/example\/private/i);
});

test('URL conversion decodes spaces and escaped characters without pathname assumptions', () => {
  const url = process.platform === 'win32'
    ? new URL('file:///C:/tmp/Lucy%20Memory%20%23server.mjs')
    : new URL('file:///tmp/Lucy%20Memory%20%23server.mjs');
  assert.equal(modulePathFromUrl(url), fileURLToPath(url));
  assert.ok(modulePathFromUrl(url).endsWith('Lucy Memory #server.mjs'));
});

test('server advertises tools only and does not expose resources or prompts', async (t) => {
  const client = await inMemoryHarness(t, async () => response(recallResponse()));
  assert.equal(client.getServerCapabilities().resources, undefined);
  assert.equal(client.getServerCapabilities().prompts, undefined);
  assert.deepEqual(await client.listResources(), { resources: [] });
  assert.deepEqual(await client.listPrompts(), { prompts: [] });
});
