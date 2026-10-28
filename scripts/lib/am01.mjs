import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CONTRACT_PATH = "contracts/agent-memory-api.contract.json";
export const EXPECTED_CONTRACT_VERSION = "2026-08-09";
export const EXPECTED_SCHEMA_VERSION = "1";
export const SCHEMA_BASE = "https://schemas.trylucy.ai/agent-memory/v1/";

export async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}
export async function loadContract() { return loadJson(CONTRACT_PATH); }
export async function loadFixtureManifest() { return loadJson("fixtures/v1/manifest.json"); }
async function filesUnder(relativeDir, suffix) {
  const dir = path.join(ROOT, relativeDir);
  const names = await readdir(dir, { recursive: true });
  return names
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.split(path.sep).join("/"))
    .sort()
    .map((name) => path.posix.join(relativeDir, name));
}
export async function compilePublicSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);
  const paths = await filesUnder("schemas/v1", ".schema.json");
  const schemas = await Promise.all(paths.map(loadJson));
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) ajv.getSchema(schema.$id);
  return { ajv, schemaCount: schemas.length, paths };
}
function scopesEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.id === right.id;
}
function semanticError(keyword, instancePath) {
  return { instancePath, keyword, schemaPath: `#/semantic/${keyword}` };
}
export function isExpectedVersionSuccessor(expectedVersion, memoryVersion) {
  return Number.isSafeInteger(expectedVersion)
    && expectedVersion >= 1
    && expectedVersion < Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(memoryVersion)
    && memoryVersion === Number(BigInt(expectedVersion) + 1n);
}
function memoryReceiptErrors(value, basePath = "") {
  if (!value?.receipt) return [];
  const checks = [
    ["receiptMemoryId", `${basePath}/receipt/memory_id`, value.id === value.receipt.memory_id],
    ["receiptVersion", `${basePath}/receipt/memory_version`, value.version === value.receipt.memory_version],
    ["receiptKey", `${basePath}/receipt/key`, value.key === value.receipt.key],
    ["receiptKind", `${basePath}/receipt/kind`, value.kind === value.receipt.kind],
    ["receiptScope", `${basePath}/receipt/scope`, scopesEqual(value.scope, value.receipt.scope)],
    ["receiptLifecycle", `${basePath}/receipt/lifecycle`, value.status === value.receipt.lifecycle]
  ];
  return checks.filter(([, , valid]) => !valid).map(([keyword, instancePath]) => semanticError(keyword, instancePath));
}
function proposalStatusErrors(value) {
  if (value.status !== "approved" || !value.result) return [];
  const errors = [];
  if (value.operation === "create" && value.result.memory_version !== 1) {
    errors.push(semanticError("proposalResultVersion", "/result/memory_version"));
  }
  if (value.operation === "replace") {
    if (value.result.memory_id !== value.requested.memory_id) {
      errors.push(semanticError("proposalResultMemoryId", "/result/memory_id"));
    }
    if (!isExpectedVersionSuccessor(value.requested.expected_version, value.result.memory_version)) {
      errors.push(semanticError("proposalResultVersion", "/result/memory_version"));
    }
  }
  return errors;
}
function semanticErrors(schemaId, value) {
  if (schemaId === `${SCHEMA_BASE}memory.schema.json`) return memoryReceiptErrors(value);
  if (schemaId === `${SCHEMA_BASE}proposal-status.schema.json`) return proposalStatusErrors(value);
  if (schemaId === `${SCHEMA_BASE}recall-response.schema.json`) {
    return (value.results ?? []).flatMap((memory, index) => [
      ...memoryReceiptErrors(memory, `/results/${index}`),
      ...(scopesEqual(value.scope, memory.scope)
        ? []
        : [semanticError("recallScope", `/results/${index}/scope`)])
    ]);
  }
  if (schemaId !== `${SCHEMA_BASE}replace-transition.schema.json`) return [];
  const errors = [...memoryReceiptErrors(value.current, "/current")];
  if (value.current.id !== value.proposal.memory_id) errors.push(semanticError("stableMemoryId", "/proposal/memory_id"));
  if (value.current.version !== value.proposal.expected_version) errors.push(semanticError("expectedVersion", "/proposal/expected_version"));
  if (value.current.key !== value.proposal.key) errors.push(semanticError("stableKey", "/proposal/key"));
  if (!scopesEqual(value.current.scope, value.proposal.scope)) errors.push(semanticError("stableScope", "/proposal/scope"));
  return errors;
}
export async function validateFixture(registry, fixture) {
  const value = await loadJson(fixture.file);
  const validate = registry.ajv.getSchema(fixture.schema);
  assert.ok(validate, `unknown fixture schema: ${fixture.schema}`);
  const structural = validate(value);
  const errors = [
    ...(validate.errors ?? []).map(({ instancePath, keyword, params, schemaPath }) => ({ instancePath, keyword, params, schemaPath })),
    ...semanticErrors(fixture.schema, value)
  ];
  return {
    valid: Boolean(structural) && errors.length === 0,
    keywords: errors.map(({ keyword }) => keyword),
    errors,
    message: JSON.stringify(errors)
  };
}
export async function verifyFrozenContract(contract) {
  contract ??= await loadContract();
  assert.equal(contract.contract_version, EXPECTED_CONTRACT_VERSION);
  assert.equal(contract.public_schema_version, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(contract.public_permissions, ["memory:read", "memory:propose"]);
  assert.deepEqual(contract.mcp_tools, ["memory_recall", "memory_propose", "memory_proposal_status"]);
  assert.equal(contract.identity.account_source, "server-derived");
  assert.equal(contract.identity.tenant_source, "server-derived");
  assert.equal(contract.identity.client_may_supply_account, false);
  assert.equal(contract.identity.client_may_supply_tenant, false);
  assert.equal(contract.identity.maximum_active_per_conflict_identity, 1);
  assert.equal(contract.create.may_replace_active, false);
  assert.equal(contract.create.approved_memory_version, 1);
  assert.equal(contract.replace.retains_memory_id, true);
  assert.equal(contract.replace.expected_version_maximum, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(contract.replace.maximum_memory_version, Number.MAX_SAFE_INTEGER);
  assert.equal(contract.replace.new_version_rule, "expected_version + 1");
  assert.equal(contract.proposal.payload_immutable_after_acceptance, true);
  assert.equal(contract.proposal.proposal_supersession_distinct_from_memory_version_supersession, true);
  assert.equal(contract.recall.canonical_active_state_rejoin_required, true);
  assert.equal(contract.recall.asynchronous_index_is_not_authority, true);
  assert.equal(contract.receipts.version_specific, true);
  assert.equal(contract.receipts.authority_types.length, 1);
  assert.equal(contract.receipts.authority_types[0], "human_approved");
  assert.equal(contract.forgetting.physical_deletion_everywhere_promised, false);
  assert.ok(contract.rule_non_authorities.includes("approval authority"));
  assert.ok(contract.forbidden_public_permissions.includes("memory:write"));
  assert.ok(contract.forbidden_mcp_capabilities.includes("memory_resolve"));
  return true;
}
function digest(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
export async function currentHashes() {
  const schemaPaths = await filesUnder("schemas/v1", ".schema.json");
  const contractBytes = await readFile(path.join(ROOT, CONTRACT_PATH));
  const schemas = {};
  for (const schemaPath of schemaPaths) schemas[schemaPath] = digest(await readFile(path.join(ROOT, schemaPath)));
  return { algorithm: "sha256", contract: { path: CONTRACT_PATH, sha256: digest(contractBytes) }, schemas };
}
export async function verifyHashes() {
  const expected = await loadJson("contracts/hashes.json");
  const actual = await currentHashes();
  const valid = JSON.stringify(expected) === JSON.stringify(actual);
  return { valid, message: valid ? "hashes verified" : `hash mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}` };
}
export { ROOT };
