// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const LEGACY_DIRS = ['routes', 'controllers', 'middlewares', 'helpers', 'models'];

// ARCHITECTURE §2.3. Each file gets exactly one `no-restricted-imports` entry (flat config replaces, never merges).
const rule = (message, regex, allowTypeImports = false) => ({ regex, message, allowTypeImports });
const SIBLING_MODULE = rule(
  'Modules never import another module; wire services in src/app.ts (§2.3 rule 4).',
  '^\\.\\./[^./]',
);
const FEATURE_MODULES = rule(
  'Cross-cutting code must not import feature modules (§2.3 rule 5).',
  '(^|/)modules(/|$)',
);
const COMPOSITION = rule(
  'Only the entrypoint may import the composition root or the legacy seam.',
  '(^|/)(app|server|legacy)$',
);
const PERSISTENCE = rule(
  'Routes and controllers never touch persistence; call a service (§2.3 rules 1-2).',
  '^mongoose$|\\.model$',
);
const HTTP = rule(
  'Services never import Express, routes, controllers or middlewares (§2.3 rule 3).',
  '^express($|-)|\\.(routes|controller)$|(^|/)middlewares(/|$)',
);
const ROUTE_SKIPS_CONTROLLER = rule('Routes call controllers, not services (§2.3 rule 1).', '\\.service$');
const SDK = rule(
  'External SDKs are wrapped by a *.client.ts and injected into services.',
  '^(cloudinary|google-auth-library)$',
);

const layer = (files, ...patterns) => ({
  files,
  rules: { '@typescript-eslint/no-restricted-imports': ['error', { patterns }] },
});

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'public/', 'node_modules/', 'e2e/'] },
  {
    files: ['**/*.ts', '**/*.mts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/config/**'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration from the Config object (src/config).',
        },
      ],
    },
  },
  layer(['src/config/**/*.ts'], rule('config is a leaf: it imports nothing else from the app.', '^\\.\\./')),
  layer(
    ['src/core/**/*.ts'],
    FEATURE_MODULES,
    COMPOSITION,
    rule('core must not depend on HTTP middlewares or the database.', '(^|/)(middlewares|database)(/|$)'),
    rule('core stays framework-agnostic.', '^express($|-)', true),
  ),
  layer(['src/middlewares/**/*.ts', 'src/database/**/*.ts'], FEATURE_MODULES, COMPOSITION),
  layer(['src/modules/**/*.ts'], SIBLING_MODULE, COMPOSITION),
  layer(
    ['src/modules/**/*.routes.ts'],
    SIBLING_MODULE,
    COMPOSITION,
    PERSISTENCE,
    ROUTE_SKIPS_CONTROLLER,
    SDK,
  ),
  layer(['src/modules/**/*.controller.ts'], SIBLING_MODULE, COMPOSITION, PERSISTENCE, SDK),
  layer(['src/modules/**/*.service.ts'], SIBLING_MODULE, COMPOSITION, HTTP, SDK),
  {
    // Legacy JS (ADR-016) is not style-linted. It must never reach into src/ (only .ts in dev, breaks dist).
    files: LEGACY_DIRS.map((dir) => `${dir}/**/*.js`),
    languageOptions: { sourceType: 'commonjs' },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'] > Literal[value=/(^|\\/)(src|dist)(\\/|$)/]",
          message: 'Legacy JS must not require src/ or dist/ (breaks the compiled build).',
        },
      ],
    },
  },
  {
    // supertest bodies and legacy Mongoose documents are untyped until M3 replaces the legacy modules.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/]",
          message:
            'vi.mock cannot reach require() in legacy JS: spy on the instance from tests/helpers/legacy.ts.',
        },
      ], // ADR-023
    },
  },
  { files: ['**/*.mjs'], extends: [js.configs.recommended, tseslint.configs.disableTypeChecked] },
);
