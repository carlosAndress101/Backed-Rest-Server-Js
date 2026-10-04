import { afterEach, describe, expect, test, vi } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config';

const REQUIRED = ['MONGO_CLOUD', 'SECRET_KEY', 'GOOGLE_CLIENT_ID', 'CLOUDINARY_URL'] as const;

const VALID: NodeJS.ProcessEnv = {
  MONGO_CLOUD: 'mongodb://127.0.0.1:27017/cafe',
  SECRET_KEY: 'jwt-secret-at-least-32-characters-long',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  CLOUDINARY_URL: 'cloudinary://key:secret@demo',
};

const load = (overrides: NodeJS.ProcessEnv = {}) => loadConfig({ ...VALID, ...overrides });

/** Returns the ConfigError that loading `source` throws; fails the test if it loads. */
const configError = (source: NodeJS.ProcessEnv): ConfigError => {
  try {
    loadConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig defaults', () => {
  test('only the required variables set: every default applies', () => {
    const config = load();

    expect(config).toEqual({
      env: 'development',
      port: 1500,
      logLevel: 'info',
      mongoUri: VALID.MONGO_CLOUD,
      cors: { origins: '*' },
      trustProxy: undefined,
      auth: {
        jwtSecret: VALID.SECRET_KEY,
        googleClientId: VALID.GOOGLE_CLIENT_ID,
        jwtTtlSeconds: 4 * 60 * 60,
        bcryptCost: 10,
      },
      media: { cloudinaryUrl: VALID.CLOUDINARY_URL },
      docs: { enabled: true },
      seed: { adminEmail: undefined, adminPassword: undefined },
    });
  });

  test('the log level defaults to silent under test and to info otherwise', () => {
    expect(load({ NODE_ENV: 'test' }).logLevel).toBe('silent');
    expect(load({ NODE_ENV: 'production' }).logLevel).toBe('info');
  });

  test('an explicit LOG_LEVEL wins over the default', () => {
    expect(load({ NODE_ENV: 'test', LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  test('PORT is coerced to a number', () => {
    expect(load({ PORT: '8080' }).port).toBe(8080);
  });

  test('variables outside the schema are ignored', () => {
    expect(load({ PATH: '/usr/bin', GOOGLE_SECRET_ID: 'unused' })).toEqual(load());
  });

  test('without an argument it reads process.env', () => {
    vi.stubEnv('MONGO_CLOUD', 'mongodb://127.0.0.1:27017/from-process-env');

    const config = loadConfig();

    expect(config.mongoUri).toBe('mongodb://127.0.0.1:27017/from-process-env');
    expect(config.auth.jwtSecret).toBe(process.env.SECRET_KEY);
  });

  test('the result is frozen', () => {
    const config = load();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Reflect.set(config, 'port', 1)).toBe(false);
    expect(config.port).toBe(1500);
  });
});

describe('SEC-15 / C9 TRUST_PROXY accepts exactly what T1.7 accepted', () => {
  test.each([
    ['unset', undefined, undefined],
    ["''", '', undefined],
    ["'0'", '0', 0],
    ["'1'", '1', 1],
    ["'2'", '2', 2],
  ])('%s → trustProxy %s', (_label, value, expected) => {
    const source = { ...VALID };
    if (value !== undefined) source.TRUST_PROXY = value;

    expect(loadConfig(source).trustProxy).toBe(expected);
  });

  test.each(['abc', '-1', 'true', '1.5', ' 1', 'loopback'])(
    'TRUST_PROXY=%j is a ConfigError naming TRUST_PROXY',
    (value) => {
      const { message } = configError({ ...VALID, TRUST_PROXY: value });

      expect(message).toMatch(/must be a non-negative integer hop count \(C9\)\n\s+→ at TRUST_PROXY/);
    },
  );
});

describe('DOCS_ENABLED (D5, ADR-047)', () => {
  test.each([
    ['development', undefined, true],
    ['development', 'true', true],
    ['development', 'false', false],
    ['test', undefined, true],
    ['test', 'true', true],
    ['test', 'false', false],
    ['production', undefined, false],
    ['production', 'true', true],
    ['production', 'false', false],
  ])('NODE_ENV=%s, DOCS_ENABLED=%j → docs.enabled %s', (nodeEnv, value, expected) => {
    const source: NodeJS.ProcessEnv = { ...VALID, NODE_ENV: nodeEnv };
    if (value !== undefined) source.DOCS_ENABLED = value;

    expect(loadConfig(source).docs.enabled).toBe(expected);
  });

  test.each(['development', 'test', 'production'])(
    "NODE_ENV=%s: DOCS_ENABLED='' counts as unset",
    (nodeEnv) => {
      expect(load({ NODE_ENV: nodeEnv, DOCS_ENABLED: '' }).docs).toEqual(load({ NODE_ENV: nodeEnv }).docs);
    },
  );

  test.each(['1', 'yes', 'TRUE', ' true', 'on'])(
    'DOCS_ENABLED=%j is a ConfigError naming DOCS_ENABLED',
    (value) => {
      const { message } = configError({ ...VALID, DOCS_ENABLED: value });

      expect(message).toMatch(/must be 'true' or 'false'\n\s+→ at DOCS_ENABLED/);
    },
  );
});

describe('required variables', () => {
  test.each(REQUIRED)('%s missing is a ConfigError naming it', (name) => {
    const source = { ...VALID };
    delete source[name];

    expect(configError(source).message).toMatch(new RegExp(`→ at ${name}$`, 'm'));
  });

  test('all four missing: one error lists all four', () => {
    const { message } = configError({});

    expect(message).toMatch(/^Invalid environment:\n/);
    for (const name of REQUIRED) expect(message).toMatch(new RegExp(`→ at ${name}$`, 'm'));
  });

  test.each(REQUIRED)('%s set to an empty string counts as unset', (name) => {
    expect(configError({ ...VALID, [name]: '' }).message).toMatch(new RegExp(`→ at ${name}$`, 'm'));
  });

  test('an empty optional variable falls back to its default', () => {
    expect(load({ NODE_ENV: '', PORT: '', LOG_LEVEL: '', CORS_ORIGINS: '', TRUST_PROXY: '' })).toEqual(
      load(),
    );
  });
});

describe('invalid values are rejected', () => {
  test.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', 'abc'],
    ['PORT', '80.5'],
    ['LOG_LEVEL', 'verbose'],
    ['NODE_ENV', 'staging'],
    ['MONGO_CLOUD', 'postgres://127.0.0.1/cafe'],
    ['MONGO_CLOUD', 'mongodb://'],
    ['MONGO_CLOUD', 'mongodb://host with spaces/db'],
    ['CLOUDINARY_URL', 'https://api.cloudinary.com'],
    ['CLOUDINARY_URL', 'cloudinary://key@demo'],
    ['CLOUDINARY_URL', 'cloudinary://key:secret@'],
  ])('%s=%j is a ConfigError naming it', (name, value) => {
    expect(configError({ ...VALID, [name]: value }).message).toMatch(new RegExp(`→ at ${name}$`, 'm'));
  });

  test('mongodb+srv URIs are accepted', () => {
    expect(load({ MONGO_CLOUD: 'mongodb+srv://user:pass@cluster0.example.net/cafe' }).mongoUri).toBe(
      'mongodb+srv://user:pass@cluster0.example.net/cafe',
    );
  });
});

describe('CORS_ORIGINS', () => {
  test('a comma-separated list is trimmed', () => {
    expect(load({ CORS_ORIGINS: ' a , b ' }).cors.origins).toEqual(['a', 'b']);
  });

  test('a list containing * means any origin', () => {
    expect(load({ CORS_ORIGINS: 'https://a.example, *' }).cors.origins).toBe('*');
  });

  test('a list of only separators means any origin', () => {
    expect(load({ CORS_ORIGINS: ' , ,' }).cors.origins).toBe('*');
  });
});

describe('SEED_ADMIN_* (M4 design §6, D-14)', () => {
  const PASSWORD = 'seed-admin-secret-9f3c';

  test('both set: config.seed carries them as given (the seed trims and lowercases the email)', () => {
    expect(load({ SEED_ADMIN_EMAIL: ' Admin@Example.com ', SEED_ADMIN_PASSWORD: PASSWORD }).seed).toEqual({
      adminEmail: ' Admin@Example.com ',
      adminPassword: PASSWORD,
    });
  });

  test('both are optional, and an empty value counts as unset', () => {
    expect(load({ SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '' }).seed).toEqual({
      adminEmail: undefined,
      adminPassword: undefined,
    });
  });

  test("any value loads: a weak password or a malformed email is the seed's to refuse, never a boot failure", () => {
    expect(load({ SEED_ADMIN_EMAIL: 'not-an-email', SEED_ADMIN_PASSWORD: 'short' }).seed).toEqual({
      adminEmail: 'not-an-email',
      adminPassword: 'short',
    });
  });

  test('P20: a ConfigError never echoes SEED_ADMIN_PASSWORD, or any other value', () => {
    const { message } = configError({
      SEED_ADMIN_EMAIL: 'admin@example.com',
      SEED_ADMIN_PASSWORD: PASSWORD,
      PORT: 'not-a-port',
      NODE_ENV: 'staging',
    });

    expect(message).toMatch(/→ at MONGO_CLOUD$/m);
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('not-a-port');
    expect(message).not.toContain('staging');
  });
});

describe('SECRET_KEY must hold 256 bits for HS256 (ADR-034)', () => {
  test.each([
    ['31 characters', 'x'.repeat(31)],
    ['10 characters, the M4 test value', 'jwt-secret'],
  ])('a secret of %s is a ConfigError naming SECRET_KEY, never its value', (_case, secret) => {
    const { message } = configError({ ...VALID, SECRET_KEY: secret });

    expect(message).toMatch(/must be at least 32 characters \(256 bits\) for HS256\n\s+→ at SECRET_KEY$/m);
    expect(message).not.toContain(secret);
  });

  test('32 characters is enough', () => {
    expect(load({ SECRET_KEY: 'y'.repeat(32) }).auth.jwtSecret).toBe('y'.repeat(32));
  });
});

describe('JWT_TTL (AM-M5-2)', () => {
  test('defaults to 4h, as seconds', () => {
    expect(load().auth.jwtTtlSeconds).toBe(14_400);
  });

  test.each([
    ['3600', 3600], // a bare integer is seconds, never jsonwebtoken's milliseconds
    ['90s', 90],
    ['15m', 900],
    ['4h', 14_400],
    ['7d', 604_800],
  ])('%s is %i seconds', (ttl, seconds) => {
    expect(load({ JWT_TTL: ttl }).auth.jwtTtlSeconds).toBe(seconds);
  });

  test.each(['0', '0h', '-1h', '4 h', '1.5h', '4w', 'h', '4H', 'forever'])(
    'JWT_TTL=%j is a ConfigError naming JWT_TTL',
    (ttl) => {
      expect(configError({ ...VALID, JWT_TTL: ttl }).message).toMatch(/→ at JWT_TTL$/m);
    },
  );
});

describe('BCRYPT_COST (AM-M5-3)', () => {
  test('defaults to 10, the 2.x cost', () => {
    expect(load().auth.bcryptCost).toBe(10);
  });

  test.each([
    ['10', 10],
    ['12', 12],
    ['14', 14],
  ])('%s is accepted', (cost, expected) => {
    expect(load({ BCRYPT_COST: cost }).auth.bcryptCost).toBe(expected);
  });

  test.each(['9', '15', '31', '10.5', 'ten'])(
    'BCRYPT_COST=%j is a ConfigError naming BCRYPT_COST',
    (cost) => {
      expect(configError({ ...VALID, BCRYPT_COST: cost }).message).toMatch(/→ at BCRYPT_COST$/m);
    },
  );
});
