import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PREFIX = '/api/lucy/agent-memory/v1';

function mint(prefix) {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(text);
}

function errorEnvelope(code, requestId, retryable = false) {
  return {
    schema_version: '1',
    request_id: requestId,
    error: { code, message: code, retryable },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createIsolatedAm01Authority({ token = 'test-token', now = () => new Date().toISOString() } = {}) {
  const proposals = new Map();
  const active = new Map();
  const idempotency = new Map();
  const approvedBy = new Map();

  function identityKey(scope, key) {
    return `${scope.kind}:${scope.id ?? ''}:${key}`;
  }

  function receipt(memory, relations = []) {
    return {
      schema_version: '1',
      id: mint('rcpt'),
      memory_id: memory.id,
      memory_version: memory.version,
      key: memory.key,
      kind: memory.kind,
      scope: memory.scope,
      lifecycle: memory.status,
      authority: { type: 'human_approved' },
      authoritative_at: memory.updated_at,
      issued_at: memory.updated_at,
      provenance: { type: 'governed_record', ref: memory.id },
      relations,
    };
  }

  function approve(proposalId) {
    const proposal = proposals.get(proposalId);
    if (!proposal) return { status: 404, body: errorEnvelope('not_found_or_not_visible', mint('req')) };
    if (proposal.status !== 'pending') return { status: 409, body: errorEnvelope('conflict', mint('req')) };
    const stamp = now();
    if (proposal.operation === 'create') {
      const ident = identityKey(proposal.requested.scope, proposal.requested.key);
      if ([...active.values()].some((row) => identityKey(row.scope, row.key) === ident && row.status === 'active')) {
        return { status: 409, body: errorEnvelope('conflict', mint('req')) };
      }
      const memory = {
        schema_version: '1',
        id: mint('mem'),
        version: 1,
        key: proposal.requested.key,
        kind: proposal.requested.kind,
        scope: proposal.requested.scope,
        content: proposal.content,
        status: 'active',
        proposal_id: proposal.id,
        updated_at: stamp,
      };
      memory.receipt = receipt(memory);
      active.set(memory.id, memory);
      approvedBy.set(memory.id, proposal.id);
      proposal.status = 'approved';
      proposal.decided_at = stamp;
      proposal.result = { memory_id: memory.id, memory_version: 1, receipt_id: memory.receipt.id };
      return { status: 200, body: proposal };
    }
    const live = active.get(proposal.requested.memory_id);
    if (!live || live.status !== 'active') return { status: 404, body: errorEnvelope('not_found_or_not_visible', mint('req')) };
    if (live.version !== proposal.requested.expected_version) return { status: 409, body: errorEnvelope('version_conflict', mint('req')) };
    if (live.key !== proposal.requested.key || live.kind !== proposal.requested.kind) {
      return { status: 409, body: errorEnvelope('conflict', mint('req')) };
    }
    live.status = 'superseded';
    const successor = {
      schema_version: '1',
      id: live.id,
      version: live.version + 1,
      key: live.key,
      kind: live.kind,
      scope: live.scope,
      content: proposal.content,
      status: 'active',
      proposal_id: proposal.id,
      updated_at: stamp,
    };
    successor.receipt = receipt(successor, [{ type: 'supersedes', memory_id: live.id, memory_version: live.version }]);
    active.set(successor.id, successor);
    approvedBy.set(successor.id, proposal.id);
    proposal.status = 'approved';
    proposal.decided_at = stamp;
    proposal.result = { memory_id: successor.id, memory_version: successor.version, receipt_id: successor.receipt.id };
    return { status: 200, body: proposal };
  }

  async function handle(req, res) {
    const requestId = mint('req');
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${token}`) {
      send(res, 401, errorEnvelope('unauthenticated', requestId));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === `${PREFIX}/recall`) {
      const body = JSON.parse((await readBody(req)) || '{}');
      const canonical = req.headers['x-lucy-memory-projection'] === 'canonical-v1';
      const rows = [...active.values()].filter((row) => {
        if (row.status !== 'active') return false;
        if (body.scope?.kind && row.scope.kind !== body.scope.kind) return false;
        if (body.scope?.id && row.scope.id !== body.scope.id) return false;
        if (Array.isArray(body.keys) && body.keys.length && !body.keys.includes(row.key)) return false;
        if (Array.isArray(body.kinds) && body.kinds.length && !body.kinds.includes(row.kind)) return false;
        return true;
      }).slice(0, body.limit ?? 3);
      const results = canonical ? rows.map((row) => ({
        record_id: row.id,
        key: row.key,
        kind: row.kind,
        scope: row.scope,
        content: row.content,
        status: 'active',
        persisted: true,
        approval_status: 'approved',
        version: row.version,
        provenance: {
          type: 'lucy_canonical',
          record_id: row.id,
          proposal_id: approvedBy.get(row.id),
          canonical_payload_hash: null,
          written_at: row.updated_at,
        },
      })) : rows.map((row) => ({
        schema_version: row.schema_version,
        id: row.id,
        version: row.version,
        key: row.key,
        kind: row.kind,
        scope: row.scope,
        content: row.content,
        status: row.status,
        receipt: row.receipt,
      }));
      send(res, 200, canonical ? {
        schema_version: 'canonical-recall-1',
        request_id: requestId,
        as_of: now(),
        consistency: 'canonical_active',
        scope: body.scope,
        results,
        notices: [],
      } : {
        schema_version: '1',
        request_id: requestId,
        as_of: now(),
        consistency: 'canonical_active',
        scope: body.scope,
        results,
        notices: [],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === `${PREFIX}/proposals`) {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const headerKey = req.headers['idempotency-key'];
      if (headerKey && idempotency.has(headerKey)) {
        const prior = idempotency.get(headerKey);
        if (prior.raw !== raw) {
          send(res, 409, errorEnvelope('conflict', requestId));
          return;
        }
        send(res, 200, prior.proposal);
        return;
      }
      const proposal = {
        schema_version: '1',
        id: mint('proposal'),
        proposal_version: 1,
        operation: body.operation,
        status: 'pending',
        requested: {
          memory_id: body.memory_id,
          expected_version: body.expected_version,
          key: body.key,
          kind: body.kind ?? active.get(body.memory_id)?.kind,
          scope: body.scope,
        },
        relations: [],
        created_at: now(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        decided_at: null,
        result: null,
        content: body.content,
      };
      proposals.set(proposal.id, proposal);
      const publicProposal = { ...proposal };
      delete publicProposal.content;
      if (headerKey) idempotency.set(headerKey, { raw, proposal: { ...publicProposal } });
      send(res, 200, publicProposal);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith(`${PREFIX}/proposals/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${PREFIX}/proposals/`.length));
      const proposal = proposals.get(id);
      if (!proposal) {
        send(res, 404, errorEnvelope('not_found_or_not_visible', requestId));
        return;
      }
      const publicProposal = { ...proposal };
      delete publicProposal.content;
      send(res, 200, publicProposal);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__test/approve') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const result = approve(body.proposal_id);
      send(res, result.status, result.body);
      return;
    }
    send(res, 400, errorEnvelope('invalid_request', requestId));
  }

  return { handle, approve };
}

export async function listenIsolatedAm01(options = {}) {
  const authority = createIsolatedAm01Authority(options);
  const server = createServer((req, res) => {
    authority.handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 503, errorEnvelope('service_unavailable', mint('req'), true));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token: options.token ?? 'test-token',
    approve: authority.approve,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
