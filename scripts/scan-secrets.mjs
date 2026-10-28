#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const FORBIDDEN = [
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bsk-(?:proj|svcacct|ant-(?:api|admin)\d+|or-v\d+)-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bxapp-[A-Za-z0-9-]{10,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /BEGIN (?:RSA |OPENSSH |EC |ENCRYPTED )?PRIVATE KEY/,
  /\bsupabase[_-]?service[_-]?role\b/i,
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist']);
const EXACT_FAKE = new Set([
  'test-token',
  'secret-token',
  'hermes-profile-token',
  'fresh-token',
  'e2e-token',
  'fake-secret',
  '<token>',
  'tenant-a-token',
  'tenant-b-token',
  'idem-token',
  'race-token',
]);

export function findSecretHits(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  for (const re of FORBIDDEN) {
    const match = text.match(re);
    if (!match) continue;
    if (EXACT_FAKE.has(match[0])) continue;
    hits.push({ value: match[0], pattern: String(re) });
  }
  return hits;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export function scanTree(root) {
  const hits = [];
  for (const path of walk(root)) {
    const label = relative(root, path).replaceAll('\\', '/');
    hits.push(...scanBuffer(label, readFileSync(path)));
  }
  return hits;
}

export function scanBuffer(label, buffer) {
  let bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try { bytes = gunzipSync(bytes); } catch { /* scan compressed bytes if gunzip fails */ }
  }
  return findSecretHits(bytes.toString('latin1')).map((hit) => `${label}: ${hit.pattern}`);
}

export function report(hits, stream = process.stderr) {
  if (hits.length) {
    stream.write(`secret-scan FAIL\n${hits.join('\n')}\n`);
    return 1;
  }
  process.stdout.write('secret-scan PASS\n');
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(import.meta.dirname, '..');
  process.exit(report(scanTree(root)));
}
