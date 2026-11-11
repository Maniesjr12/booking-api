import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Database } from '../src/db';

const API_KEY = 'test-key';
const db = new Database(process.env.TEST_DATABASE_URL ?? 'postgres://localhost/booking_api_test');
const app = createApp(
  { apiKey: API_KEY, databaseUrl: '', rateLimitMax: 5, rateLimitWindowSeconds: 60 },
  db,
);

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString().replace('.000', '');
const SLOTS = [
  { id: 's2', provider: 'Dr Ade', start: hoursFromNow(48), end: hoursFromNow(48.5) },
  { id: 's1', provider: 'Dr Ade', start: hoursFromNow(24), end: hoursFromNow(24.5) },
  { id: 's3', provider: 'Dr Bello', start: hoursFromNow(36), end: hoursFromNow(36.5) },
  { id: 'past', provider: 'Dr Bello', start: hoursFromNow(-2), end: hoursFromNow(-1.5) },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    provider: 'Dr Many',
    start: hoursFromNow(100 + i),
    end: hoursFromNow(100.5 + i),
  })),
];

const api = () => ({
  get: (url: string) => request(app).get(url).set('X-API-Key', API_KEY),
  post: (url: string) => request(app).post(url).set('X-API-Key', API_KEY),
  del: (url: string) => request(app).delete(url).set('X-API-Key', API_KEY),
});
const book = (body: object, key?: string) => {
  const r = api().post('/bookings');
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

beforeAll(async () => {
  await db.init();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  const res = await api().post('/reset').send({ slots: SLOTS });
  expect(res.status).toBe(200);
});

describe('level 1', () => {
  it('lists slots earliest first with availability and exact provider filter', async () => {
    const res = await api().get('/slots');
    expect(res.status).toBe(200);
    expect(res.body.slots.slice(0, 4).map((s: { id: string }) => s.id)).toEqual(['past', 's1', 's3', 's2']);
    expect(res.body.slots[1]).toEqual({ ...SLOTS[1], available: true });

    const ade = await api().get('/slots?provider=Dr%20Ade');
    expect(ade.body.slots.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
    const none = await api().get('/slots?provider=dr%20ade');
    expect(none.body.slots).toEqual([]);
  });

  it('books a slot, looks it up, and marks the slot unavailable', async () => {
    const res = await book({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com', status: 'confirmed' });
    expect(typeof res.body.id).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.created_at))).toBe(false);

    const got = await api().get(`/bookings/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual(res.body);

    const slots = await api().get('/slots');
    expect(slots.body.slots.find((s: { id: string }) => s.id === 's1').available).toBe(false);
  });

  it('returns 404 for an unknown booking', async () => {
    const res = await api().get('/bookings/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('reset deletes bookings', async () => {
    const b = await book({ slot_id: 's1', name: 'Ada', email: 'reset@example.com' });
    await api().post('/reset').send({ slots: SLOTS });
    expect((await api().get(`/bookings/${b.body.id}`)).status).toBe(404);
  });
});

describe('level 2', () => {
  it('rejects missing or wrong API keys with 401', async () => {
    for (const r of [
      request(app).get('/slots'),
      request(app).get('/slots').set('X-API-Key', 'wrong'),
      request(app).post('/bookings').send({}),
      request(app).post('/reset').send({ slots: [] }),
      request(app).get('/bookings/x'),
    ]) {
      const res = await r;
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: expect.any(String) });
    }
  });

  it.each([
    [{ name: 'A', email: 'a@example.com' }],
    [{ slot_id: '', name: 'A', email: 'a@example.com' }],
    [{ slot_id: 's1', email: 'a@example.com' }],
    [{ slot_id: 's1', name: '   ', email: 'a@example.com' }],
    [{ slot_id: 's1', name: 'A' }],
    [{ slot_id: 's1', name: 'A', email: '' }],
    [{ slot_id: 's1', name: 'A', email: 'not-an-email' }],
    [{ slot_id: 's1', name: 'A', email: 'a@b' }],
    [{ slot_id: 's1', name: 'A', email: 'a b@example.com' }],
    [{ slot_id: 's1', name: 42, email: 'a@example.com' }],
  ])('400 for invalid body %j', async (body) => {
    const res = await book(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('400 for malformed JSON', async () => {
    const res = await api().post('/bookings').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('404 for an unknown slot, 400 for a slot that already started', async () => {
    expect((await book({ slot_id: 'zzz', name: 'A', email: 'a1@example.com' })).status).toBe(404);
    expect((await book({ slot_id: 'past', name: 'A', email: 'a2@example.com' })).status).toBe(400);
  });

  it('trims name and email and lower-cases email', async () => {
    const res = await book({ slot_id: 's1', name: '  Ada Obi ', email: '  ADA@Example.COM ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Ada Obi');
    expect(res.body.email).toBe('ada@example.com');
  });
});

describe('level 3', () => {
  it('only one of many simultaneous bookings for a slot succeeds', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => book({ slot_id: 's2', name: `P${i}`, email: `p${i}@example.com` })),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(24);
  });

  it('cancels a booking, frees the slot, and 409s a second cancel', async () => {
    const b = await book({ slot_id: 's1', name: 'Ada', email: 'c@example.com' });
    expect((await book({ slot_id: 's1', name: 'Bo', email: 'd@example.com' })).status).toBe(409);

    const cancelled = await api().del(`/bookings/${b.body.id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toEqual({ ...b.body, status: 'cancelled' });
    expect((await api().get(`/bookings/${b.body.id}`)).body.status).toBe('cancelled');
    expect((await api().del(`/bookings/${b.body.id}`)).status).toBe(409);
    expect((await api().del('/bookings/missing')).status).toBe(404);

    const slots = await api().get('/slots');
    expect(slots.body.slots.find((s: { id: string }) => s.id === 's1').available).toBe(true);
    expect((await book({ slot_id: 's1', name: 'Bo', email: 'd@example.com' })).status).toBe(201);
  });
});

describe('level 4', () => {
  it('replays the same response for the same key and body', async () => {
    const body = { slot_id: 's1', name: 'Ada', email: 'idem@example.com' };
    const first = await book(body, 'key-1');
    const second = await book(body, 'key-1');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const list = await api().get('/bookings?email=idem@example.com');
    expect(list.body.bookings).toHaveLength(1);
  });

  it('returns 422 when a key is reused with a different body', async () => {
    await book({ slot_id: 's1', name: 'Ada', email: 'idem2@example.com' }, 'key-2');
    const res = await book({ slot_id: 's3', name: 'Ada', email: 'idem2@example.com' }, 'key-2');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: expect.any(String) });
  });

  it('simultaneous retries with one key create a single booking', async () => {
    const body = { slot_id: 's3', name: 'Ada', email: 'idem3@example.com' };
    const results = await Promise.all(Array.from({ length: 4 }, () => book(body, 'key-3')));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });

  it('pages through a person’s bookings oldest first, matching email case-insensitively', async () => {
    const ids: string[] = [];
    // Two emails so each stays under the 5-per-minute booking limit.
    for (let i = 0; i < 7; i++) {
      const res = await book({ slot_id: `m${i}`, name: 'Pat', email: i < 4 ? 'pat@example.com' : 'PAT2@example.com' });
      expect(res.status).toBe(201);
      if (i < 4) ids.push(res.body.id);
    }
    const p1 = await api().get('/bookings?email=PAT@Example.com&limit=3');
    expect(p1.status).toBe(200);
    expect(p1.body.bookings.map((b: { id: string }) => b.id)).toEqual(ids.slice(0, 3));
    expect(typeof p1.body.next_cursor).toBe('string');

    const p2 = await api().get(`/bookings?email=pat@example.com&limit=3&cursor=${p1.body.next_cursor}`);
    expect(p2.body.bookings.map((b: { id: string }) => b.id)).toEqual(ids.slice(3));
    expect(p2.body.next_cursor).toBeNull();

    const def = await api().get('/bookings?email=pat2@example.com');
    expect(def.body.bookings).toHaveLength(3);
    expect(def.body.next_cursor).toBeNull();
  });

  it.each(['0', '51', 'abc', '1.5', '-1', ''])('400 for limit=%s', async (limit) => {
    const res = await api().get(`/bookings?email=a@example.com&limit=${limit}`);
    expect(res.status).toBe(400);
  });

  it('400 for a missing email or bad cursor', async () => {
    expect((await api().get('/bookings')).status).toBe(400);
    expect((await api().get('/bookings?email=a@example.com&cursor=garbage')).status).toBe(400);
  });
});

describe('level 5', () => {
  it('allows 5 attempts per email per minute, counting failures, then 429 with Retry-After', async () => {
    const email = 'spam@example.com';
    const codes = [];
    codes.push((await book({ slot_id: 'zzz', name: 'S', email })).status); // 404
    codes.push((await book({ slot_id: 'past', name: 'S', email })).status); // 400
    codes.push((await book({ slot_id: 's1', email: ` ${email.toUpperCase()}` })).status); // 400, same email
    codes.push((await book({ slot_id: 's1', name: 'S', email })).status); // 201
    codes.push((await book({ slot_id: 's1', name: 'S', email })).status); // 409
    expect(codes).toEqual([404, 400, 400, 201, 409]);

    const sixth = await book({ slot_id: 's2', name: 'S', email });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: expect.any(String) });
    const retry = Number(sixth.headers['retry-after']);
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);

    expect((await book({ slot_id: 's2', name: 'Other', email: 'other@example.com' })).status).toBe(201);
  });

  it('holds the limit exactly under simultaneous requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => book({ slot_id: `m${i % 10}`, name: 'S', email: 'burst@example.com' })),
    );
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });
});
