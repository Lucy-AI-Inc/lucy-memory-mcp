import { randomBytes } from 'node:crypto';
import { AgentMemoryClient } from '../../src/client/client.mjs';
import { createLucyMemoryMcpServer } from '../../src/mcp/server.mjs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

function opaque(prefix) {
  return `${prefix}_${randomBytes(18).toString('hex')}`;
}

function result(body, status = 200) {
  return {
    status,
    byteLength: Buffer.byteLength(JSON.stringify(body)),
    body,
  };
}

function error(code, status) {
  return result({
    schema_version: '1',
    request_id: opaque('req'),
    error: { code, message: code, retryable: false },
  }, status);
}

export async function createLocalTarget({ audience, workspaces, now = () => Date.now() }) {
  const access = new Map();
  const refresh = new Map();
  const stores = new Map(workspaces.map((workspace) => [workspace, {
    proposals: new Map(),
    active: new Map(),
    serviceToken: opaque('svc'),
  }]));
  const sessions = new Map();
  const logs = [];
  const upstreamAuthorization = [];
  let dependencyAvailable = true;

  function issueAccess(workspace, tokenAudience = audience, ttlSeconds = 300) {
    const token = opaque('access');
    access.set(token, { workspace, audience: tokenAudience, expiresAt: now() + ttlSeconds * 1000, revoked: false });
    return token;
  }

  function issueRefresh(workspace) {
    const token = opaque('refresh');
    refresh.set(token, { workspace, revoked: false });
    return token;
  }

  function authenticate(token) {
    const grant = access.get(token);
    if (!grant || grant.revoked || grant.audience !== audience || grant.expiresAt <= now()) {
      logs.push({ event: 'authentication_failure', authorization: `Bearer ${token}` });
      throw new Error('unauthenticated');
    }
    return grant.workspace;
  }

  function rotateRefresh(token) {
    const grant = refresh.get(token);
    if (!grant || grant.revoked) throw new Error('invalid_grant');
    grant.revoked = true;
    return { refreshToken: issueRefresh(grant.workspace), accessToken: issueAccess(grant.workspace) };
  }

  function mintWithRefresh(token) {
    const grant = refresh.get(token);
    if (!grant || grant.revoked) throw new Error('invalid_grant');
    return issueAccess(grant.workspace);
  }

  function revokeRefresh(token) {
    const grant = refresh.get(token);
    if (grant) grant.revoked = true;
  }

  async function transportFor(workspace, request) {
    if (!dependencyAvailable) throw new Error('dependency unavailable');
    const store = stores.get(workspace);
    upstreamAuthorization.push(`Bearer ${request.accessToken}`);
    if (request.accessToken !== store.serviceToken) return error('unauthenticated', 401);
    const body = JSON.parse(request.payload || '{}');
    if (request.operation === 'canonical-recall') {
      const rows = [...store.active.values()]
        .filter((memory) => (!body.keys?.length || body.keys.includes(memory.key)))
        .map((memory) => ({
          record_id: memory.id,
          key: memory.key,
          kind: memory.kind,
          scope: memory.scope,
          content: memory.content,
          status: 'active',
          persisted: true,
          approval_status: 'approved',
          version: 1,
          provenance: {
            type: 'lucy_canonical',
            record_id: memory.id,
            proposal_id: memory.proposalId,
            canonical_payload_hash: null,
            written_at: new Date(now()).toISOString(),
          },
        }));
      return result({
        schema_version: 'canonical-recall-1',
        request_id: opaque('req'),
        as_of: new Date(now()).toISOString(),
        consistency: 'canonical_active',
        scope: body.scope,
        results: rows,
        notices: [],
      });
    }
    if (request.operation === 'propose') {
      const proposal = {
        schema_version: '1',
        id: opaque('proposal'),
        proposal_version: 1,
        operation: body.operation,
        status: 'pending',
        requested: {
          key: body.key,
          kind: body.kind,
          scope: body.scope,
        },
        relations: [],
        created_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + 86_400_000).toISOString(),
        decided_at: null,
        result: null,
      };
      store.proposals.set(proposal.id, { ...proposal, content: body.content });
      return result(proposal);
    }
    if (request.operation === 'proposal-status') {
      const proposal = store.proposals.get(body.proposal_id);
      return proposal ? result(proposal) : error('not_found_or_not_visible', 404);
    }
    return error('invalid_request', 400);
  }

  async function session(workspace) {
    if (sessions.has(workspace)) return sessions.get(workspace);
    const store = stores.get(workspace);
    const client = new AgentMemoryClient({
      transport: (request) => transportFor(workspace, request),
      token: store.serviceToken,
      permissions: ['memory:read', 'memory:propose'],
    });
    const server = await createLucyMemoryMcpServer({ client });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'luc-1077-local-target', version: '1.0.0' });
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const value = { mcp, server };
    sessions.set(workspace, value);
    return value;
  }

  async function call(token, name, args) {
    const workspace = authenticate(token);
    const { mcp } = await session(workspace);
    return mcp.callTool({ name, arguments: args });
  }

  async function listTools(token) {
    const workspace = authenticate(token);
    const { mcp } = await session(workspace);
    return mcp.listTools();
  }

  function approve(workspace, proposalId) {
    const store = stores.get(workspace);
    const proposal = store.proposals.get(proposalId);
    if (!proposal) return false;
    proposal.status = 'approved';
    const memory = {
      id: opaque('mem'),
      proposalId,
      key: proposal.requested.key,
      kind: proposal.requested.kind,
      scope: proposal.requested.scope,
      content: proposal.content,
    };
    store.active.set(memory.id, memory);
    return true;
  }

  return {
    issueAccess,
    issueRefresh,
    mintWithRefresh,
    rotateRefresh,
    revokeRefresh,
    call,
    listTools,
    approve,
    logs,
    upstreamAuthorization,
    setDependencyAvailable(value) { dependencyAvailable = value; },
    async close() {
      await Promise.all([...sessions.values()].map(async ({ mcp, server }) => {
        await mcp.close();
        await server.close();
      }));
    },
  };
}
