import { writeFile } from 'node:fs/promises';

const SECRET_KEY = /authorization|token|secret|credential|cookie/i;
const SECRET_TEXT = /(?:bearer\s+|token[_:= -]+|secret[_:= -]+|credential[_:= -]+)[^\s,;"']+/gi;

export function redactEvidence(value) {
  if (typeof value === 'string') return value.replaceAll(SECRET_TEXT, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? '[REDACTED]' : redactEvidence(entry),
    ]));
  }
  return value;
}

export function vancouverTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  const offset = part('timeZoneName')?.replace('GMT', '') || 'Z';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

export function createEvidence({ target, shas, cases, outputs = [], date = new Date() }) {
  for (const [name, sha] of Object.entries(shas)) {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`Evidence requires a pinned ${name} SHA.`);
  }
  return redactEvidence({
    schema_version: '1',
    target,
    generated_at: vancouverTimestamp(date),
    time_zone: 'America/Vancouver',
    shas,
    cases,
    outputs,
  });
}

export async function writeEvidence(path, evidence) {
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
