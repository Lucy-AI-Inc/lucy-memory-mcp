import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listenIsolatedAm01 } from '../e2e/isolated-am01-authority.mjs';
import {
  hermesLucyStatus,
  installHermesLucyConfig,
  uninstallHermesLucyConfig,
} from '../../src/integrations/hermes.mjs';
import { cleanHermesSource, cleanHermesSourceGitSha } from '../helpers/hermes-clean-source.mjs';

const TOKEN = 'hermes-profile-token';

async function withClient(artifact, env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [artifact.entrypoint],
    cwd: dirname(artifact.entrypoint),
    stderr: 'pipe',
    env,
  });
  const client = new Client({ name: 'hermes-profile-proof', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('isolated Hermes profile: installed closure launches 3 tools (fixture authority; billing/persistence mocked)', {
  skip: process.platform !== 'linux',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lucy-hermes-profile-'));
  const configPath = join(dir, 'config.yaml.json');
  const authority = await listenIsolatedAm01({ token: TOKEN });
  try {
    const installed = installHermesLucyConfig(configPath, {
      baseUrl: authority.baseUrl,
      tokenEnv: 'LUCY_MEMORY_TOKEN',
      allowInsecureLoopback: true,
      profilePath: dir,
      artifact: { sourcePath: cleanHermesSource(), nodePath: process.execPath, version: '0.1.0', expectedSourceGitSha: cleanHermesSourceGitSha() },
    });
    const status = hermesLucyStatus(configPath);
    assert.equal(status.installed, true);
    assert.equal(status.hasToken, true);
    assert.equal(status.permissions, 'memory:read,memory:propose');
    const env = {
      LUCY_MEMORY_TOKEN: TOKEN,
      LUCY_MEMORY_PERMISSIONS: 'memory:read,memory:propose',
      LUCY_MEMORY_BASE_URL: authority.baseUrl,
      LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK: 'true',
      LUCY_MEMORY_TIMEOUT_MS: '5000',
    };

    const first = await withClient(installed.artifact, env, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), [
        'memory_recall',
        'memory_propose',
        'memory_proposal_status',
      ]);
      const proposed = await client.callTool({
        name: 'memory_propose',
        arguments: {
          operation: 'create',
          key: 'profile.rule',
          kind: 'rule',
          scope: { kind: 'user' },
          content: 'Always ask Lucy first.',
          justification: 'durable rule',
          idempotency_key: 'hermes-profile-key-16',
        },
      });
      assert.equal(proposed.structuredContent.status, 'pending');
      return proposed.structuredContent.id;
    });

    const second = await withClient(installed.artifact, env, async (client) => {
      const statusCall = await client.callTool({
        name: 'memory_proposal_status',
        arguments: { proposal_id: first },
      });
      return statusCall.structuredContent;
    });
    assert.equal(second.status, 'pending');
    assert.equal(second.id, first);

    uninstallHermesLucyConfig(configPath, { profilePath: dir });
    assert.equal(hermesLucyStatus(configPath).installed, false);
    assert.doesNotMatch(readFileSync(configPath, 'utf8'), /hermes-profile-token/);
  } finally {
    await authority.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
