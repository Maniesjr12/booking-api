import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database, lockKey } from '../db';
import { ApiResult, Booking, errorResult, HttpError } from './types';
import { decodeCursor, encodeCursor, normalizeEmail, parseNewBooking, rateLimitEmail } from './validation';

const BOOKING_COLUMNS = 'seq, id, slot_id, name, email, status, created_at';

interface BookingRow {
  seq: string;
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: Booking['status'];
  created_at: Date;
}

function toBooking(r: BookingRow): Booking {
  return {
    id: r.id,
    slot_id: r.slot_id,
    name: r.name,
    email: r.email,
    status: r.status,
    created_at: r.created_at.toISOString(),
  };
}

/** Stable JSON (sorted keys) so the same body always hashes the same way. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function hashBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export interface RateLimitOptions {
  max: number;
  windowSeconds: number;
}

export interface BookingPage {
  bookings: Booking[];
  next_cursor: string | null;
}

export class BookingService {
  constructor(
    private readonly db: Database,
    private readonly rateLimit: RateLimitOptions,
  ) {}

  /**
   * Creates a booking. Everything runs in one transaction:
   *  1. Idempotency (level 4): a per-key lock serialises retries; a stored response is replayed.
   *  2. Rate limit (level 5): a per-email lock makes the attempt count exact under concurrency.
   *  3. Validation and the insert; the partial unique index rejects a second confirmed booking (level 3).
   */
  async create(body: unknown, idempotencyKey?: string): Promise<ApiResult> {
    return this.db.transaction(async (c) => {
      let requestHash: string | null = null;
      if (idempotencyKey !== undefined) {
        requestHash = hashBody(body);
        await lockKey(c, `idem:${idempotencyKey}`);
        const { rows } = await c.query(
          'SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE key = $1',
          [idempotencyKey],
        );
        if (rows[0]) {
          if (rows[0].request_hash !== requestHash) {
            return errorResult(422, 'Idempotency-Key was already used with a different request body');
          }
          return { status: rows[0].status_code, body: rows[0].response_body };
        }
      }

      const result = await this.attempt(c, body);

      // A 429 is not the request's real answer, so a retry after waiting should be processed normally.
      if (idempotencyKey !== undefined && result.status !== 429) {
        await c.query(
          `INSERT INTO idempotency_keys (key, request_hash, status_code, response_body)
           VALUES ($1, $2, $3, $4)`,
          [idempotencyKey, requestHash, result.status, JSON.stringify(result.body)],
        );
      }
      return result;
    });
  }

  private async attempt(c: PoolClient, body: unknown): Promise<ApiResult> {
    const limitEmail = rateLimitEmail(body);
    if (limitEmail !== null) {
      const retryAfter = await this.consumeAttempt(c, limitEmail);
      if (retryAfter !== null) {
        return errorResult(429, 'too many booking attempts for this email, try again later', {
          'Retry-After': String(retryAfter),
        });
      }
    }

    let input;
    try {
      input = parseNewBooking(body);
    } catch (err) {
      if (err instanceof HttpError) return errorResult(err.status, err.message);
      throw err;
    }

    const slot = await c.query('SELECT start_at <= clock_timestamp() AS started FROM slots WHERE id = $1', [
      input.slot_id,
    ]);
    if (!slot.rows[0]) return errorResult(404, 'slot not found');
    if (slot.rows[0].started) return errorResult(400, 'slot has already started');

    const inserted = await c.query<BookingRow>(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING ${BOOKING_COLUMNS}`,
      [randomUUID(), input.slot_id, input.name, input.email],
    );
    if (!inserted.rows[0]) return errorResult(409, 'slot is already booked');
    return { status: 201, body: toBooking(inserted.rows[0]) };
  }

  /** Records an attempt for this email, or returns the seconds to wait if the limit is reached. */
  private async consumeAttempt(c: PoolClient, email: string): Promise<number | null> {
    const { max, windowSeconds } = this.rateLimit;
    await lockKey(c, `rate:${email}`);
    await c.query(
      `DELETE FROM booking_attempts
        WHERE email = $1 AND attempted_at <= clock_timestamp() - make_interval(secs => $2)`,
      [email, windowSeconds],
    );
    const { rows } = await c.query(
      `SELECT count(*)::int AS n,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM
                (min(attempted_at) + make_interval(secs => $2)) - clock_timestamp())))::int AS retry_after
         FROM booking_attempts WHERE email = $1`,
      [email, windowSeconds],
    );
    if (rows[0].n >= max) return rows[0].retry_after;
    await c.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
    return null;
  }

  async get(id: string): Promise<Booking> {
    const { rows } = await this.db.pool.query<BookingRow>(`SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`, [
      id,
    ]);
    if (!rows[0]) throw new HttpError(404, 'booking not found');
    return toBooking(rows[0]);
  }

  async cancel(id: string): Promise<Booking> {
    const { rows } = await this.db.pool.query<BookingRow>(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND status = 'confirmed'
        RETURNING ${BOOKING_COLUMNS}`,
      [id],
    );
    if (rows[0]) return toBooking(rows[0]);
    await this.get(id); // throws 404 if it doesn't exist
    throw new HttpError(409, 'booking is already cancelled');
  }

  async listByEmail(rawEmail: string, limit: number, rawCursor: unknown): Promise<BookingPage> {
    const email = normalizeEmail(rawEmail);
    const after = decodeCursor(rawCursor);
    const { rows } = await this.db.pool.query<BookingRow>(
      `SELECT ${BOOKING_COLUMNS} FROM bookings
        WHERE email = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq ASC
        LIMIT $3`,
      [email, after, limit + 1],
    );
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      bookings: page.map(toBooking),
      next_cursor: hasMore ? encodeCursor(page[page.length - 1].seq) : null,
    };
  }
}
