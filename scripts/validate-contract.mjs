import assert from "node:assert/strict";
import { compilePublicSchemas, loadContract, verifyFrozenContract, SCHEMA_BASE } from "./lib/am01.mjs";
const contract = await loadContract();
await verifyFrozenContract(contract);
const registry = await compilePublicSchemas();
const validate = registry.ajv.getSchema(`${SCHEMA_BASE}contract-document.schema.json`);
assert.ok(validate(contract), JSON.stringify(validate.errors));
console.log(`contract: PASS version=${contract.contract_version} schema=${contract.public_schema_version}`);
