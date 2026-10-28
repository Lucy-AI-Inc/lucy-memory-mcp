import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../contracts/agent-manifest.json'), 'utf8'));

export const LUCY_USAGE_SKILL = `# Lucy governed memory

${manifest.sentence}

Use exactly these tools:

- memory_recall: active approved Lucy memory only
- memory_propose: request a durable write; this is not a save
- memory_proposal_status: inspect pending/approved/rejected

Do not invent a fourth tool. Do not approve, deny, forget, or restore through MCP.

Recall when a durable preference, identity fact, project decision, or explicit remember/recall request matters.
Do not recall for arithmetic, weather, news, or one-shot drafting.

Search recall practically:

- Begin with concise literal, distinctive substrings rather than a long paraphrase.
- Try spelling and spacing variants.
- Use known keys, kinds, and scopes when available.
- Broaden or narrow the query and filters iteratively.
- Do not conclude that memory is absent after one empty result.
- Distinguish a successful recall with zero matches from authentication, authorization, or service errors.

Propose only durable non-secret facts. Pending is not recallable. Wait for Lucy/human approval unless the human enabled auto memory on Lucy.

Local notes are not Lucy authority. If they conflict, Lucy wins. Never dual-write.
`;

export function usageSkillText() {
  return LUCY_USAGE_SKILL;
}

export function publicManifest() {
  return manifest;
}
