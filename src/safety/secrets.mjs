const PATTERNS = [
  /\b(api[_-]?key|secret|password|passwd|private[_-]?key)\b\s*[:=]\s*\S{8,}/i,
  /\bsk-(?:proj|svcacct|ant-(?:api|admin)\d+|or-v\d+)-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bxapp-[A-Za-z0-9-]{10,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bsupabase[_-]?service[_-]?role\b/i,
];

export function detectSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return PATTERNS.some((re) => re.test(text));
}

export function assertNoSecret(text) {
  if (detectSecret(text)) {
    const error = new Error('Secret or credential content is not allowed in durable Lucy memory.');
    error.code = 'secret_rejected';
    throw error;
  }
}
