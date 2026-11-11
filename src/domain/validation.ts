import { HttpError, NewBooking, Slot } from './types';

// Practical email check: something@something.tld, no spaces, one @.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requiredString(body: Record<string, unknown>, field: string, maxLen: number): string {
  const raw = body[field];
  if (raw === undefined || raw === null) throw new HttpError(400, `${field} is required`);
  if (typeof raw !== 'string') throw new HttpError(400, `${field} must be a string`);
  const value = raw.trim();
  if (value === '') throw new HttpError(400, `${field} must not be empty`);
  if (value.length > maxLen) throw new HttpError(400, `${field} must be at most ${maxLen} characters`);
  return value;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Email used as the rate-limit key: whatever was sent, normalised, even if invalid. */
export function rateLimitEmail(body: unknown): string | null {
  if (!isPlainObject(body) || typeof body.email !== 'string') return null;
  const email = normalizeEmail(body.email);
  return email === '' ? null : email;
}

export function parseNewBooking(body: unknown): NewBooking {
  if (!isPlainObject(body)) throw new HttpError(400, 'request body must be a JSON object');
  const slot_id = requiredString(body, 'slot_id', 200);
  const name = requiredString(body, 'name', 200);
  const email = normalizeEmail(requiredString(body, 'email', 254));
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email is not valid');
  return { slot_id, name, email };
}

function isValidDate(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

export function parseResetBody(body: unknown): Slot[] {
  if (!isPlainObject(body) || !Array.isArray(body.slots)) {
    throw new HttpError(400, 'slots must be an array');
  }
  const seen = new Set<string>();
  return body.slots.map((item, i) => {
    if (!isPlainObject(item)) throw new HttpError(400, `slots[${i}] must be an object`);
    const slot: Slot = {
      id: requiredString(item, 'id', 200),
      provider: requiredString(item, 'provider', 200),
      start: requiredString(item, 'start', 100),
      end: requiredString(item, 'end', 100),
    };
    if (!isValidDate(slot.start)) throw new HttpError(400, `slots[${i}].start is not a valid date-time`);
    if (!isValidDate(slot.end)) throw new HttpError(400, `slots[${i}].end is not a valid date-time`);
    if (seen.has(slot.id)) throw new HttpError(400, `duplicate slot id: ${slot.id}`);
    seen.add(slot.id);
    return slot;
  });
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return 10;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new HttpError(400, 'limit must be an integer from 1 to 50');
  }
  const n = Number(raw);
  if (n < 1 || n > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  return n;
}

export function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
}

export function decodeCursor(raw: unknown): string | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'cursor is not valid');
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (isPlainObject(parsed) && typeof parsed.s === 'string' && /^\d{1,19}$/.test(parsed.s)) {
      return parsed.s;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'cursor is not valid');
}
