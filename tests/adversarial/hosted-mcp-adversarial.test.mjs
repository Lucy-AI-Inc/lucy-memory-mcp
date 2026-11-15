import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fixture from './fixtures/sanitized.json' with { type: 'json' };
import { createEvidence, redactEvidence, writeEvidence } from './evidence.mjs';
import { createLocalTarget } from './local-target.mjs';
import { loadStagingAdapter, stagingConfig } from './target-config.mjs';
import { LUCY_MEMORY_TOOL_NAMES } from '../../src/mcp/server.mjs';

const targetKind = process.env.LUCY_ADVERSARIAL_TARGET ?? 'local';

test('LUC-1077 hosted MCP adversarial acceptance suite', async (t) => {
  let clock = Date.parse('2026-02-20T20:00:00Z');
  const config = targetKind === 'staging'
    ? stagingConfig()
    : {
        kind: 'local',
        audience: fixture.target.audience,
        workspaces: fixture.workspaces.map(({ id }) => id),
        shas: { connector: '1111111', service: '2222222', harness: '3333333' },
      };
  const target = config.kind === 'staging'
    ? await loadStagingAdapter(config, { fixture })
    : await createLocalTarget({ ...config, now: () => clock });
  t.after(() => target.close());

  const [workspaceA, workspaceB] = config.workspaces;
  const clientA = target.issueAccess(workspaceA);
  const clientB = target.issueAccess(workspaceB);
  const cases = [];
  async function acceptance(name, run) {
    await t.test(name, async () => {
      await run();
      cases.push({ name, status: 'passed' });
    });
  }

  await acceptance('cross-workspace credentials cannot recall or propose into another workspace', async () => {
    const proposed = await target.call(clientA, 'memory_propose', {
      operation: 'create',
      ...fixture.memory,
      scope: { kind: 'workspace' },
      idempotency_key: '00000000-0000-4000-8000-000000001077',
    });
    assert.equal(proposed.structuredContent.status, 'pending');
    assert.equal(target.approve(workspaceA, proposed.structuredContent.id), true);
    const visibleA = await target.call(clientA, 'memory_recall', {
      query: 'marker', scope: { kind: 'workspace' }, keys: [fixture.memory.key],
    });
    assert.equal(visibleA.structuredContent.results.length, 1);
    const hiddenB = await target.call(clientB, 'memory_recall', {
      query: 'marker', scope: { kind: 'workspace' }, keys: [fixture.memory.key],
    });
    assert.equal(hiddenB.structuredContent.results.length, 0);
    const forged = await target.call(clientA, 'memory_propose', {
      operation: 'create',
      ...fixture.memory,
      scope: { kind: 'workspace' },
      workspace_id: workspaceB,
      idempotency_key: '00000000-0000-4000-8000-000000001078',
    });
    assert.equal(forged.isError, true);
  });

  await acceptance('wrong-audience access tokens are rejected', async () => {
    const wrongAudience = target.issueAccess(workspaceA, 'https://chat.staging.invalid');
    await assert.rejects(
      target.listTools(wrongAudience),
      /unauthenticated/,
    );
  });

  await acceptance('client bearer is never passed to the upstream memory authority', async () => {
    await target.call(clientA, 'memory_recall', { query: 'marker', scope: { kind: 'workspace' } });
    assert.ok(target.upstreamAuthorization.length > 0);
    assert.ok(target.upstreamAuthorization.every((value) => value !== `Bearer ${clientA}`));
  });

  await acceptance('refresh revocation, rotation, and access TTL fail closed', async () => {
    const refresh = target.issueRefresh(workspaceA);
    const rotated = target.rotateRefresh(refresh);
    assert.ok(rotated.accessToken);
    assert.throws(() => target.mintWithRefresh(refresh), /invalid_grant/);
    target.revokeRefresh(rotated.refreshToken);
    assert.throws(() => target.mintWithRefresh(rotated.refreshToken), /invalid_grant/);
    const short = target.issueAccess(workspaceA, config.audience, 60);
    clock += 60_001;
    await assert.rejects(target.listTools(short), /unauthenticated/);
  });

  await acceptance('tools/list exposes exactly the frozen three-tool surface', async () => {
    const listed = await target.listTools(clientA);
    assert.deepEqual(listed.tools.map(({ name }) => name), [...LUCY_MEMORY_TOOL_NAMES]);
  });

  await acceptance('pending proposals are not recallable without auto-memory policy', async () => {
    assert.equal(fixture.policy.auto_memory, false);
    const key = `${fixture.memory.key}.pending`;
    const pending = await target.call(clientA, 'memory_propose', {
      operation: 'create',
      key,
      kind: fixture.memory.kind,
      scope: { kind: 'workspace' },
      content: fixture.memory.content,
      justification: fixture.memory.justification,
      idempotency_key: '00000000-0000-4000-8000-000000001079',
    });
    assert.equal(pending.structuredContent.status, 'pending');
    const recalled = await target.call(clientA, 'memory_recall', {
      query: 'pending', scope: { kind: 'workspace' }, keys: [key],
    });
    assert.equal(recalled.structuredContent.results.length, 0);
  });

  await acceptance('sampled logs and evidence redact credentials', async () => {
    const rejected = target.issueAccess(workspaceA, 'https://wrong.invalid');
    await assert.rejects(target.listTools(rejected));
    const sanitized = JSON.stringify(redactEvidence(target.logs));
    assert.doesNotMatch(sanitized, new RegExp(rejected));
    assert.match(sanitized, /\[REDACTED\]/);
  });

  await acceptance('dependency failures fail closed', async () => {
    target.setDependencyAvailable(false);
    const failed = await target.call(clientA, 'memory_recall', {
      query: 'marker', scope: { kind: 'workspace' },
    });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent, undefined);
    target.setDependencyAvailable(true);
  });

  await acceptance('evidence is sanitized and records pinned SHAs with Vancouver time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luc-1077-'));
    const path = join(directory, 'evidence.json');
    const evidence = createEvidence({
      target: config.kind,
      shas: config.shas,
      cases,
      outputs: target.logs,
      date: new Date(clock),
    });
    await writeEvidence(path, evidence);
    const written = await readFile(path, 'utf8');
    assert.match(written, /America\/Vancouver/);
    assert.match(written, /"connector": "1111111"|"connector": "[0-9a-f]{7,64}"/i);
    assert.doesNotMatch(written, /access_[0-9a-f]+/);
    assert.doesNotMatch(written, /refresh_[0-9a-f]+/);
  });
});

test('staging target admission rejects unsafe or incomplete configuration', () => {
  assert.throws(() => stagingConfig({}), /incomplete/);
  const complete = {
    LUCY_ADVERSARIAL_ADAPTER_MODULE: 'adapter.mjs',
    LUCY_ADVERSARIAL_BASE_URL: 'https://memory.staging.invalid/mcp',
    LUCY_ADVERSARIAL_AUDIENCE: 'https://memory.staging.invalid/mcp',
    LUCY_ADVERSARIAL_WORKSPACE_A: 'workspace_disposable_alpha',
    LUCY_ADVERSARIAL_WORKSPACE_B: 'workspace_disposable_beta',
    LUCY_ADVERSARIAL_CONNECTOR_SHA: '1111111',
    LUCY_ADVERSARIAL_SERVICE_SHA: '2222222',
    LUCY_ADVERSARIAL_HARNESS_SHA: '3333333',
  };
  assert.throws(() => stagingConfig(complete), /DISPOSABLE/);
  assert.throws(() => stagingConfig({
    ...complete,
    LUCY_ADVERSARIAL_DISPOSABLE: 'true',
    LUCY_ADVERSARIAL_BASE_URL: 'https://memory.production.invalid/mcp',
  }), /Production-like/);
});
