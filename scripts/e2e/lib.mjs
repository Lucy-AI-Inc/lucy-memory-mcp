import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

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

function rebaseSupabaseContentPaths(source) {
  return source.replace(
    /^(\s*content_path\s*=\s*")\.\/(?!supabase\/)([^"\r\n]+)("\s*(?:#.*)?)$/gm,
    '$1./supabase/$2$3',
  );
}

function setTomlBoolean(source, section, key, value) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const header = `[${section}]`;
  const sectionIndex = lines.findIndex((line) => line.trim() === header);
  if (sectionIndex < 0) {
    const separator = source.endsWith('\n') || source.endsWith('\r') ? '' : newline;
    return `${source}${separator}${header}${newline}${key} = ${value}${newline}`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^(\\s*${key}\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$`);
  for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = lines[index].replace(keyPattern, `$1${value}$2`);
      return lines.join(newline);
    }
  }
  lines.splice(sectionIndex + 1, 0, `${key} = ${value}`);
  return lines.join(newline);
}

function stripSupabaseFunctionSections(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let inFunctionSection = false;
  const output = [];

  for (const line of lines) {
    if (/^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line)) {
      inFunctionSection = /^\s*\[\[?\s*functions\s*(?:\.|\]\]?)/.test(line);
    }
    if (!inFunctionSection) output.push(line);
  }

  return output.join(newline);
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
  // The Supabase CLI resolves auth template content_path values from its
  // --workdir, not from supabase/config.toml. The disposable harness stages
  // the PRODUCT tree at <workdir>/supabase, so preserve those references by
  // rebasing project-relative paths to that copied tree.
  output = rebaseSupabaseContentPaths(output);
  // The CLI resolves and bundles configured function entrypoints during
  // `supabase start` even when edge_runtime.enabled is false. The proof uses
  // PRODUCT HTTP routes only, so remove every PRODUCT function declaration
  // from the disposable project and keep the runtime disabled as defense in
  // depth. Migrations, Auth, templates, and seed configuration remain intact.
  output = stripSupabaseFunctionSections(output);
  output = setTomlBoolean(output, 'edge_runtime', 'enabled', false);
  if (!/^\[analytics\]/m.test(output)) {
    output += `\n[analytics]\nenabled = true\nport = ${E2E_PORTS.analytics}\nvector_port = ${E2E_PORTS.vector}\n`;
  }
  if (!/^\[db\.pooler\]/m.test(output)) {
    output += `\n[db.pooler]\nenabled = false\nport = ${E2E_PORTS.pooler}\npool_mode = "transaction"\ndefault_pool_size = 15\nmax_client_conn = 100\n`;
  }
  return output;
}

function isContainedPath(parent, child) {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

export function stageSupabaseProject(source, target, projectId, { oldSchema = false } = {}) {
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  if (sourceRoot === targetRoot
    || isContainedPath(sourceRoot, targetRoot)
    || isContainedPath(targetRoot, sourceRoot)) {
    throw new Error('Supabase staging source and target must be separate trees');
  }

  const configPath = resolve(sourceRoot, 'config.toml');
  const migrationsPath = resolve(sourceRoot, 'migrations');
  if (!existsSync(configPath) || !existsSync(migrationsPath)) {
    throw new Error('PRODUCT Supabase source is incomplete');
  }
  const config = rewriteSupabaseConfig(readFileSync(configPath, 'utf8'), projectId);

  if (existsSync(targetRoot)) rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  cpSync(migrationsPath, resolve(targetRoot, 'migrations'), { recursive: true });
  // Copy only the assets used by this proof. PRODUCT Edge Function sources can
  // import application files outside supabase/, and staging them would let a
  // future CLI behavior change rediscover and bundle those entrypoints.
  for (const name of ['seed.sql', 'templates']) {
    const from = resolve(sourceRoot, name);
    if (existsSync(from)) cpSync(from, resolve(targetRoot, name), { recursive: true });
  }
  writeFileSync(resolve(targetRoot, 'config.toml'), config, { mode: 0o600 });

  const migrationFiles = readdirSync(resolve(targetRoot, 'migrations'))
    .filter((name) => name.endsWith('.sql')).map((name) => resolve(targetRoot, 'migrations', name));
  const admissionMigration = migrationAuthority(migrationFiles);
  if (oldSchema) rmSync(admissionMigration);
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
