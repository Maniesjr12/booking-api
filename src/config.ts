export interface AppConfig {
  apiKey: string;
  databaseUrl: string;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey) throw new Error('API_KEY environment variable is required');
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is required');
  return {
    apiKey,
    databaseUrl,
    rateLimitMax: intFromEnv('RATE_LIMIT_MAX', 5),
    rateLimitWindowSeconds: intFromEnv('RATE_LIMIT_WINDOW_SECONDS', 60),
  };
}
