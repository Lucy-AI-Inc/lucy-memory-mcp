import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { currentHashes, loadJson, ROOT } from "./lib/am01.mjs";
const mode = process.argv[2];
assert.ok(["--write", "--check"].includes(mode), "usage: generate-hashes.mjs --write|--check");
const actual = await currentHashes();
const target = path.join(ROOT, "contracts/hashes.json");
if (mode === "--write") {
  await writeFile(target, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`hashes: WROTE contract=${actual.contract.sha256} schemas=${Object.keys(actual.schemas).length}`);
} else {
  const expected = await loadJson("contracts/hashes.json");
  assert.deepEqual(actual, expected);
  console.log(`hashes: PASS contract=${actual.contract.sha256} schemas=${Object.keys(actual.schemas).length}`);
}
