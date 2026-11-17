import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  E2E_CASES,
  E2E_GATE_IDS,
  E2E_PORTS,
  assertSanitizedEvidence,
  isOwnedProjectId,
  migrationAuthority,
  pkceChallenge,
  rewriteSupabaseConfig,
  stageSupabaseProject,
} from '../../scripts/e2e/lib.mjs';

const config = `project_id = "shared"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[inbucket]\nport = 54324\n[auth]\nsite_url = "http://127.0.0.1:3000"\nadditional_redirect_urls = ["http://localhost:3000"]\n[auth.email.template.confirmation]\ncontent_path = "./templates/confirmation.html"\n[auth.email.template.magic_link]\ncontent_path = "./templates/magic_link.html"\n`;

test('disposable Supabase config rewrites owned ports and staged file paths', () => {
  const output = rewriteSupabaseConfig(config, 'lucy-hmcp-e2e-012345abcdef');
  assert.match(output, /project_id = "lucy-hmcp-e2e-012345abcdef"/);
  for (const port of Object.values(E2E_PORTS).filter((port) => port >= 56321)) assert.match(output, new RegExp(String(port)));
  assert.doesNotMatch(output, /5432[0-4]/);
  assert.match(output, /content_path = "\.\/supabase\/templates\/confirmation\.html"/);
  assert.match(output, /content_path = "\.\/supabase\/templates\/magic_link\.html"/);
  assert.doesNotMatch(output, /content_path = "\.\/templates\//);
  assert.match(output, /\[edge_runtime\]\nenabled = false/);
  assert.equal(isOwnedProjectId('lucy-hmcp-e2e-012345abcdef'), true);
  assert.equal(isOwnedProjectId('lucy-v0-frontend-fork-local'), false);
});

test('disposable Supabase config overrides an enabled edge runtime', () => {
  const output = rewriteSupabaseConfig(`${config}\n[edge_runtime]\nenabled = true # local default\n`, 'lucy-hmcp-e2e-012345abcdef');
  assert.match(output, /\[edge_runtime\]\nenabled = false # local default/);
  assert.doesNotMatch(output, /enabled = true # local default/);
});

test('PKCE S256 matches the RFC 7636 example', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('hosted admission migration is identified by its SQL authority, not its timestamp', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hmcp-migrations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ordinary = join(directory, '20000101000000_ordinary.sql');
  const admission = join(directory, '20261116051300_hosted_mcp_admission.sql');
  writeFileSync(ordinary, 'CREATE TABLE public.ordinary (id integer);\n');
  writeFileSync(admission, [
    'CREATE OR REPLACE FUNCTION public.acquire_hosted_mcp_admission() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
    'CREATE OR REPLACE FUNCTION public.release_hosted_mcp_admission() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
    '',
  ].join('\n'));

  assert.equal(basename(migrationAuthority([ordinary, admission])), basename(admission));
  assert.throws(() => migrationAuthority([ordinary]), /expected exactly one hosted admission migration, found 0/);
  assert.throws(() => migrationAuthority([admission, admission]), /expected exactly one hosted admission migration, found 2/);
});

test('disposable Supabase staging disables Edge execution and preserves source files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hmcp-supabase-stage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'product-supabase');
  const target = join(directory, 'owned-workdir', 'supabase');
  mkdirSync(join(source, 'migrations'), { recursive: true });
  mkdirSync(join(source, 'templates'), { recursive: true });
  mkdirSync(join(source, 'functions', 'stripe-webhook'), { recursive: true });
  mkdirSync(join(source, 'functions', '_shared'), { recursive: true });
  writeFileSync(join(source, 'config.toml'), `${config}\n[functions.stripe-webhook]\nverify_jwt = false\n`);
  writeFileSync(join(source, 'seed.sql'), '-- disposable seed\n');
  writeFileSync(join(source, 'templates', 'confirmation.html'), 'confirm\n');
  writeFileSync(join(source, 'functions', 'stripe-webhook', 'index.ts'), "import '../_shared/runtime.ts';\n");
  writeFileSync(join(source, 'functions', '_shared', 'runtime.ts'), 'export {};\n');
  writeFileSync(join(source, 'migrations', '20261116051300_hosted_mcp_admission.sql'), [
    'CREATE OR REPLACE FUNCTION public.acquire_hosted_mcp_admission() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
    'CREATE OR REPLACE FUNCTION public.release_hosted_mcp_admission() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
    '',
  ].join('\n'));

  stageSupabaseProject(source, target, 'lucy-hmcp-e2e-012345abcdef');

  assert.match(readFileSync(join(target, 'config.toml'), 'utf8'), /\[edge_runtime\]\nenabled = false/);
  assert.equal(readFileSync(join(target, 'functions', 'stripe-webhook', 'index.ts'), 'utf8'), "import '../_shared/runtime.ts';\n");
  assert.equal(readFileSync(join(target, 'functions', '_shared', 'runtime.ts'), 'utf8'), 'export {};\n');
  assert.equal(readFileSync(join(target, 'seed.sql'), 'utf8'), '-- disposable seed\n');
  assert.equal(readFileSync(join(target, 'templates', 'confirmation.html'), 'utf8'), 'confirm\n');

  stageSupabaseProject(source, target, 'lucy-hmcp-e2e-012345abcdef', { oldSchema: true });
  assert.equal(readFileSync(join(target, 'functions', 'stripe-webhook', 'index.ts'), 'utf8'), "import '../_shared/runtime.ts';\n");
  assert.equal(existsSync(join(target, 'migrations', '20261116051300_hosted_mcp_admission.sql')), false);
});

test('evidence sanitizer rejects secret-bearing keys and case inventory is complete', () => {
  assert.doesNotThrow(() => assertSanitizedEvidence({ sha: 'a'.repeat(40), status: 'PASS' }));
  assert.throws(() => assertSanitizedEvidence({ access_token: 'forbidden' }), /sensitive evidence key/);
  assert.equal(E2E_CASES.length, 24);
  assert.equal(new Set(E2E_CASES).size, E2E_CASES.length);
  assert.deepEqual(Object.keys(E2E_GATE_IDS), [...E2E_CASES]);
  assert.equal(Object.values(E2E_GATE_IDS).every((ids) => ids.length > 0), true);
});
