import { ValidationFailureError } from './errors.mjs';

function inertRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = Object.create(null);
  for (const key of Object.keys(value)) record[key] = value[key];
  return record;
}

export function parseRequestJson(value, label, maxBytes) {
  if (typeof value !== 'string') {
    throw new ValidationFailureError(`${label} must be supplied as primitive JSON text; caller objects are not accepted.`);
  }
  if (Buffer.byteLength(value) > maxBytes) throw new ValidationFailureError(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  try {
    return JSON.parse(value, (_key, child) => inertRecord(child));
  } catch {
    throw new ValidationFailureError(`${label} must be valid JSON text.`);
  }
}

function serialize(value, seen, inArray = false) {
  if (value === null) return 'null';
  if (value === undefined) return inArray ? 'null' : undefined;
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationFailureError('Requests cannot contain non-finite numbers.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new ValidationFailureError(`Requests cannot contain ${typeof value} values.`);
  if (seen.has(value)) throw new ValidationFailureError('Requests cannot contain circular values.');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => serialize(item, seen, true)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ValidationFailureError('Requests may contain only plain objects and arrays.');
    const entries = Object.keys(value).sort().flatMap((key) => {
      const encoded = serialize(value[key], seen, false);
      return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
    });
    result = `{${entries.join(',')}}`;
  }
  seen.delete(value);
  return result;
}

export function stableSerialize(value) {
  const serialized = serialize(value, new Set());
  if (serialized === undefined) throw new ValidationFailureError('The request body cannot be undefined.');
  return serialized;
}
