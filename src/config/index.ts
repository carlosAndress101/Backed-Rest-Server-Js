import { z } from 'zod';

import { envSchema, type Env } from './env';

export { envSchema, LOG_LEVELS, type Env } from './env';

export type LogLevel = NonNullable<Env['LOG_LEVEL']>;

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly mongoUri: string;
  readonly cors: { readonly origins: '*' | readonly string[] };
  /** C9: reverse-proxy hops to trust for req.ip (and so the C5 limiter key); undefined keeps Express's default. */
  readonly trustProxy: number | undefined;
  /** Consumed by the auth module and by authenticate's token service. */
  readonly auth: {
    readonly jwtSecret: string;
    readonly googleClientId: string;
    /** JWT_TTL, converted to seconds. */
    readonly jwtTtlSeconds: number;
    /** BCRYPT_COST: the cost every new password hash uses (T5.2). */
    readonly bcryptCost: number;
  };
  /** Consumed by the media module in M3. */
  readonly media: { readonly cloudinaryUrl: string };
  /** D5 (ADR-047): /docs and /docs/openapi.json are mounted only when true. */
  readonly docs: { readonly enabled: boolean };
  /** Read only by `pnpm seed` (M4 design §6, D-14). `adminPassword` is never logged (P20). */
  readonly seed: { readonly adminEmail?: string; readonly adminPassword?: string };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses and validates the environment once, at boot. Throws ConfigError listing every invalid variable. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // An empty variable (`FOO=`) counts as unset, so defaults and "required" behave the same for both.
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return Object.freeze<Config>({
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    mongoUri: env.MONGO_CLOUD,
    cors: { origins: origins.length === 0 || origins.includes('*') ? '*' : origins },
    trustProxy: env.TRUST_PROXY,
    auth: {
      jwtSecret: env.SECRET_KEY,
      googleClientId: env.GOOGLE_CLIENT_ID,
      jwtTtlSeconds: env.JWT_TTL,
      bcryptCost: env.BCRYPT_COST,
    },
    media: { cloudinaryUrl: env.CLOUDINARY_URL },
    docs: { enabled: env.DOCS_ENABLED ?? env.NODE_ENV !== 'production' },
    seed: { adminEmail: env.SEED_ADMIN_EMAIL, adminPassword: env.SEED_ADMIN_PASSWORD },
  });
}
