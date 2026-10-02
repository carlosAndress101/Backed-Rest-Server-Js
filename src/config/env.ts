import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const TTL_UNITS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;
/**
 * JWT_TTL in seconds. A bare integer means seconds: handed to jsonwebtoken as a string, '3600' would mean 3.6 s
 * (the `ms` package reads a bare numeric string as milliseconds), so the value is converted here, once.
 */
const ttlSeconds = (ttl: string): number => {
  const unit = ttl.at(-1) as keyof typeof TTL_UNITS;
  return unit in TTL_UNITS ? Number(ttl.slice(0, -1)) * TTL_UNITS[unit] : Number(ttl);
};

/** Every environment variable the process reads. Names are unchanged from the legacy code (ADR-019). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(1500),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  MONGO_CLOUD: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, 'must be a mongodb:// or mongodb+srv:// URI'),
  // ADR-034: HS256's recommended key size, 256 bits. A shorter secret stops the boot (ADR-019).
  SECRET_KEY: z.string().min(32, 'must be at least 32 characters (256 bits) for HS256'),
  // ADR-034 / AM-M5-2: the session length; a positive integer of seconds or <n>s|m|h|d.
  JWT_TTL: z
    .string()
    .regex(/^[1-9]\d*[smhd]?$/, 'must be a positive integer of seconds or <n>s|m|h|d, e.g. 4h')
    .default('4h')
    .transform(ttlSeconds),
  // ADR-035 / AM-M5-3: the bcrypt cost of new hashes; 10 is the 2.x cost, 14 already costs about a second.
  BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(10),
  GOOGLE_CLIENT_ID: z.string().min(1),
  CLOUDINARY_URL: z
    .string()
    .regex(
      /^cloudinary:\/\/[^:\s]+:[^@\s]+@\S+$/,
      'must be cloudinary://<api_key>:<api_secret>@<cloud_name>',
    ),
  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer hop count (C9)')
    .transform(Number)
    .optional(),
  // The first admin `pnpm seed` creates (M4 design §6). Plain strings: the seed checks them, not the boot.
  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(), // never logged (P20)
});

export type Env = z.infer<typeof envSchema>;
