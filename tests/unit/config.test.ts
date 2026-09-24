import { afterEach, describe, expect, test, vi } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config';

const REQUIRED = ['MONGO_CLOUD', 'SECRET_KEY', 'GOOGLE_CLIENT_ID', 'CLOUDINARY_URL'] as const;

const VALID: NodeJS.ProcessEnv = {
  MONGO_CLOUD: 'mongodb://127.0.0.1:27017/cafe',
  SECRET_KEY: 'jwt-secret',
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
      auth: { jwtSecret: VALID.SECRET_KEY, googleClientId: VALID.GOOGLE_CLIENT_ID },
      media: { cloudinaryUrl: VALID.CLOUDINARY_URL },
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
