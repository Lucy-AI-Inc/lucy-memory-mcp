import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as api from '../../src/client/index.mjs';

const {
  AgentMemoryClient, AuthenticationFailureError, AuthorizationFailureError, InternalLucyError, InvalidKeyError,
 InvalidKindError, InvalidScopeError, LifecycleConflictError, MalformedResponseError, MemoryNotFoundError,
 ProposalNotFoundError, RateLimitError, TimeoutError, UpstreamUnavailableError, ValidationFailureError,
 VersionConflictError, InsufficientCreditsError, BillingUnavailableError, stableSerialize,
 } = api;
const USER = Object.freeze({ kind: 'user' });
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../fixtures/v1/${path}.json`, import.meta.url)));
const bytes = (body) => Buffer.byteLength(JSON.stringify(body));
const reply = (body, status = 200, options = {}) => ({ status, body, byteLength: options.byteLength ?? bytes(body), ...options });
const recall = (scope = USER) => ({ schema_version: '1', request_id: 'req_test', as_of: '2026-08-14T00:00:00.000Z', consistency: 'canonical_active', scope, results: [], notices: [] });
const canonicalRecall = (scope = USER) => ({
  schema_version: 'canonical-recall-1', request_id: 'req_test', as_of: '2026-08-14T00:00:00.000Z',
  consistency: 'canonical_active', scope, results: [{
    record_id: 'memory-record-test', key: 'profile.name', kind: 'fact', scope, content: 'Ada', status: 'active', persisted: true,
    approval_status: 'controller_approved', version: null,
    provenance: { type: 'lucy_canonical', record_id: 'memory-record-test', proposal_id: null, canonical_payload_hash: null, written_at: '2026-08-14T00:00:00.000Z' },
  }], notices: [],
});
const canonicalRecallResults = (count, scope = USER) => {
  const body = canonicalRecall(scope);
  return {
    ...body,
    results: Array.from({ length: count }, (_, index) => {
      const record_id = `memory-record-${index}`;
      return { ...body.results[0], record_id, key: `profile.name-${index}`, provenance: { ...body.results[0].provenance, record_id } };
    }),
  };
};
const create = () => ({ operation: 'create', key: 'profile.name', kind: 'fact', scope: USER, content: 'Ada', justification: 'User stated this.', idempotency_key: 'idem_123456789012' });
const requestJson = stableSerialize;
function makeClient(transport, options = {}) {
  return new AgentMemoryClient({ transport, token: 'secret-token', permissions: ['memory:read', 'memory:propose'], ...options });
}
function capture(body, status = 200) {
  const calls = [];
  return { calls, transport: async (request) => { calls.push(request); return reply(body, status); } };
}
function errorEnvelope(code, retryable = false, message = code) {
  return { schema_version: '1', request_id: 'req_error', error: { code, message, retryable } };
}

test('recall uses deterministic transport-neutral operation with authentication', async () => {
  const wire = capture(recall());
  assert.deepEqual(await makeClient(wire.transport).recall(requestJson({ scope: USER, query: 'profile', keys: ['profile.name'], limit: 3 })), recall());
  assert.equal(wire.calls[0].operation, 'recall');
  assert.equal(wire.calls[0].accessToken, 'secret-token');
  assert.equal(wire.calls[0].payload, '{"keys":["profile.name"],"limit":3,"query":"profile","scope":{"kind":"user"}}');
  assert.ok(wire.calls[0].signal instanceof AbortSignal);
  assert.equal('url' in wire.calls[0], false);
});

test('canonical recall uses its strict projection operation and rejects downgraded or incoherent results', async () => {
  const wire = capture(canonicalRecall());
  const client = makeClient(wire.transport);
  const request = requestJson({ scope: USER, query: 'Ada', keys: ['profile.name'], kinds: ['fact'], limit: 1 });
  assert.deepEqual(await client.recallCanonical(request), canonicalRecall());
  assert.equal(wire.calls.length, 1);
  assert.equal(wire.calls[0].operation, 'canonical-recall');
  await assert.rejects(makeClient(async () => reply(recall())).recallCanonical(request), MalformedResponseError);
  await assert.rejects(makeClient(async () => reply({ ...canonicalRecall(), unexpected: true })).recallCanonical(request), MalformedResponseError);
  await assert.rejects(makeClient(async () => reply((({ notices, ...body }) => body)(canonicalRecall()))).recallCanonical(request), MalformedResponseError);
  await assert.rejects(makeClient(async () => reply({ ...canonicalRecall(), results: [{ ...canonicalRecall().results[0], provenance: { ...canonicalRecall().results[0].provenance, record_id: 'other' } }] })).recallCanonical(request), MalformedResponseError);
  await assert.rejects(makeClient(async () => reply({ ...canonicalRecall(), results: [{ ...canonicalRecall().results[0], content: 'Grace' }] })).recallCanonical(request), MalformedResponseError);
});

test('canonical recall defaults an omitted limit to the contract value of 3', async () => {
  const request = requestJson({ scope: USER, query: 'Ada' });
  const accepted = canonicalRecallResults(3);
  const wire = capture(accepted);
  assert.deepEqual(await makeClient(wire.transport).recallCanonical(request), accepted);
  assert.equal(wire.calls.length, 1);
  await assert.rejects(makeClient(async () => reply(canonicalRecallResults(4))).recallCanonical(request), MalformedResponseError);
});

test('canonical recall enforces explicit limits 1 through 5 without retries or fallback', async () => {
  for (const limit of [1, 2, 3, 4, 5]) {
    const request = requestJson({ scope: USER, query: 'Ada', limit });
    const accepted = canonicalRecallResults(limit);
    const wire = capture(accepted);
    assert.deepEqual(await makeClient(wire.transport).recallCanonical(request), accepted);
    assert.equal(wire.calls.length, 1, `limit ${limit} must make one canonical-recall call`);
    assert.equal(wire.calls[0].operation, 'canonical-recall');
    await assert.rejects(makeClient(async () => reply(canonicalRecallResults(limit + 1))).recallCanonical(request), MalformedResponseError);
  }
});

test('propose and proposal-status expose only the three frozen operations', async () => {
  const pending = fixture('positive/proposal-pending');
  const wire = capture(pending, 202);
  const client = makeClient(wire.transport);
  assert.deepEqual(await client.propose(requestJson(fixture('positive/create-request'))), pending);
  assert.deepEqual(await client.proposalStatus(requestJson({ proposal_id: pending.id })), pending);
  assert.deepEqual(wire.calls.map(({ operation }) => operation), ['propose', 'proposal-status']);
});

for (const scope of [USER, { kind: 'workspace' }, { kind: 'project', id: 'project_alpha' }]) {
  test(`accepts ${scope.kind} scope`, async () => {
    const result = await makeClient(async () => reply(recall(scope))).recall(requestJson({ scope, query: 'profile' }));
    assert.deepEqual(result.scope, scope);
  });
}

test('rejects invalid scope, key, kind, and tenant authority before transport', async () => {
  let calls = 0;
  const client = makeClient(async () => { calls += 1; return reply(recall()); });
  await assert.rejects(client.recall(requestJson({ scope: { kind: 'tenant' }, query: 'x' })), InvalidScopeError);
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x', keys: ['Bad Key'] })), InvalidKeyError);
  await assert.rejects(client.propose(requestJson({ ...create(), kind: 'credential' })), InvalidKindError);
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x', tenant_id: 'tenant_1' })), ValidationFailureError);
  assert.equal(calls, 0);
});

test('enforces the frozen client authorization matrix before transport', async () => {
  const operations = [
    ['recall', requestJson({ scope: USER, query: 'profile' }), () => recall()],
    ['propose', requestJson(fixture('positive/create-request')), () => fixture('positive/proposal-pending')],
    ['proposalStatus', requestJson({ proposal_id: 'proposal_456' }), () => fixture('positive/proposal-pending')],
  ];
  const permissions = [
    ['read-only', ['memory:read'], new Set(['recall', 'proposalStatus'])],
    ['propose-only', ['memory:propose'], new Set(['propose'])],
    ['both', ['memory:read', 'memory:propose'], new Set(['recall', 'propose', 'proposalStatus'])],
    ['neither', [], new Set()],
  ];

  for (const [permissionSetName, configuredPermissions, allowedOperations] of permissions) {
    for (const [operation, request, response] of operations) {
      let calls = 0;
      const client = makeClient(async () => { calls += 1; return reply(response(), operation === 'propose' ? 202 : 200); }, { permissions: configuredPermissions });
      if (allowedOperations.has(operation)) {
        await client[operation](request);
        assert.equal(calls, 1, `${permissionSetName} ${operation} should invoke transport once`);
      } else {
        await assert.rejects(client[operation](request), AuthorizationFailureError);
        assert.equal(calls, 0, `${permissionSetName} ${operation} must fail before transport`);
      }
    }
  }
});

test('rejects missing and invalid authentication configuration', () => {
  assert.throws(() => new AgentMemoryClient({ transport: async () => reply({}), token: '', permissions: [] }), AuthenticationFailureError);
  assert.throws(() => new AgentMemoryClient({ transport: async () => reply({}), token: 'prefix\0suffix', permissions: [] }), AuthenticationFailureError);
});

const mappings = [
  [401, 'unauthenticated', AuthenticationFailureError, 'recall'],
  [403, 'forbidden', AuthorizationFailureError, 'recall'],
  [400, 'invalid_scope', InvalidScopeError, 'recall'],
  [400, 'invalid_request', ValidationFailureError, 'recall'],
  [400, 'unsupported_version', ValidationFailureError, 'recall'],
  [413, 'payload_too_large', ValidationFailureError, 'recall'],
  [409, 'version_conflict', VersionConflictError, 'propose'],
  [409, 'conflict', LifecycleConflictError, 'propose'],
  [404, 'not_found_or_not_visible', MemoryNotFoundError, 'recall'],
  [404, 'not_found_or_not_visible', ProposalNotFoundError, 'proposal-status'],
  [503, 'service_unavailable', UpstreamUnavailableError, 'recall'],
  [402, 'insufficient_credits', InsufficientCreditsError, 'recall'],
  [503, 'billing_unavailable', BillingUnavailableError, 'recall'],
  [500, 'invalid_request', InternalLucyError, 'recall'],
];
for (const [status, code, ErrorType, operation] of mappings) {
  test(`maps ${status} ${code} for ${operation}`, async () => {
    const backendMessage = `private backend diagnostic for ${code}`;
    const client = makeClient(async () => reply(errorEnvelope(
      code,
      code === 'service_unavailable' || code === 'billing_unavailable',
      backendMessage,
    ), status));
    const action = operation === 'propose' ? client.propose(requestJson(create()))
      : operation === 'proposal-status' ? client.proposalStatus(requestJson({ proposal_id: 'proposal_missing' }))
        : client.recall(requestJson({ scope: USER, query: 'x' }));
    await assert.rejects(action, (error) => {
      assert.ok(error instanceof ErrorType);
      assert.equal(error.message, new ErrorType().message);
      assert.doesNotMatch(String(error), /private backend diagnostic/);
      assert.equal(error.details.lucyCode, code);
      return true;
    });
  });
}

test('rate limit is retryable and preserves adapter retry delay', async () => {
  const client = makeClient(async () => reply(errorEnvelope('rate_limited', true, 'private throttling diagnostic'), 429, { retryAfterMs: 7000 }));
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), (error) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.message, 'Lucy rate limited the request.');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 7000);
    assert.doesNotMatch(String(error), /private throttling diagnostic/);
    return true;
  });
});

test('malformed error envelopes fail closed instead of being trusted', async () => {
  const client = makeClient(async () => reply({ error: { code: 'unauthenticated', message: 'x' } }, 401));
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), MalformedResponseError);
});

test('preserves only bounded public backend error request IDs in SDK error details', async () => {
  const validId = 'req_backend-error_123';
  const correlated = makeClient(async () => reply({
    ...errorEnvelope('forbidden'), request_id: validId,
  }, 403));
  await assert.rejects(correlated.recall(requestJson({ scope: USER, query: 'x' })), (error) => {
    assert.ok(error instanceof AuthorizationFailureError);
    assert.deepEqual(error.details, { lucyCode: 'forbidden', request_id: validId });
    return true;
  });

  const oversizedId = `req_${'a'.repeat(253)}`;
  const oversized = makeClient(async () => reply({
    ...errorEnvelope('forbidden'), request_id: oversizedId,
  }, 403));
  await assert.rejects(oversized.recall(requestJson({ scope: USER, query: 'x' })), (error) => {
    assert.ok(error instanceof AuthorizationFailureError);
    assert.deepEqual(error.details, { lucyCode: 'forbidden' });
    assert.doesNotMatch(JSON.stringify(error.details), /a{32}/);
    return true;
  });
});

test('missing or malformed backend error request IDs, including terminal controls, remain malformed-response failures', async () => {
  const errorBodies = [
    (() => { const { request_id: _requestId, ...body } = errorEnvelope('forbidden'); return body; })(),
    { ...errorEnvelope('forbidden'), request_id: 'not_a_request_id' },
    { ...errorEnvelope('forbidden'), request_id: 'req_control\nvalue' },
    { ...errorEnvelope('forbidden'), request_id: 'req_safe\n' },
  ];
  for (const body of errorBodies) {
    const client = makeClient(async () => reply(body, 403));
    await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), (error) => {
      assert.ok(error instanceof MalformedResponseError);
      assert.doesNotMatch(JSON.stringify(error.details), /not_a_request_id|control|req_safe/);
      return true;
    });
  }
});

test('timeout covers the complete transport operation', async () => {
  const client = makeClient(async ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(reply(recall())), { once: true })), { timeoutMs: 5 });
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), (error) => error instanceof TimeoutError && error.retryable);
});

test('transport failures redact raw causes and credentials', async () => {
  const client = makeClient(async () => { throw new Error('secret-token upstream diagnostic'); });
  await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), (error) => error instanceof UpstreamUnavailableError && !('cause' in error) && !String(error).includes('secret-token'));
});

test('enforces proposal request and recall response byte limits', async () => {
  let called = false;
  const client = makeClient(async () => { called = true; return reply(recall()); });
  const oversized = { operation: 'replace', memory_id: `mem_${'a'.repeat(3000)}`, expected_version: 1, key: `a${'b'.repeat(127)}`, scope: { kind: 'project', id: `project_${'a'.repeat(120)}` }, content: '😀'.repeat(2000), justification: '😀'.repeat(500), idempotency_key: 'x'.repeat(128), source_ref: '😀'.repeat(256) };
  assert.ok(Buffer.byteLength(stableSerialize(oversized)) > 12288);
  await assert.rejects(client.propose(requestJson(oversized)), ValidationFailureError);
  assert.equal(called, false);
  const huge = makeClient(async () => reply({ junk: 'x'.repeat(66000) }, 200, { byteLength: 66011 }));
  await assert.rejects(huge.recall(requestJson({ scope: USER, query: 'x' })), MalformedResponseError);
  await assert.rejects(huge.recallCanonical(requestJson({ scope: USER, query: 'x' })), MalformedResponseError);
});

test('accepts complete frozen success fixtures', async () => {
  const recallFixture = fixture('positive/recall-response');
  const approvedCreate = fixture('positive/proposal-create-approved');
  const approvedReplace = fixture('positive/proposal-approved');
  assert.deepEqual(await makeClient(async () => reply(recallFixture)).recall(requestJson(fixture('positive/recall-request'))), recallFixture);
  assert.deepEqual(await makeClient(async () => reply(approvedCreate)).propose(requestJson(fixture('positive/create-request'))), approvedCreate);
  assert.deepEqual(await makeClient(async () => reply(approvedReplace)).proposalStatus(requestJson({ proposal_id: approvedReplace.id })), approvedReplace);
});

test('rejects schema-valid responses that belong to another request', async () => {
  await assert.rejects(makeClient(async () => reply(recall({ kind: 'workspace' }))).recall(requestJson({ scope: USER, query: 'x' })), MalformedResponseError);
  const pending = fixture('positive/proposal-pending');
  await assert.rejects(makeClient(async () => reply({ ...pending, id: 'proposal_other' })).proposalStatus(requestJson({ proposal_id: pending.id })), MalformedResponseError);
  await assert.rejects(makeClient(async () => reply({ ...pending, requested: { key: 'other.key', kind: 'rule', scope: { kind: 'workspace' } } })).propose(requestJson(create())), MalformedResponseError);
});

test('post-call mutation cannot change serialized state or response correlation', async () => {
  let release;
  let sent;
  const client = makeClient(async (transportRequest) => {
    sent = transportRequest;
    return new Promise((resolve) => { release = resolve; });
  });
  const request = { scope: { kind: 'user' }, query: 'safe' };
  const pending = client.recall(requestJson(request));
  await Promise.resolve();
  request.scope.kind = 'workspace';
  request.query = 'mutated';
  release(reply(recall(USER)));
  assert.deepEqual((await pending).scope, USER);
  assert.equal(sent.payload, '{"query":"safe","scope":{"kind":"user"}}');
});

test('rejects accessor-bearing requests before invoking getters or transport', async () => {
  let getterReads = 0;
  let transportCalls = 0;
  const request = { query: 'safe' };
  Object.defineProperty(request, 'scope', {
    enumerable: true,
    get() {
      getterReads += 1;
      return getterReads === 1 ? { kind: 'user' } : { kind: 'user', tenant_id: 'tenant_injected' };
    },
  });
  const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
  await assert.rejects(client.recall(request), (error) => error instanceof ValidationFailureError && /JSON text/i.test(error.message));
  assert.equal(getterReads, 0);
  assert.equal(transportCalls, 0);
});

test('rejects caller objects at the inert JSON-text boundary', async () => {
  let transportCalls = 0;
  const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
  await assert.rejects(client.recall({ scope: USER, query: 'safe' }), (error) => error instanceof ValidationFailureError && /JSON text/i.test(error.message));
  assert.equal(transportCalls, 0);
});

test('rejects Proxy inputs without executing reflection traps', async () => {
  let effects = 0;
  let transportCalls = 0;
  const request = new Proxy({ scope: { kind: 'user' }, query: 'safe' }, {
    getPrototypeOf(target) { effects += 1; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { effects += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { effects += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
  await assert.rejects(client.recall(request), ValidationFailureError);
  assert.equal(effects, 0);
  assert.equal(transportCalls, 0);
});

test('fails closed on the non-index array key 4294967295', async () => {
  let transportCalls = 0;
  const keys = ['profile.name'];
  Object.defineProperty(keys, '4294967295', { enumerable: true, value: 'tenant_id' });
  const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
  await assert.rejects(client.recall({ scope: USER, query: 'safe', keys }), ValidationFailureError);
  assert.equal(transportCalls, 0);
});

const hostileCases = [
  ['ordinary setter descriptor', (effect) => {
    const value = { query: 'safe' }; Object.defineProperty(value, 'scope', { enumerable: true, set() { effect(); } }); return value;
  }],
  ['Proxy wrapping getter-bearing object', (effect) => new Proxy(Object.defineProperty({ query: 'safe' }, 'scope', { enumerable: true, get() { effect(); return USER; } }), {})],
  ['Proxy getOwnPropertyDescriptor trap', (effect) => new Proxy({ scope: USER, query: 'safe' }, { getOwnPropertyDescriptor(target, key) { effect(); return Reflect.getOwnPropertyDescriptor(target, key); } })],
  ['Proxy ownKeys trap', (effect) => new Proxy({ scope: USER, query: 'safe' }, { ownKeys(target) { effect(); return Reflect.ownKeys(target); } })],
  ['Proxy getPrototypeOf trap', (effect) => new Proxy({ scope: USER, query: 'safe' }, { getPrototypeOf(target) { effect(); return Reflect.getPrototypeOf(target); } })],
  ['Proxy disguising accessor as data', (effect) => {
    const target = Object.defineProperty({ query: 'safe' }, 'scope', { configurable: true, enumerable: true, get() { effect(); return USER; } });
    return new Proxy(target, { getOwnPropertyDescriptor(value, key) { return key === 'scope' ? { configurable: true, enumerable: true, writable: true, value: value.scope } : Reflect.getOwnPropertyDescriptor(value, key); } });
  }],
  ['Proxy authority-field injection', (effect) => new Proxy({ scope: USER, query: 'safe' }, { ownKeys() { effect(); return ['scope', 'query', 'tenant_id']; } })],
  ['inherited authority field', (effect) => { const value = Object.create(Object.defineProperty({}, 'tenant_id', { get() { effect(); return 'tenant_x'; } })); value.scope = USER; value.query = 'safe'; return value; }],
  ['symbol authority field', (effect) => Object.defineProperty({ scope: USER, query: 'safe' }, Symbol('tenant_id'), { get() { effect(); return 'tenant_x'; } })],
  ['toJSON side effect', (effect) => ({ scope: USER, query: 'safe', toJSON() { effect(); return {}; } })],
  ['valueOf side effect', (effect) => ({ scope: USER, query: 'safe', valueOf() { effect(); return 1; } })],
  ['Symbol.toPrimitive side effect', (effect) => ({ scope: USER, query: 'safe', [Symbol.toPrimitive]() { effect(); return 'x'; } })],
  ['custom iterator side effect', (effect) => { const keys = ['profile.name']; Object.defineProperty(keys, Symbol.iterator, { value() { effect(); return [][Symbol.iterator](); } }); return { scope: USER, query: 'safe', keys }; }],
  ['sparse nested array', () => ({ scope: USER, query: 'safe', keys: new Array(2) })],
  ['named enumerable nested array property', () => { const keys = ['profile.name']; keys.authority = 'tenant_x'; return { scope: USER, query: 'safe', keys }; }],
  ['nested malicious object', (effect) => ({ scope: new Proxy({ kind: 'user' }, { ownKeys(target) { effect(); return Reflect.ownKeys(target); } }), query: 'safe' })],
  ['nested malicious array', (effect) => ({ scope: USER, query: 'safe', keys: new Proxy(['profile.name'], { get(target, key, receiver) { effect(); return Reflect.get(target, key, receiver); } }) })],
  ['prototype-pollution-shaped key', () => Object.defineProperty({ scope: USER, query: 'safe' }, '__proto__', { enumerable: true, value: { tenant_id: 'tenant_x' } })],
  ['direct account authority', () => ({ scope: USER, query: 'safe', account_id: 'account_x' })],
];
for (const [name, factory] of hostileCases) {
  test(`inert boundary rejects ${name} with zero execution and transport`, async () => {
    let effects = 0; let transportCalls = 0;
    const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
    await assert.rejects(client.recall(factory(() => { effects += 1; })), (error) => error instanceof ValidationFailureError && error.code === 'validation_failure' && /JSON text/i.test(error.message));
    assert.equal(effects, 0); assert.equal(transportCalls, 0);
  });
}

for (const key of ['0', '1', '4294967294', '4294967295', '4294967296', '01', '-1', '1.5']) {
  test(`object-array boundary rejects key ${key} without inspection`, async () => {
    const keys = []; Object.defineProperty(keys, key, { configurable: true, enumerable: true, value: 'profile.name', writable: true });
    let transportCalls = 0;
    const client = makeClient(async () => { transportCalls += 1; return reply(recall()); });
    await assert.rejects(client.recall({ scope: USER, query: 'safe', keys }), ValidationFailureError);
    assert.equal(transportCalls, 0);
  });
}

test('inert JSON arrays preserve standard indices zero and one', async () => {
  const client = makeClient(async () => reply(recall()));
  assert.deepEqual(await client.recall(requestJson({ scope: USER, query: 'safe', keys: ['profile.name', 'profile.role'] })), recall());
});

for (const name of ['recall-scope-mismatch', 'receipt-version-mismatch']) {
  test(`rejects frozen malformed recall fixture ${name}`, async () => {
    const client = makeClient(async () => reply(fixture(`negative/${name}`)));
    await assert.rejects(client.recall(requestJson({ scope: USER, query: 'x' })), MalformedResponseError);
  });
}
for (const name of ['proposal-create-wrong-result-version', 'proposal-replace-wrong-result-id', 'proposal-replace-wrong-result-version', 'proposal-terminal-null-decided-at']) {
  test(`rejects frozen malformed proposal fixture ${name}`, async () => {
    const client = makeClient(async () => reply(fixture(`negative/${name}`)));
    await assert.rejects(client.proposalStatus(requestJson({ proposal_id: 'proposal_test' })), MalformedResponseError);
  });
}

test('serialization is deterministic and rejects unsupported values', () => {
  assert.equal(stableSerialize({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.throws(() => stableSerialize({ value: 1n }), ValidationFailureError);
});

test('public surface has no direct write, approval, delete, restore, resolver, or local fallback', () => {
  const prohibited = /write|approve|reject|delete|restore|resolve|local|fallback/i;
  assert.deepEqual(Object.getOwnPropertyNames(AgentMemoryClient.prototype).sort(), ['constructor', 'proposalStatus', 'propose', 'recall', 'recallCanonical']);
  assert.deepEqual(Object.keys(api).filter((name) => prohibited.test(name)), []);
  const sources = ['client.mjs', 'index.mjs', 'validation.mjs'].map((name) => readFileSync(new URL(`../../src/client/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /node:fs|localStorage|indexedDB|memory:write|memory:approve|memory:delete|memory:restore/);
});

test('attaches operation_id from memoryOperationId after AM-01 validation', async () => {
  const pending = fixture('positive/proposal-pending');
  const opId = `memory-${'cd'.repeat(16)}`;
  const client = makeClient(async () => reply(pending, 202, { memoryOperationId: opId }));
  const result = await client.propose(requestJson(fixture('positive/create-request')));
  assert.equal(result.operation_id, opId);
  assert.equal(result.id, pending.id);
  assert.equal(result.status, pending.status);
});

test('ignores malformed memoryOperationId and keeps frozen AM-01 body', async () => {
  const pending = fixture('positive/proposal-pending');
  const client = makeClient(async () => reply(pending, 202, { memoryOperationId: 'not-a-memory-op' }));
  const result = await client.propose(requestJson(fixture('positive/create-request')));
  assert.equal('operation_id' in result, false);
  assert.deepEqual({ ...result }, pending);
});
