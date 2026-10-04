# OpenAPI Docs Specification

## Purpose

Define the generated OpenAPI 3.1 document, its `/docs` and `/docs/openapi.json` serving surface, the `DOCS_ENABLED` configuration flag, the docs-scoped Content-Security-Policy, and the drift guards that keep the document synchronized with the live route set. This capability exists so API consumers and future agents have a self-serve, code-derived contract (ROADMAP M8), closing TECH_DEBT DOC-01 for the generated-spec portion.

## Requirements

### Requirement: OpenAPI document generation from zod schemas

The system MUST generate an OpenAPI 3.1 document (`openapi: "3.1.x"`) by converting each module's exported zod request schemas (params, query, body) with `z.toJSONSchema({ target: 'draft-2020-12', io: 'input' })`, and MUST NOT hand-retype any request schema inside the generator.

The generator MUST use `io: 'input'` for every converted schema so that schemas using `.transform` (for example, email lowercasing in `auth` and `users`), `.default`, and `z.coerce` (pagination) describe the shape a client sends, not the shape produced after transformation.

#### Scenario: Request schema is converted without throwing

- GIVEN a module's exported zod schema that includes a `.transform` step (for example `auth.schemas.ts`'s `loginBody` email normalization)
- WHEN the generator converts it with `io: 'input'`
- THEN the conversion succeeds without throwing
- AND the resulting JSON Schema describes the pre-transform input shape (e.g. `email` as a plain string, not the lowercased/transformed value)

#### Scenario: Every exported DTO converts successfully

- GIVEN all zod schemas exported from `src/modules/*/`'s `*.schemas.ts` files and `core/http/pagination.ts`
- WHEN a unit test runs the generator's conversion step over each exported schema
- THEN every conversion completes without throwing
- AND the test fails if a new schema is added to a module without being wired into the generator

#### Scenario: Output-mode conversion would throw (negative control)

- GIVEN the same transform-bearing schema as above
- WHEN the schema is converted with `io: 'output'` instead of `io: 'input'`
- THEN the conversion throws
- AND this confirms why the generator is required to use `io: 'input'` for every request schema

### Requirement: Operation catalog covers every live API operation

The system MUST include exactly one documented operation entry (method + path) for each of the 21 live API operations, each referencing its module's exported zod schema(s) for parameters, query, and body where one exists.

The system MUST document the `search` module's collection and term path parameters from the exported `SEARCH_COLLECTIONS` constant (an enum derived from that constant), per the approved decision that the search route keeps its unbound 400 `BAD_REQUEST` behavior and receives no new zod schema in `src/modules/search/`.

#### Scenario: Documented operation set equals the live route set

- GIVEN the generated OpenAPI document's set of (method, path) operation entries
- AND the live route set exposed by the application (as captured by the existing permission-matrix fixture, ADR-044's single source of truth)
- WHEN a test compares the two sets for equality
- THEN the test passes only when every live route has exactly one matching documented operation and no documented operation references a route that does not exist

#### Scenario: Adding a route without a catalog entry fails closed

- GIVEN a new route is added to any module's `*.routes.ts` file
- AND no corresponding operation entry is added to the catalog
- WHEN the drift-equality test runs
- THEN the test fails, naming the undocumented route

#### Scenario: Search operation is documented from the collection allowlist

- GIVEN the generated document's entry for the search route
- WHEN its path parameter schema is inspected
- THEN the `collection` parameter's enum values exactly match `SEARCH_COLLECTIONS`
- AND the operation's documented error responses include the 400 `BAD_REQUEST` behavior for an unknown collection value

### Requirement: Error envelope component matches the ErrorCode set exactly

The system MUST define a shared `ErrorEnvelope` OpenAPI component whose `code` field is an enum containing exactly the 9 `ErrorCode` values defined in `src/core/errors/app-error.ts`, and this enum MUST be derived through a construct the compiler checks (e.g. `satisfies Record<ErrorCode, ...>`) so that adding or removing an `ErrorCode` without updating the table fails to compile.

Every operation in the catalog MUST reference the shared `ErrorEnvelope` component for its error responses rather than inlining a duplicate error shape.

#### Scenario: Error catalogue table is compile-time exhaustive

- GIVEN the `ErrorCode` union in `src/core/errors/app-error.ts` has 9 members
- WHEN the openapi module's error-code table is type-checked
- THEN TypeScript compilation fails if the table is missing an entry for any `ErrorCode` or contains an entry for a code that does not exist in the union

#### Scenario: Generated document's error enum matches ErrorCode exactly

- GIVEN the generated OpenAPI document's `ErrorEnvelope` component schema
- WHEN a test reads its `code` property's enum values
- THEN the enum contains exactly the 9 `ErrorCode` values, in a deterministic order, with no additions or omissions

### Requirement: Document structural validity

The system MUST produce a document that satisfies structural invariants without depending on a third-party OpenAPI validator package: every `$ref` resolves to an existing component, every `operationId` is unique across the document, every path parameter declared in a path template has a corresponding parameter schema, and the `openapi` field matches `3.1.x`.

#### Scenario: All references resolve

- GIVEN the generated document
- WHEN a test walks every `$ref` string in the document
- THEN each one resolves to an existing node under `components`

#### Scenario: Unique operation identifiers

- GIVEN the generated document's operations
- WHEN a test collects every `operationId`
- THEN no `operationId` value appears more than once

#### Scenario: Path parameters are fully declared

- GIVEN a documented path containing a `{param}` template segment
- WHEN a test inspects that operation's parameter list
- THEN a parameter of type `path` matching that segment name is present

### Requirement: Bearer security scheme applies only to authenticated operations

The system MUST declare a Bearer HTTP security scheme and MUST apply it to the security requirements of operations that require authentication in the live route set, and MUST NOT apply it to public operations (for example sign-in, sign-up, and public read routes that are unauthenticated in the live application).

#### Scenario: Authenticated operation requires the Bearer scheme

- GIVEN an operation that maps to a route guarded by the authentication middleware in the live application
- WHEN the generated document's security requirement for that operation is inspected
- THEN the Bearer scheme is present in its `security` array

#### Scenario: Public operation has no security requirement

- GIVEN an operation that maps to a route with no authentication middleware (for example the login route)
- WHEN the generated document's security requirement for that operation is inspected
- THEN no security requirement is present, or an explicit empty `security: []` is declared

### Requirement: `/docs` and `/docs/openapi.json` serving

When docs are enabled, the system MUST serve the generated document as JSON at `GET /docs/openapi.json` and MUST serve a human-readable HTML page at `GET /docs` that loads a pinned CDN-hosted UI bundle (exact version pin, Subresource Integrity hash) to render that JSON document; the HTML page itself MUST be dependency-free (no new npm package).

The document MUST be built once per application instance at startup when docs are enabled, not rebuilt per request.

#### Scenario: JSON document is served

- GIVEN docs are enabled
- WHEN a client sends `GET /docs/openapi.json`
- THEN the response has status 200
- AND the response body is the generated OpenAPI document with `openapi` matching `3.1.x`

#### Scenario: HTML page is served and references a pinned, integrity-checked bundle

- GIVEN docs are enabled
- WHEN a client sends `GET /docs`
- THEN the response has status 200 and an HTML content type
- AND the HTML references the UI bundle script/style tag with an exact pinned version and a `integrity` attribute (SRI hash)

#### Scenario: Document is built once, not per request

- GIVEN docs are enabled and the application has started
- WHEN two separate requests are sent to `GET /docs/openapi.json`
- THEN both responses are served without re-invoking the full generation pipeline per request (verified by a test asserting the generation function is not re-entered per request, e.g. by injecting a counting fake builder through the docs module's dependency parameter — ADR-023 forbids spying on the frozen ESM export directly)

### Requirement: `DOCS_ENABLED` flag semantics

The system MUST support an optional `DOCS_ENABLED` environment variable parsed with strict `'true' | 'false'` string matching (not `z.coerce.boolean()`, which misparses the string `'false'` as truthy).

The effective enablement MUST follow this table across `NODE_ENV` values:

| `DOCS_ENABLED` | `development` | `test` | `production` |
|---|---|---|---|
| unset / empty | enabled | enabled | disabled |
| `'true'` | enabled | enabled | enabled |
| `'false'` | disabled | disabled | disabled |
| any other value | boot fails (`ConfigError`) | boot fails (`ConfigError`) | boot fails (`ConfigError`) |

When `DOCS_ENABLED` is `'true'` and `NODE_ENV` is `production`, the system MUST emit a boot log line noting that docs are enabled in production, following the existing ADR-022 CORS-warning precedent.

#### Scenario: Unset flag defaults disabled in production

- GIVEN `NODE_ENV=production` and `DOCS_ENABLED` is unset
- WHEN the application boots
- THEN `/docs` and `/docs/openapi.json` are not mounted

#### Scenario: Unset flag defaults enabled in development and test

- GIVEN `NODE_ENV=development` (or `NODE_ENV=test`) and `DOCS_ENABLED` is unset
- WHEN the application boots
- THEN `/docs` and `/docs/openapi.json` are mounted and reachable

#### Scenario: Explicit `'true'` enables docs in every environment

- GIVEN `DOCS_ENABLED='true'` for `NODE_ENV` of `development`, `test`, or `production`
- WHEN the application boots
- THEN `/docs` and `/docs/openapi.json` are mounted and reachable in all three cases
- AND when `NODE_ENV=production`, a boot log line reports that docs are enabled in production

#### Scenario: Explicit `'false'` disables docs in every environment

- GIVEN `DOCS_ENABLED='false'` for `NODE_ENV` of `development`, `test`, or `production`
- WHEN the application boots
- THEN `/docs` and `/docs/openapi.json` are not mounted in all three cases

#### Scenario: Invalid value fails boot fast

- GIVEN `DOCS_ENABLED` is set to any non-empty value other than `'true'` or `'false'` (e.g. `'1'`, `'yes'`; note `''` never reaches the parser — `src/config/index.ts` strips empty entries before parsing, so an empty value is indistinguishable from unset per this spec's own flag table)
- WHEN the application attempts to boot
- THEN boot fails with a `ConfigError` naming `DOCS_ENABLED` among the invalid variables, consistent with the existing fail-fast `loadConfig` behavior (ADR-019)

#### Scenario: Disabled docs return the standard 404 envelope

- GIVEN docs are disabled for the current configuration
- WHEN a client sends `GET /docs` or `GET /docs/openapi.json`
- THEN the response is the standard `NOT_FOUND` error envelope at status 404
- AND the response does not otherwise reveal that a docs feature exists (no distinct "docs disabled" message)

### Requirement: Docs-scoped Content-Security-Policy

The system MUST apply a Content-Security-Policy that allows the pinned CDN origin(s) for the UI bundle only to responses served under `/docs`, and MUST NOT widen the application's global `HELMET_OPTIONS` CSP (the policy applied to `/api/*` and other routes) to accommodate the docs UI.

#### Scenario: `/docs` response carries the docs-scoped CSP

- GIVEN docs are enabled
- WHEN a client sends `GET /docs`
- THEN the response's `Content-Security-Policy` header allows the pinned CDN origin(s) used by the UI bundle

#### Scenario: `/api/*` responses are unaffected by the docs CSP

- GIVEN docs are enabled
- WHEN a client sends a request to any `/api/*` route
- THEN the response's `Content-Security-Policy` header is unchanged from its pre-M8 value (apart from any approved demo-page-removal changes) and does not include the docs CDN origin allowlist

### Requirement: ADR-044 permission-matrix accommodation for `/docs`

The system MUST add rows to the existing permission-matrix fixture (`tests/helpers/permission-matrix.ts`) for the public `/docs` and `/docs/openapi.json` routes, marking them as public (no authentication required), so the existing ADR-044 fail-closed drift check continues to pass once `/docs` is mounted in the `test` environment.

#### Scenario: Permission matrix includes the docs routes

- GIVEN `/docs` and `/docs/openapi.json` are mounted in the `test` environment (docs default-enabled in test)
- WHEN the ADR-044 permission/drift check runs
- THEN it does not fail due to an undocumented or unexpected route, because the matrix fixture includes explicit public-access rows for both docs routes

#### Scenario: Matrix omission reproduces the fail-closed guard

- GIVEN a hypothetical state where the `/docs` routes are mounted but the permission-matrix fixture has no corresponding rows
- WHEN the ADR-044 drift check runs
- THEN it fails, demonstrating the guard is fail-closed rather than silently permissive
