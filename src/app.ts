import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import { AppConfig } from './config';
import { Database } from './db';
import { BookingService } from './domain/bookings';
import { SlotService } from './domain/slots';
import { HttpError } from './domain/types';
import { apiRouter } from './routes/api';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function apiKeyGuard(expected: string) {
  const expectedHash = sha256(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const given = req.get('X-API-Key');
    if (!given || !timingSafeEqual(sha256(given), expectedHash)) {
      res.status(401).json({ error: 'missing or invalid API key' });
      return;
    }
    next();
  };
}

export function createApp(config: AppConfig, db: Database): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
      'Access-Control-Expose-Headers': 'Retry-After',
    });
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Public: the web page and a health check. Everything else needs the API key.
  const publicDir = [path.join(__dirname, '..', 'public'), path.join(process.cwd(), 'public')].find((p) =>
    existsSync(path.join(p, 'index.html')),
  );
  if (publicDir) app.use(express.static(publicDir));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(apiKeyGuard(config.apiKey));
  app.use(express.json({ limit: '100kb' }));
  app.use(async (_req, _res, next) => {
    try {
      await db.init();
      next();
    } catch (err) {
      next(err);
    }
  });

  const bookings = new BookingService(db, {
    max: config.rateLimitMax,
    windowSeconds: config.rateLimitWindowSeconds,
  });
  app.use(apiRouter(new SlotService(db), bookings));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body is too large' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
