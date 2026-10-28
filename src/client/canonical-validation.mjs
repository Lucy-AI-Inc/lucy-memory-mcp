import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { MalformedResponseError } from './errors.mjs';

const schemaPath = fileURLToPath(new URL('../../schemas/canonical-recall/response.schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function matchesScope(left, right) { return left?.kind === right?.kind && left?.id === right?.id; }
function includesQuery(result, query) {
  const needle = query.toLowerCase();
  return result.content.toLowerCase().includes(needle) || (result.key !== null && result.key.toLowerCase().includes(needle));
}

export function canonicalRecallOutputSchema() { return structuredClone(schema); }

export function validateCanonicalRecallResponse(value, request) {
  if (!validate(value)) {
    const details = validate.errors?.map(({ instancePath, keyword, schemaPath: path }) => ({ instancePath, keyword, schemaPath: path }));
    throw new MalformedResponseError('Canonical recall response violates the strict canonical schema.', { details });
  }
  if (!request || !matchesScope(value.scope, request.scope)) throw new MalformedResponseError('Canonical recall response scope does not match the request.');
  if (value.results.length > (request.limit ?? 3)) throw new MalformedResponseError('Canonical recall response exceeds the requested limit.');
  for (const result of value.results) {
    if (!matchesScope(result.scope, value.scope) || !matchesScope(result.scope, request.scope)
      || result.provenance.record_id !== result.record_id) {
      throw new MalformedResponseError('Canonical recall response violates scope or provenance record binding.');
    }
    if (request.keys && (result.key === null || !request.keys.includes(result.key))) {
      throw new MalformedResponseError('Canonical recall response violates the requested key filter.');
    }
    if (request.kinds && !request.kinds.includes(result.kind)) {
      throw new MalformedResponseError('Canonical recall response violates the requested kind filter.');
    }
    if (!includesQuery(result, request.query)) throw new MalformedResponseError('Canonical recall response does not match the requested query.');
  }
  return value;
}
