import assert from 'node:assert/strict';
import test from 'node:test';
import {
  E2E_CASES,
  E2E_GATE_IDS,
  E2E_PORTS,
  assertSanitizedEvidence,
  isOwnedProjectId,
  pkceChallenge,
  rewriteSupabaseConfig,
} from '../../scripts/e2e/lib.mjs';

const config = `project_id = "shared"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[inbucket]\nport = 54324\n[auth]\nsite_url = "http://127.0.0.1:3000"\nadditional_redirect_urls = ["http://localhost:3000"]\n`;

test('disposable Supabase config uses only dedicated 56321-56329 ports', () => {
  const output = rewriteSupabaseConfig(config, 'lucy-hmcp-e2e-012345abcdef');
  assert.match(output, /project_id = "lucy-hmcp-e2e-012345abcdef"/);
  for (const port of Object.values(E2E_PORTS).filter((port) => port >= 56321)) assert.match(output, new RegExp(String(port)));
  assert.doesNotMatch(output, /5432[0-4]/);
  assert.equal(isOwnedProjectId('lucy-hmcp-e2e-012345abcdef'), true);
  assert.equal(isOwnedProjectId('lucy-v0-frontend-fork-local'), false);
});

test('PKCE S256 matches the RFC 7636 example', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('evidence sanitizer rejects secret-bearing keys and case inventory is complete', () => {
  assert.doesNotThrow(() => assertSanitizedEvidence({ sha: 'a'.repeat(40), status: 'PASS' }));
  assert.throws(() => assertSanitizedEvidence({ access_token: 'forbidden' }), /sensitive evidence key/);
  assert.equal(E2E_CASES.length, 24);
  assert.equal(new Set(E2E_CASES).size, E2E_CASES.length);
  assert.deepEqual(Object.keys(E2E_GATE_IDS), [...E2E_CASES]);
  assert.equal(Object.values(E2E_GATE_IDS).every((ids) => ids.length > 0), true);
});
