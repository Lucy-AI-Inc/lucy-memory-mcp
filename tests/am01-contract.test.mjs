import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  CONTRACT_PATH,
  EXPECTED_CONTRACT_VERSION,
  EXPECTED_SCHEMA_VERSION,
  ROOT,
  SCHEMA_BASE,
  compilePublicSchemas,
  isExpectedVersionSuccessor,
  loadContract,
  loadFixtureManifest,
  validateFixture,
  verifyFrozenContract,
  verifyHashes,
} from "../scripts/lib/am01.mjs";

test("frozen contract exposes only the approved v0.1 surface", async () => {
  const contract = await loadContract();
  assert.equal(CONTRACT_PATH, "contracts/agent-memory-api.contract.json");
  assert.equal(contract.contract_version, EXPECTED_CONTRACT_VERSION);
  assert.equal(contract.public_schema_version, EXPECTED_SCHEMA_VERSION);
  assert.deepEqual(contract.memory_kinds, ["fact", "preference", "decision", "rule"]);
  assert.deepEqual(contract.scope_kinds, ["user", "workspace", "project"]);
  assert.deepEqual(contract.public_permissions, ["memory:read", "memory:propose"]);
  assert.deepEqual(contract.mcp_tools, [
    "memory_recall",
    "memory_propose",
    "memory_proposal_status",
  ]);
  assert.deepEqual(contract.proposal_lifecycle, [
    "pending",
    "approved",
    "rejected",
    "expired",
    "superseded",
  ]);
  assert.deepEqual(contract.memory_lifecycle, [
    "active",
    "superseded",
    "revoked",
    "forgotten",
  ]);
  assert.equal(contract.proposal_version, 1);
  assert.equal(contract.identity.account_source, "server-derived");
  assert.equal(contract.identity.tenant_source, "server-derived");
  assert.equal(contract.identity.client_may_supply_account, false);
  assert.equal(contract.identity.client_may_supply_tenant, false);
  assert.equal(contract.replace.expected_version_maximum, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(contract.replace.maximum_memory_version, Number.MAX_SAFE_INTEGER);
  await verifyFrozenContract(contract);
});

test("version schemas make expected_version + 1 safe at the upper boundary", async () => {
  const common = JSON.parse(await readFile(path.join(ROOT, "schemas/v1/common.schema.json"), "utf8"));
  const replace = JSON.parse(await readFile(path.join(ROOT, "schemas/v1/replace-proposal-request.schema.json"), "utf8"));

  assert.equal(common.$defs.version.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(common.$defs.expectedVersion.maximum, Number.MAX_SAFE_INTEGER - 1);
  assert.equal(
    replace.properties.expected_version.$ref,
    "https://schemas.trylucy.ai/agent-memory/v1/common.schema.json#/$defs/expectedVersion",
  );
  assert.equal(
    isExpectedVersionSuccessor(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER),
    true,
  );
  assert.equal(isExpectedVersionSuccessor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), false);
  assert.equal(
    isExpectedVersionSuccessor(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1),
    false,
  );
});

test("fixture manifest covers every required AM-01 contract case", async () => {
  const manifest = await loadFixtureManifest();
  const ids = new Set(manifest.cases.map((fixture) => fixture.id));
  const required = [
    "scope-user",
    "scope-workspace",
    "scope-project",
    "create-request",
    "replace-request",
    "proposal-pending",
    "proposal-approved",
    "proposal-create-approved",
    "proposal-rejected",
    "proposal-expired",
    "proposal-superseded",
    "proposal-rejected-with-result",
    "proposal-expired-with-result",
    "proposal-superseded-with-result",
    "proposal-terminal-null-decided-at",
    "proposal-create-wrong-result-version",
    "proposal-replace-wrong-result-id",
    "proposal-replace-wrong-result-version",
    "memory-active",
    "memory-state-active",
    "memory-state-superseded",
    "memory-state-revoked",
    "memory-state-forgotten",
    "receipt-active",
    "receipt-superseded",
    "receipt-revoked",
    "receipt-forgotten",
    "receipt-superseding",
    "recall-scope-mismatch",
    "replace-scope-order-insensitive",
    "error-unauthenticated",
    "error-forbidden",
    "error-not-found-or-not-visible",
    "error-invalid-scope",
    "error-invalid-request",
    "error-unsupported-version",
    "error-conflict",
    "error-version-conflict",
    "error-rate-limited",
    "error-payload-too-large",
    "error-service-unavailable",
    "unknown-memory-kind",
    "missing-scope",
    "invalid-scope",
    "client-supplied-tenant",
    "invalid-key",
    "oversized-key",
    "create-with-memory-id",
    "create-with-expected-version",
    "replace-missing-memory-id",
    "replace-missing-expected-version",
    "replace-change-key",
    "replace-change-scope",
    "replace-change-kind",
    "invalid-proposal-lifecycle",
    "invalid-memory-lifecycle",
    "invalid-proposal-version",
    "malformed-receipt",
    "malformed-provenance",
    "replace-transition-receipt-version-mismatch",
    "receipt-version-mismatch",
    "receipt-key-mismatch",
    "unknown-authority-type",
    "unknown-schema-version",
    "unknown-contract-version",
    "oversized-content",
    "oversized-justification",
    "invalid-idempotency-key",
    "forbidden-resolver-tool",
    "forbidden-approval-tool",
    "forbidden-memory-write-permission"
  ];
  assert.deepEqual(required.filter((id) => !ids.has(id)), []);
});

test("fixture manifest is closed-world and has precise negative expectations", async () => {
  const manifest = await loadFixtureManifest();
  const ids = manifest.cases.map(({ id }) => id);
  const files = manifest.cases.map(({ file }) => file);
  assert.equal(new Set(ids).size, ids.length, "fixture IDs must be unique");
  assert.equal(new Set(files).size, files.length, "fixture files must be unique");

  const fixtureRoot = path.join(ROOT, "fixtures/v1");
  const diskFiles = (await readdir(fixtureRoot, { recursive: true }))
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .map((name) => path.posix.join("fixtures/v1", name.split(path.sep).join("/")))
    .sort();
  assert.deepEqual([...files].sort(), diskFiles, "every fixture file must appear exactly once");

  const clientTenant = manifest.cases.find(({ id }) => id === "client-supplied-tenant");
  assert.deepEqual(clientTenant.expected_error, {
    instance_path: "/scope",
    keyword: "additionalProperties",
    params: { additionalProperty: "tenant_id" },
  });

  for (const fixture of manifest.cases.filter(({ valid }) => !valid)) {
    assert.equal(typeof fixture.expected_error?.keyword, "string", `${fixture.id}: missing expected_error.keyword`);
    assert.equal(typeof fixture.expected_error?.instance_path, "string", `${fixture.id}: missing expected_error.instance_path`);
    assert.equal(typeof fixture.expected_error?.params, "object", `${fixture.id}: missing expected_error.params`);
  }
});

test("all public schemas compile under JSON Schema 2020-12", async () => {
  const registry = await compilePublicSchemas();
  assert.ok(registry.paths.every((schemaPath) => !schemaPath.includes("\\")));
  assert.deepEqual(
    registry.paths.map((schemaPath) => schemaPath.split("/").at(-1)),
    [
      "common.schema.json",
      "contract-document.schema.json",
      "create-proposal-request.schema.json",
      "error.schema.json",
      "memory-version-state.schema.json",
      "memory.schema.json",
      "proposal-status.schema.json",
      "public-surface.schema.json",
      "recall-request.schema.json",
      "recall-response.schema.json",
      "receipt.schema.json",
      "replace-proposal-request.schema.json",
      "replace-transition.schema.json",
      "scope.schema.json"
    ]
  );
});

test("public error responses reject undeclared nested detail data", async () => {
  const registry = await compilePublicSchemas();
  const validate = registry.ajv.getSchema(`${SCHEMA_BASE}error.schema.json`);
  assert.ok(validate);
  const accepted = validate({
    schema_version: "1",
    request_id: "req_closed_world",
    error: {
      code: "invalid_request",
      message: "Invalid request.",
      retryable: false,
      details: { undeclared: { arbitrary: true } },
    },
  });
  assert.equal(accepted, false, "nested public error details must not be an open extension point");
  assert.ok(validate.errors.some(({ instancePath, keyword, params }) =>
    instancePath === "/error"
    && keyword === "additionalProperties"
    && params.additionalProperty === "details"
  ), JSON.stringify(validate.errors));
});

test("all positive fixtures validate", async () => {
  const registry = await compilePublicSchemas();
  const manifest = await loadFixtureManifest();
  const positives = manifest.cases.filter((entry) => entry.valid);
  assert.ok(positives.length >= 12);
  for (const fixture of positives) {
    const result = await validateFixture(registry, fixture);
    assert.equal(result.valid, true, `${fixture.id}: ${result.message}`);
  }
});

test("replace validation is insensitive to scope property order", async () => {
  const orderFixturePath = path.join(
    ROOT,
    "fixtures/v1/positive/replace-scope-order-insensitive.json",
  );
  const transitionFixturePath = path.join(
    ROOT,
    "fixtures/v1/positive/replace-transition.json",
  );
  const [orderFixtureRaw, transitionFixtureRaw] = await Promise.all([
    readFile(orderFixturePath, "utf8"),
    readFile(transitionFixturePath, "utf8"),
  ]);
  assert.notEqual(
    orderFixtureRaw,
    transitionFixtureRaw,
    "order-insensitivity fixture must not duplicate the ordinary transition fixture",
  );

  const orderFixture = JSON.parse(orderFixtureRaw);
  assert.deepEqual(Object.keys(orderFixture.current.scope), ["id", "kind"]);
  assert.deepEqual(Object.keys(orderFixture.proposal.scope), ["kind", "id"]);
  assert.deepEqual(orderFixture.current.scope, orderFixture.proposal.scope);

  const registry = await compilePublicSchemas();
  const manifest = await loadFixtureManifest();
  const fixture = manifest.cases.find(
    ({ id }) => id === "replace-scope-order-insensitive",
  );
  assert.ok(fixture, "replace-scope-order-insensitive fixture must be declared");
  const result = await validateFixture(registry, fixture);
  assert.equal(result.valid, true, result.message);
});

test("all negative fixtures fail for their declared reason", async () => {
  const registry = await compilePublicSchemas();
  const manifest = await loadFixtureManifest();
  const negatives = manifest.cases.filter((entry) => !entry.valid);
  assert.ok(negatives.length >= 26);
  for (const fixture of negatives) {
    const result = await validateFixture(registry, fixture);
    assert.equal(result.valid, false, `${fixture.id} unexpectedly validated`);
    assert.ok(result.errors.some((error) =>
      error.keyword === fixture.expected_error.keyword
      && error.instancePath === fixture.expected_error.instance_path
      && isDeepStrictEqual(error.params ?? {}, fixture.expected_error.params)
    ), `${fixture.id}: expected ${JSON.stringify(fixture.expected_error)}, received ${JSON.stringify(result.errors)}`);
  }
});

test("committed contract and schema hashes verify", async () => {
  const result = await verifyHashes();
  assert.equal(result.valid, true, result.message);
});
