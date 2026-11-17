import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const E2E_PORTS = Object.freeze({
  api: 56321,
  db: 56322,
  shadow: 56323,
  studio: 56324,
  inbucket: 56325,
  analytics: 56327,
  vector: 56328,
  pooler: 56329,
  product: 3190,
  mcp: 3191,
  oauth: 3192,
});

export const E2E_CASES = Object.freeze([
  'oauth_code_flow', 'initialize', 'tools_list', 'recall', 'propose', 'proposal_status',
  'pending_not_recallable', 'missing_token', 'wrong_audience_resource', 'expired_early_token',
  'revoked_token', 'introspection_unreachable', 'missing_scope', 'cross_workspace',
  'workspace_override', 'no_passthrough', 'raw_body_limit', 'scope_concurrency', 'scope_rate',
  'global_cap', 'mcp_kill_switch', 'product_kill_switch', 'log_redaction', 'old_schema',
]);

export const E2E_GATE_IDS = Object.freeze({
  oauth_code_flow: ['LUC-1073'],
  initialize: ['LUC-1078'],
  tools_list: ['LUC-1078', 'LUC-1077'],
  recall: ['LUC-1078'],
  propose: ['LUC-1078'],
  proposal_status: ['LUC-1078'],
  pending_not_recallable: ['LUC-1077'],
  missing_token: ['LUC-1073'],
  wrong_audience_resource: ['LUC-1073', 'LUC-1077'],
  expired_early_token: ['LUC-1073'],
  revoked_token: ['LUC-1073', 'LUC-1077'],
  introspection_unreachable: ['LUC-1073', 'LUC-1077'],
  missing_scope: ['LUC-1073'],
  cross_workspace: ['LUC-1077'],
  workspace_override: ['LUC-1077'],
  no_passthrough: ['LUC-1073', 'LUC-1077'],
  raw_body_limit: ['LUC-1078', 'LUC-1077'],
  scope_concurrency: ['LUC-1078'],
  scope_rate: ['LUC-1078'],
  global_cap: ['LUC-1078'],
  mcp_kill_switch: ['LUC-1078'],
  product_kill_switch: ['LUC-1078'],
  log_redaction: ['LUC-1077'],
  old_schema: ['LUC-1078', 'LUC-1077'],
});

export function requireAbsoluteDirectory(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function replaceTomlNumber(source, section, key, value) {
  const sectionPattern = section.replaceAll('.', '\\.');
  const pattern = new RegExp(`(\\[${sectionPattern}\\][\\s\\S]*?\\n${key}\\s*=\\s*)\\d+`, 'm');
  if (!pattern.test(source)) throw new Error(`Supabase config missing [${section}] ${key}`);
  return source.replace(pattern, `$1${value}`);
}

export function rewriteSupabaseConfig(source, projectId) {
  if (typeof source !== 'string' || !/^lucy-hmcp-e2e-[a-f0-9]{12}$/.test(projectId)) {
    throw new Error('invalid disposable Supabase project id');
  }
  let output = source.replace(/^project_id\s*=\s*"[^"]+"/m, `project_id = "${projectId}"`);
  output = replaceTomlNumber(output, 'api', 'port', E2E_PORTS.api);
  output = replaceTomlNumber(output, 'db', 'port', E2E_PORTS.db);
  output = replaceTomlNumber(output, 'db', 'shadow_port', E2E_PORTS.shadow);
  output = replaceTomlNumber(output, 'studio', 'port', E2E_PORTS.studio);
  output = replaceTomlNumber(output, 'inbucket', 'port', E2E_PORTS.inbucket);
  output = output.replace(/^site_url\s*=\s*"[^"]+"/m, `site_url = "http://127.0.0.1:${E2E_PORTS.product}"`);
  output = output.replace(/^additional_redirect_urls\s*=.*$/m,
    `additional_redirect_urls = ["http://127.0.0.1:${E2E_PORTS.product}", "http://127.0.0.1:${E2E_PORTS.oauth}/callback"]`);
  if (!/^\[analytics\]/m.test(output)) {
    output += `\n[analytics]\nenabled = true\nport = ${E2E_PORTS.analytics}\nvector_port = ${E2E_PORTS.vector}\n`;
  }
  if (!/^\[db\.pooler\]/m.test(output)) {
    output += `\n[db.pooler]\nenabled = false\nport = ${E2E_PORTS.pooler}\npool_mode = "transaction"\ndefault_pool_size = 15\nmax_client_conn = 100\n`;
  }
  return output;
}

export function migrationAuthority(files) {
  const matches = files.filter((file) => {
    const sql = readFileSync(file, 'utf8');
    return /create\s+(?:or\s+replace\s+)?function\s+public\.acquire_hosted_mcp_admission\s*\(/i.test(sql)
      && /create\s+(?:or\s+replace\s+)?function\s+public\.release_hosted_mcp_admission\s*\(/i.test(sql);
  });
  if (matches.length !== 1) throw new Error(`expected exactly one hosted admission migration, found ${matches.length}`);
  return matches[0];
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function denverTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}[America/Denver]`;
}

const SENSITIVE_KEY = /(?:authorization|token|secret|password|credential|cookie|lease|content|justification)/i;

export function assertSanitizedEvidence(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitizedEvidence(entry, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive evidence key at ${path}.${key}`);
      assertSanitizedEvidence(entry, `${path}.${key}`);
    }
  }
  return value;
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export function isOwnedProjectId(value) {
  return /^lucy-hmcp-e2e-[a-f0-9]{12}$/.test(value);
}
