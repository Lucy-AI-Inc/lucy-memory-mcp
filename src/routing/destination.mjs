import { detectSecret } from '../safety/secrets.mjs';

export const DESTINATIONS = Object.freeze(['lucy', 'local', 'session', 'reject']);

const RECALL_POSITIVE = [
  [/remember|recall|what did we (decide|agree)/i, 'explicit_recall'],
  [/prefer(ence|red)?|my name|who am i/i, 'identity_or_preference'],
  [/project rule|operating rule|decision|we decided/i, 'prior_decision'],
  [/stale|conflict|lucy says|local memory/i, 'possible_stale_local'],
];

const RECALL_NEGATIVE = [
  [/what is \d|2\s*\+\s*2|calculate|syntax/i, 'arithmetic_or_syntax'],
  [/weather|news|headline/i, 'current_events'],
  [/draft|rewrite|translate this/i, 'one_shot_draft'],
];

export function classifyPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  for (const [re, reason] of RECALL_NEGATIVE) {
    if (re.test(text)) {
      return { destination: 'session', shouldRecall: false, reason, kind: null, scopeHint: null, approvalRequired: false, sensitivity: 'none' };
    }
  }
  for (const [re, reason] of RECALL_POSITIVE) {
    if (re.test(text)) {
      return { destination: 'lucy', shouldRecall: true, reason, kind: reason.includes('prefer') ? 'preference' : 'fact', scopeHint: 'user', approvalRequired: false, sensitivity: 'normal' };
    }
  }
  return { destination: 'session', shouldRecall: false, reason: 'unrelated', kind: null, scopeHint: null, approvalRequired: false, sensitivity: 'none' };
}

export function classifyOutbound({ content, durable = false, temporary = false, secret = false, kind = 'fact', scope = { kind: 'user' } } = {}) {
  const text = typeof content === 'string' ? content : '';
  if (secret || detectSecret(text)) {
    return { destination: 'reject', shouldPropose: false, reason: 'secret_rejected', kind, scope, approvalRequired: true, sensitivity: 'secret' };
  }
  if (temporary || !durable) {
    return { destination: 'session', shouldPropose: false, reason: 'temporary_or_not_durable', kind, scope, approvalRequired: false, sensitivity: 'none' };
  }
  return { destination: 'lucy', shouldPropose: true, reason: 'durable_candidate', kind, scope, approvalRequired: true, sensitivity: 'normal' };
}
