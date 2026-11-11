import { Router, Request, Response } from 'express';
import { BookingService } from '../domain/bookings';
import { SlotService } from '../domain/slots';
import { ApiResult, HttpError } from '../domain/types';
import { parseLimit, parseResetBody } from '../domain/validation';

function send(res: Response, result: ApiResult): void {
  if (result.headers) res.set(result.headers);
  res.status(result.status).json(result.body);
}

function singleQuery(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be given once`);
  return v;
}

export function apiRouter(slots: SlotService, bookings: BookingService): Router {
  const r = Router();

  r.post('/reset', async (req, res) => {
    const parsed = parseResetBody(req.body);
    await slots.reset(parsed);
    res.status(200).json({ status: 'ok', slots: parsed.length });
  });

  r.get('/slots', async (req, res) => {
    res.json({ slots: await slots.list(singleQuery(req, 'provider')) });
  });

  r.post('/bookings', async (req, res) => {
    const header = req.get('Idempotency-Key');
    const key = header === undefined || header.trim() === '' ? undefined : header.trim();
    if (key !== undefined && key.length > 255) throw new HttpError(400, 'Idempotency-Key is too long');
    send(res, await bookings.create(req.body, key));
  });

  r.get('/bookings', async (req, res) => {
    const email = singleQuery(req, 'email');
    if (email === undefined || email.trim() === '') throw new HttpError(400, 'email is required');
    const limit = parseLimit(req.query.limit);
    res.json(await bookings.listByEmail(email, limit, req.query.cursor));
  });

  r.get('/bookings/:id', async (req, res) => {
    res.json(await bookings.get(req.params.id));
  });

  r.delete('/bookings/:id', async (req, res) => {
    res.json(await bookings.cancel(req.params.id));
  });

  return r;
}
