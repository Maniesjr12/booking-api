import { Pool, PoolClient } from 'pg';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_raw text NOT NULL,
  end_raw   text NOT NULL,
  start_at  timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial UNIQUE,
  id         text PRIMARY KEY,
  slot_id    text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Level 3: the database itself guarantees at most one confirmed booking per slot,
-- so simultaneous requests cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_confirmed_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  status_code   int  NOT NULL,
  response_body json  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_attempts (
  id           bigserial PRIMARY KEY,
  email        text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS booking_attempts_email_at ON booking_attempts (email, attempted_at);
`;

export class Database {
  readonly pool: Pool;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string) {
    const needsSsl = !/localhost|127\.0\.0\.1|\/tmp|sslmode=disable/.test(connectionString);
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
  }

  /**
   * Creates the schema once per process. Safe to call from many cold starts at once.
   * DDL like CREATE INDEX IF NOT EXISTS takes table locks even when the object exists,
   * which can deadlock with live booking traffic, so it only runs when the schema is missing.
   */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (await this.schemaExists(this.pool)) return;
        await this.transaction(async (c) => {
          await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('booking-api:schema', 0))`);
          if (!(await this.schemaExists(c))) await c.query(SCHEMA_SQL);
        });
      })().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  /** Catalog lookup only; takes no table locks. Checks the last object SCHEMA_SQL creates. */
  private async schemaExists(q: Pool | PoolClient): Promise<boolean> {
    const { rows } = await q.query(`SELECT to_regclass('public.booking_attempts_email_at') IS NOT NULL AS ok`);
    return rows[0].ok;
  }

  /** Runs fn in a transaction, retrying a few times if Postgres aborts it as a deadlock victim. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce(fn);
      } catch (err) {
        const code = (err as { code?: string }).code;
        const retryable = code === '40P01' || code === '40001';
        if (!retryable || attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
      }
    }
  }

  private async runOnce<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/** Takes a lock that is released automatically when the transaction ends. */
export async function lockKey(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
