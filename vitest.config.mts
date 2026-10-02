import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test file runs in its own child process, so module state (the Mongoose model registry and
    // connection) is fresh per file. Both values are the defaults.
    pool: 'forks',
    isolate: true,
    restoreMocks: true,
    testTimeout: 10_000,
    globalSetup: ['tests/setup/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      SECRET_KEY: 'test-secret-at-least-32-characters-long', // ADR-034: at least 32 characters
      GOOGLE_CLIENT_ID: 'test-client-id',
      CLOUDINARY_URL: 'cloudinary://key:secret@demo',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'], // exercised by a spawned process (§5.4), invisible to in-process V8 coverage
      reporter: ['text-summary', 'text', 'lcov'],
      thresholds: {
        // The global floor (M7): the whole of src/ together, beside the per-file bar below, which stays binding.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        'src/**/*.ts': { lines: 90, functions: 90, branches: 80, statements: 90 },
      },
    },
  },
});
