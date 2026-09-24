import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Every environment variable the process reads. Names are unchanged from the legacy code (ADR-019). */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(1500),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  MONGO_CLOUD: z.string().regex(/^mongodb(\+srv)?:\/\/\S+$/, 'must be a mongodb:// or mongodb+srv:// URI'),
  SECRET_KEY: z.string().min(1),
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
});

export type Env = z.infer<typeof envSchema>;
