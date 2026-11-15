import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hostedMcpDisabledResponse } from '../src/operability.mjs';

export function rollbackPlan({ service, currentImage, previousImage }) {
  if (typeof service !== 'string' || !/^lucy-memory-mcp(?:-[a-z0-9-]+)?$/.test(service)) {
    throw new Error('Rollback target must be an explicitly named Lucy hosted MCP service.');
  }
  for (const [name, value] of Object.entries({ currentImage, previousImage })) {
    if (typeof value !== 'string' || !/@sha256:[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must use an immutable image digest.`);
  }
  if (currentImage === previousImage) throw new Error('Previous image must differ from current image.');
  return Object.freeze({ service, from: currentImage, to: previousImage, apply: false, chat_affected: false });
}

export function runDrill() {
  const disabled = hostedMcpDisabledResponse();
  assert.equal(disabled.status, 503);
  assert.deepEqual(JSON.parse(disabled.body), {
    error: { code: 'hosted_mcp_disabled', message: 'Hosted Lucy Memory MCP is disabled.' },
  });
  const plan = rollbackPlan({
    service: 'lucy-memory-mcp-production',
    currentImage: `memory@sha256:${'a'.repeat(64)}`,
    previousImage: `memory@sha256:${'b'.repeat(64)}`,
  });
  assert.equal(plan.to, `memory@sha256:${'b'.repeat(64)}`);
  assert.equal(plan.apply, false);
  assert.equal(plan.chat_affected, false);
  assert.throws(() => rollbackPlan({
    service: 'lucy-chat-production',
    currentImage: `chat@sha256:${'a'.repeat(64)}`,
    previousImage: `chat@sha256:${'b'.repeat(64)}`,
  }), /hosted MCP service/);
  return { drill: 'passed', disabled_code: 'hosted_mcp_disabled', rollback: plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(runDrill())}\n`);
}
