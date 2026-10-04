# Platform Readiness Specification

## Purpose

Define the deployment surface that makes the service a deployable, operable, stateless container (ROADMAP M9): the anonymous liveness/readiness routes an orchestrator or container healthcheck polls, the production-only boot guard that refuses to serve on an un-migrated database (OPS-05), the multi-stage production container image and the dev-only local compose stack (OPS-03 remainder, OPS-04), and the CI validation that exercises the built image without publishing it. This spec is written retroactively at change close-out (owner decision, 2026-10-04): the capability shipped in 3.2.0 before this record existed, and every requirement below is derived from the delivered code, tests, and design decisions (`design.md` D1–D7), not from new intent.

## Requirements

### Requirement: Liveness endpoint answers without touching the database

The system MUST expose `GET /health` as an anonymous route that answers `200` with the standard success envelope `{ data: { status: 'ok' } }` whenever the process is serving requests, without performing any database check or other dependent I/O, and without authentication or rate limiting.

#### Scenario: Liveness succeeds independently of the database

- GIVEN the application process is running and accepting connections
- WHEN a client sends `GET /health`
- THEN the response status is `200`
- AND the response body is `{ data: { status: 'ok' } }`
- AND the response carries a request id header
- AND no database query is performed to produce this response

### Requirement: Readiness endpoint performs a real database round-trip

The system MUST expose `GET /ready` as an anonymous route that performs a real dependency check (a database connectivity ping, not only a cached connection-state flag) and answers `200` with `{ data: { status: 'ok' } }` when the check succeeds.

When the check fails (rejects), the system MUST answer with the standard error envelope at status `500` with code `INTERNAL` and message `'Database not ready'`, through the same error-handling pipeline used by the rest of the API, and MUST NOT leak the underlying error's internal details (for example a driver error message) in the response body.

#### Scenario: Readiness succeeds while the database answers

- GIVEN the database connection is established and responds to a ping
- WHEN a client sends `GET /ready`
- THEN the response status is `200`
- AND the response body is `{ data: { status: 'ok' } }`
- AND the response carries a request id header

#### Scenario: Readiness reports not-ready through the standard error envelope

- GIVEN the injected database check rejects (for example `connection refused`)
- WHEN a client sends `GET /ready`
- THEN the response status is `500`
- AND the response body is exactly `{ error: { code: 'INTERNAL', message: 'Database not ready' } }`
- AND no additional internal error detail is present in the body

### Requirement: Platform routes are documented, anonymous, and excluded from the OpenAPI catalog

The system MUST record `GET /health` and `GET /ready` as public (no authentication required) rows in the permission-matrix fixture, following the established precedent for other platform-level routes, so the existing fail-closed permission/drift check continues to pass with both routes mounted.

The system MUST NOT include `/health` or `/ready` in the generated OpenAPI operation catalog, which documents `/api/*` operations only.

Both routes MUST be mounted before the `notFound` middleware so that an unmatched sub-path under either route (for example `/ready/now`) still falls through to the standard 404 envelope rather than any platform-specific response.

#### Scenario: Permission matrix includes both platform routes

- GIVEN `/health` and `/ready` are mounted in the `test` environment
- WHEN the permission/drift check runs
- THEN it does not fail due to an undocumented or unexpected route, because the matrix fixture includes explicit public-access rows for both

#### Scenario: An unmatched platform sub-path is the standard 404

- GIVEN the application is running
- WHEN a client sends `GET /ready/now`
- THEN the response status is `404`
- AND the response body is `{ error: { code: 'NOT_FOUND', message: 'Route not found' } }`

#### Scenario: Platform routes are absent from the OpenAPI document

- GIVEN the generated OpenAPI document
- WHEN its set of documented (method, path) operations is inspected
- THEN neither `/health` nor `/ready` appears among them

### Requirement: Production boot refuses to serve on an un-migrated database

In `production` only, after the database connection is established and before the HTTP server starts listening, the system MUST check whether migration `M001-normalize-email` is recorded as applied in the migrations ledger. If it is not recorded as applied, the system MUST log a fatal, actionable message naming `M001-normalize-email` and the command `pnpm migrate up`, and MUST exit the process with a non-zero exit code without starting to listen.

This guard MUST NOT run in `development` or `test` environments, and MUST NOT require any migration other than `M001-normalize-email` to be applied.

#### Scenario: A production boot without M001 refuses to serve

- GIVEN `NODE_ENV=production` and a database where `M001-normalize-email` is not recorded as applied
- WHEN the server process boots
- THEN the process exits with a non-zero code before listening
- AND its output contains a message naming `M001-normalize-email is not applied`
- AND its output contains `pnpm migrate up`
- AND its output does not contain a "server listening" message

#### Scenario: A production boot after `migrate up` serves normally

- GIVEN `NODE_ENV=production` and `pnpm migrate up` has been run against the target database (recording `M001-normalize-email` as applied)
- WHEN the server process boots
- THEN the process logs a "server listening" message
- AND `GET /health` on that running instance answers `200` with `{ data: { status: 'ok' } }`

#### Scenario: Non-production boots are unaffected by the guard

- GIVEN `NODE_ENV` is `development` or `test` and `M001-normalize-email` is not recorded as applied
- WHEN the server process boots
- THEN the boot guard does not run and does not prevent the process from listening

### Requirement: Production container image runs as a non-root process with no build tooling

The system MUST provide a multi-stage `Dockerfile` whose final runtime stage: runs as a non-root OS user, contains only production dependencies (no dev dependencies) and the compiled `dist/` output (no TypeScript source), contains no build toolchain (no compiler, no native-addon build tools), and starts the process with a direct exec-form command (`node dist/server.js`) rather than a package-manager script wrapper, so that the process receives `SIGTERM` directly as PID 1 and the existing graceful-shutdown handler runs.

The runtime stage MUST declare a container `HEALTHCHECK` that probes `GET /health` on the configured port, honoring a `PORT` environment variable with a documented default when unset.

#### Scenario: Runtime stage has no dev dependencies or source

- GIVEN the built runtime stage of the production image
- WHEN its `node_modules` and filesystem contents are inspected
- THEN only production dependencies are present
- AND no `src/` TypeScript source directory is present
- AND no build-tool packages (compiler, native-addon toolchain) are present

#### Scenario: Process runs as a non-root user

- GIVEN a running container built from the production image
- WHEN the running process's effective user is inspected
- THEN it is a non-root OS user

#### Scenario: SIGTERM reaches the application directly

- GIVEN a running container built from the production image
- WHEN the container is sent `SIGTERM`
- THEN the Node process (PID 1) receives the signal directly and begins the graceful-shutdown sequence, because the image's entrypoint is the direct `node` exec form rather than a wrapping package-manager script

#### Scenario: Container healthcheck targets the liveness route

- GIVEN the production image's `HEALTHCHECK` instruction
- WHEN it is inspected
- THEN it issues a request to `/health` on the port named by the `PORT` environment variable, or the documented default port when `PORT` is unset

### Requirement: Local development compose stack is dev-only and gates on database health

The system MUST provide a `docker-compose.yml` for local development only (not a production deployment template) defining an application service built from the repository and a MongoDB service with a pinned major version, a named persistent volume, and its own healthcheck.

The application service MUST start only once the database service reports healthy (`depends_on` with a health-based condition), and MUST use placeholder, non-secret configuration values suitable only for local development.

#### Scenario: Compose configuration is structurally valid

- GIVEN the repository's `docker-compose.yml`
- WHEN compose configuration validation is run against it
- THEN it reports no configuration errors

#### Scenario: Application service waits on database health

- GIVEN the compose stack definition
- WHEN the application service's startup dependency is inspected
- THEN it depends on the database service reaching a healthy state before starting

#### Scenario: No real secrets are committed in the compose file

- GIVEN the compose file's environment values for the application service
- WHEN they are inspected
- THEN every credential-shaped value is a placeholder, not a production credential

### Requirement: CI validates the production image and the local stack without publishing anything

The system MUST run a continuous-integration job that builds the production runtime image from the repository's `Dockerfile`, validates the compose configuration, builds the development compose target, starts the local stack, and confirms the running stack answers on the liveness route, without pushing any built image to a registry and without using any deployment credential or secret.

#### Scenario: CI builds the production image and it succeeds

- GIVEN a CI run on a commit that includes the `Dockerfile`
- WHEN the docker validation job runs
- THEN building the production runtime target completes successfully

#### Scenario: CI confirms the local stack is reachable on its liveness route

- GIVEN the docker validation job has started the local compose stack
- WHEN the job polls the published port's `/health` path
- THEN it receives a successful response before the job's timeout elapses

#### Scenario: CI performs no registry push and uses no deployment secret

- GIVEN the docker validation job's steps
- WHEN they are inspected
- THEN no step pushes an image to a registry
- AND no step consumes a deployment or registry credential
