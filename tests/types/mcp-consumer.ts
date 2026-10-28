import { AgentMemoryClient, createLucyHttpTransport, type AgentMemoryTransport, type CanonicalRecallResponse } from '@trylucy/agent-memory';
import type { Server } from '@modelcontextprotocol/server';
import { createLucyMemoryMcpServer, LUCY_MEMORY_TOOL_NAMES, type LucyMemoryMcpServerOptions, type LucyMemoryToolName } from '@trylucy/agent-memory/mcp';
import { startLucyMemoryMcpStdio, type LucyMemoryStdioRuntime } from '@trylucy/agent-memory/mcp/stdio';
import {
  installHermesLucyConfig,
  lucyMcpConfig,
  resetHermesLucyArtifacts,
  resetHermesLucyBackup,
  uninstallHermesLucyConfig,
  type HermesLucyInstallOptions,
} from '@trylucy/agent-memory/hermes';

const transport: AgentMemoryTransport = createLucyHttpTransport({ baseUrl: 'https://www.trylucy.ai' });
const client = new AgentMemoryClient({ transport, token: 'compile-only-token', permissions: ['memory:read', 'memory:propose'] });
const canonical: Promise<CanonicalRecallResponse> = client.recallCanonical(JSON.stringify({ query: 'name', scope: { kind: 'user' } }));
const options: LucyMemoryMcpServerOptions = { client };
const server: Promise<Server> = createLucyMemoryMcpServer(options);
const tool: LucyMemoryToolName = LUCY_MEMORY_TOOL_NAMES[0];
const runtime: Promise<LucyMemoryStdioRuntime> = startLucyMemoryMcpStdio({ client });
const hermesOptions: HermesLucyInstallOptions = {
  profilePath: '/tmp/lucy-profile',
  artifact: { sourcePath: '/tmp/lucy-memory-mcp.mjs', nodePath: '/usr/bin/node', version: '1.0.0', expectedSourceGitSha: '0123456789abcdef0123456789abcdef01234567' },
  baseUrl: 'https://www.trylucy.ai',
  tokenEnv: 'LUCY_MEMORY_TOKEN',
};
const installation = installHermesLucyConfig('/tmp/lucy-profile/config.yaml', hermesOptions);
void installation.path;
void installation.backup;
const receipt = installation.artifact;
void receipt.format;
void receipt.version;
void receipt.path;
void receipt.entrypoint;
void receipt.node_path;
void receipt.artifact_digest;
void receipt.source_git_sha;
void receipt.package_name;
void receipt.package_version;
void receipt.source_repository;
void receipt.source_git_closure_digest;
void receipt.dependency_provenance.type;
void receipt.dependency_provenance.lockfile;
void receipt.dependency_provenance.lockfile_sha256;
void receipt.dependency_provenance.closure_digest;
void receipt.dependency_provenance.npm_cli_version;
void receipt.compatibility.node.required_range;
void receipt.compatibility.node.verified_version;
void receipt.compatibility.hermes?.required_range;
void receipt.compatibility.hermes?.verified_host_version;
void receipt.created_at;
void receipt.receiptPath;
const generatedMcpConfig = lucyMcpConfig({ ...hermesOptions, artifact: receipt });
void generatedMcpConfig.command;
void generatedMcpConfig.args;
void generatedMcpConfig.env;
void generatedMcpConfig.x_lucy_memory_artifact.version;
void generatedMcpConfig.x_lucy_memory_artifact.artifact_digest;
void generatedMcpConfig.x_lucy_memory_artifact.source_git_sha;
void generatedMcpConfig.x_lucy_memory_artifact.package_name;
void generatedMcpConfig.x_lucy_memory_artifact.package_version;
void generatedMcpConfig.x_lucy_memory_artifact.source_repository;
void generatedMcpConfig.x_lucy_memory_artifact.compatibility.node.required_range;
void generatedMcpConfig.x_lucy_memory_artifact.receipt_path;
void uninstallHermesLucyConfig('/tmp/lucy-profile/config.yaml', { profilePath: hermesOptions.profilePath });
void resetHermesLucyBackup('/tmp/lucy-profile/config.yaml', { profilePath: hermesOptions.profilePath });
void resetHermesLucyArtifacts('/tmp/lucy-profile/config.yaml', { profilePath: hermesOptions.profilePath });
void server; void tool; void runtime;
