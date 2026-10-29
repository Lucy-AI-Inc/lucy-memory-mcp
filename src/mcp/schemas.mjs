import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://schemas.trylucy.ai/agent-memory/v1/';
const SCHEMA_DIRECTORY = fileURLToPath(new URL('../../schemas/v1/', import.meta.url));
const CANONICAL_RECALL_OUTPUT = JSON.parse(readFileSync(new URL('../../schemas/canonical-recall/response.schema.json', import.meta.url), 'utf8'));
const documents = new Map();
for (const name of readdirSync(SCHEMA_DIRECTORY).filter((value) => value.endsWith('.schema.json')).sort()) {
  const document = JSON.parse(readFileSync(new URL(`../../schemas/v1/${name}`, import.meta.url), 'utf8'));
  if (document.$id !== `${BASE}${name}`) throw new Error(`Frozen schema identity mismatch: ${name}`);
  documents.set(name.replace('.schema.json', ''), document);
}

function referenceTarget(reference, currentName) {
  if (reference.startsWith('#')) return currentName;
  if (!reference.startsWith(BASE)) throw new Error(`External frozen schema reference is not allowed: ${reference}`);
  const relative = reference.slice(BASE.length);
  const hash = relative.indexOf('#');
  return (hash < 0 ? relative : relative.slice(0, hash)).replace('.schema.json', '');
}
function rewriteReference(reference, currentName) {
  if (reference.startsWith('#')) return `#/$defs/${currentName}${reference.slice(1)}`;
  const target = referenceTarget(reference, currentName);
  if (!documents.has(target)) throw new Error(`Frozen schema reference not found: ${reference}`);
  const hash = reference.indexOf('#');
  return `#/$defs/${target}${hash < 0 ? '' : reference.slice(hash + 1)}`;
}
function transform(value, currentName) {
  if (Array.isArray(value)) return value.map((item) => transform(item, currentName));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$id' || key === '$schema') continue;
    output[key] = key === '$ref' ? rewriteReference(child, currentName) : transform(child, currentName);
  }
  return output;
}
function collectReferences(value, currentName, found) {
  if (Array.isArray(value)) { for (const item of value) collectReferences(item, currentName, found); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref') {
      const target = referenceTarget(child, currentName);
      if (!found.has(target)) {
        found.add(target);
        collectReferences(documents.get(target), target, found);
      }
    } else collectReferences(child, currentName, found);
  }
}
function definitionsFor(rootNames) {
  const names = new Set(rootNames);
  for (const name of rootNames) collectReferences(documents.get(name), name, names);
  return Object.fromEntries([...names].sort().map((name) => [name, transform(documents.get(name), name)]));
}
function bundled(name) {
  const definitions = definitionsFor([name]);
  return { ...structuredClone(definitions[name]), $defs: definitions };
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const proposalDefinitions = definitionsFor(['create-proposal-request', 'replace-proposal-request']);
const createProposal = proposalDefinitions['create-proposal-request'];
const replaceProposal = proposalDefinitions['replace-proposal-request'];
const statusDefinitions = definitionsFor(['common']);
export const MCP_SCHEMAS = deepFreeze({
  recallInput: bundled('recall-request'),
  proposalInput: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...createProposal.properties,
      ...replaceProposal.properties,
      operation: { enum: ['create', 'replace'] },
    },
    oneOf: [{ $ref: '#/$defs/create-proposal-request' }, { $ref: '#/$defs/replace-proposal-request' }],
    $defs: proposalDefinitions,
  },
  proposalStatusInput: {
    type: 'object',
    additionalProperties: false,
    required: ['proposal_id'],
    properties: { proposal_id: { $ref: '#/$defs/common/$defs/proposalId' } },
    $defs: statusDefinitions,
  },
  recallOutput: bundled('recall-response'),
  canonicalRecallOutput: CANONICAL_RECALL_OUTPUT,
  proposalOutput: bundled('proposal-status'),
});

export function containsExternalSchemaReference(value) {
  if (Array.isArray(value)) return value.some(containsExternalSchemaReference);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (key === '$ref' && !String(child).startsWith('#')) || containsExternalSchemaReference(child));
}
