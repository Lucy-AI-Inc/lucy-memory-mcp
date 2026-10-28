import { readFileSync } from 'node:fs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../fixtures/v1/positive/${name}.json`, import.meta.url), 'utf8'));
const pendingProposal = fixture('proposal-pending');
const canonicalRecall = (scope) => ({
  schema_version: 'canonical-recall-1', request_id: 'req_mock', as_of: '2026-08-20T00:00:00.000Z',
  consistency: 'canonical_active', scope, results: [], notices: [],
});

export function createTransport() {
  return async ({ operation, payload, accessToken, signal }) => {
    if (accessToken !== 'test-token') throw new Error('unexpected token');
    if (signal.aborted) throw new Error('aborted');
    const request = JSON.parse(payload);
    let body;
    let status = 200;
    if (operation === 'canonical-recall') {
      body = canonicalRecall(request.scope);
    } else if (operation === 'propose') {
      status = 202;
      body = { ...pendingProposal, operation: request.operation,
        requested: request.operation === 'create'
          ? { key: request.key, kind: request.kind, scope: request.scope }
          : { memory_id: request.memory_id, expected_version: request.expected_version, key: request.key, kind: pendingProposal.requested.kind, scope: request.scope } };
    } else if (operation === 'proposal-status') {
      body = { ...pendingProposal, id: request.proposal_id };
    } else throw new Error(`unexpected operation ${operation}`);
    return { status, body, byteLength: Buffer.byteLength(JSON.stringify(body)) };
  };
}
