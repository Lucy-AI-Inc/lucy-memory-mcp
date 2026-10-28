import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { compilePublicSchemas, loadFixtureManifest, validateFixture } from "./lib/am01.mjs";
const registry = await compilePublicSchemas();
const manifest = await loadFixtureManifest();
for (const fixture of manifest.cases) {
  const result = await validateFixture(registry, fixture);
  if (fixture.valid) assert.equal(result.valid, true, `${fixture.id}: ${result.message}`);
  else {
    assert.equal(result.valid, false, `${fixture.id} unexpectedly validated`);
    assert.ok(result.errors.some((error) =>
      error.keyword === fixture.expected_error.keyword
      && error.instancePath === fixture.expected_error.instance_path
      && isDeepStrictEqual(error.params ?? {}, fixture.expected_error.params)
    ), `${fixture.id}: expected ${JSON.stringify(fixture.expected_error)}, got ${JSON.stringify(result.errors)}`);
  }
}
console.log(`schemas: PASS compiled=${registry.schemaCount} fixtures=${manifest.cases.length}`);
