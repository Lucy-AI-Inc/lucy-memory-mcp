import assert from 'node:assert/strict';
import test from 'node:test';
import { privateBetaDecision, renderGoNoGo, runCertification } from '../../scripts/private-beta-certify.mjs';

test('private-beta decision fails closed until every hosted gate passes', () => {
  const blocked = privateBetaDecision({ local: { passed: true } });
  assert.equal(blocked.decision, 'NO-GO');
  assert.ok(blocked.blockers.includes('LUC-1076 resolved'));
  assert.ok(blocked.blockers.includes('real before/during chat comparison'));

  const dependencies = Object.fromEntries(['LUC-1073', 'LUC-1074', 'LUC-1075', 'LUC-1076', 'LUC-1077', 'LUC-905'].map((id) => [id, 'passed']));
  const passed = privateBetaDecision({
    local: { passed: true },
    external: {
      dependencies,
      hosted_readiness: Object.fromEntries([
        'staging_adapter', 'oauth_resource_server', 'audience_client_credentials', 'exchange_integration',
        'disposable_workspaces', 'revocation_ttl', 'limit_billing', 'sampled_logs', 'auto_memory_policy',
        'deployment_region', 'public_hostname', 'auto_scaling',
      ].map((gate) => [gate, { passed: true }])),
      hosted_shas: { connector: 'a'.repeat(40), service: 'b'.repeat(40), harness: 'c'.repeat(40) },
      http_mcp: { passed: true },
      adversarial: { passed: true },
      chat_comparison: { evidence_mode: 'hosted', passed: true },
      kill_switch: { passed: true, chat_healthy: true },
      hermes_rollback: { platform: 'linux', passed: true },
      support: { capacity_confirmed: true, owners: ['owner@example.invalid'] },
    },
  });
  assert.equal(passed.decision, 'GO');
  assert.deepEqual(passed.blockers, []);
});

test('local/mock certification exercises lifecycle, load, shutdown, and evidence hashing', async () => {
  const evidence = await runCertification({ durationMs: 150, concurrency: 2 });
  assert.equal(evidence.local.passed, true);
  assert.equal(evidence.local.lifecycle.pending_not_recallable, true);
  assert.equal(evidence.local.lifecycle.approved_recallable, true);
  assert.ok(evidence.local.sustained_load.requests > 0);
  assert.equal(evidence.local.kill_switch.passed, true);
  assert.equal(evidence.local.tools.discovered.length, 3);
  assert.equal(evidence.local.clients.generic_inspector.passed, true);
  assert.equal(typeof evidence.local.clients.generic_inspector.passed, 'boolean');
  assert.equal(evidence.local.clients.cursor.passed, true);
  assert.equal(typeof evidence.local.clients.cursor.passed, 'boolean');
  assert.equal(evidence.go_no_go.decision, 'NO-GO');
  assert.match(evidence.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.match(renderGoNoGo(evidence), /Decision: \*\*NO-GO\*\*/);
});
