import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'contracts/agent-manifest.json'), 'utf8'));
let usageSkill = '';
try {
  usageSkill = readFileSync(join(root, '.github/skills/lucy-memory-first/SKILL.md'), 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
export const LUCY_USAGE_SKILL = usageSkill;

export function usageSkillText() {
  return LUCY_USAGE_SKILL;
}

export function publicManifest() {
  return manifest;
}
