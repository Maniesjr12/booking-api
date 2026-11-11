import { Database } from '../db';
import { Slot, SlotWithAvailability } from './types';

export class SlotService {
  constructor(private readonly db: Database) {}

  async list(provider?: string): Promise<SlotWithAvailability[]> {
    const { rows } = await this.db.pool.query(
      `SELECT s.id, s.provider, s.start_raw, s.end_raw,
              NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
         FROM slots s
        WHERE ($1::text IS NULL OR s.provider = $1)
        ORDER BY s.start_at ASC, s.id ASC`,
      [provider ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start_raw,
      end: r.end_raw,
      available: r.available,
    }));
  }

  /** Deletes every booking (and the idempotency / rate-limit records tied to them) and replaces all slots. */
  async reset(slots: Slot[]): Promise<void> {
    await this.db.transaction(async (c) => {
      await c.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts');
      if (slots.length === 0) return;
      await c.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at)
         SELECT id, provider, start_raw, end_raw, start_raw::timestamptz
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
             AS t(id, provider, start_raw, end_raw)`,
        [slots.map((s) => s.id), slots.map((s) => s.provider), slots.map((s) => s.start), slots.map((s) => s.end)],
      );
    });
  }
}
