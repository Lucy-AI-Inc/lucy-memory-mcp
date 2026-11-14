import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'contracts/agent-manifest.json'), 'utf8'));
export const LUCY_USAGE_SKILL = readFileSync(join(root, '.github/skills/lucy-memory-first/SKILL.md'), 'utf8');

export function usageSkillText() {
  return LUCY_USAGE_SKILL;
}

export function publicManifest() {
  return manifest;
}
