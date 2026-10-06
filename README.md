# Backed REST Server

A REST API for a small catalog: user accounts and sign-in (password or Google), categories, products, a search
across them, and product and user images stored on Cloudinary. It is written in TypeScript on Express 5 and MongoDB,
and serves the 3.x contract: JSON envelopes (`{ data }`, `{ data, meta }`, `{ error }`), Bearer tokens and role-based
access. The full API description is served at `/docs`.

## Quick path

1. Install Node 24 (see `.nvmrc`), pnpm 12 (`corepack enable`), and MongoDB 4.4 or later.
2. `pnpm install`
3. `cp .env.example .env`, then fill `MONGO_CLOUD`, `SECRET_KEY`, `GOOGLE_CLIENT_ID` and `CLOUDINARY_URL`.
4. `pnpm build`, then `pnpm migrate up` (and `pnpm seed` with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` set, for
   the first administrator).
5. `pnpm dev`, then open <http://localhost:1500/docs>.

## Curl quick start

Sign up, log in to get a token, then make an authenticated call:

```sh
curl -s -X POST http://localhost:1500/api/user \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-1"}'

TOKEN=$(curl -s -X POST http://localhost:1500/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct-horse-1"}' |
  node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).data.token')

curl -s -X POST http://localhost:1500/api/category \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Keyboards"}'
```

## API reference

- [`/docs`](http://localhost:1500/docs): the interactive reference (Redoc), when `DOCS_ENABLED` is on.
- [`/docs/openapi.json`](http://localhost:1500/docs/openapi.json): the OpenAPI 3.1 document, generated from the
  request schemas the routes validate with.
- [`api.http`](api.http): one ready-to-run request per operation, for the VS Code REST Client or JetBrains HTTP
  Client.
- [`ERROR_CODES.md`](ERROR_CODES.md): the error envelope, every error code and when it is returned.
- [`API_PROGRESS.md`](API_PROGRESS.md): the route ledger and the permission matrix.

## Environment

Every variable is read once at boot and validated; an invalid value stops the process with a message naming it. An
empty value (`FOO=`) counts as unset.

| Variable              | Required        | Default                      | Purpose                                                                                                  |
| --------------------- | --------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | no              | `development`                | `development`, `test` or `production`.                                                                   |
| `PORT`                | no              | `1500`                       | The HTTP port.                                                                                           |
| `LOG_LEVEL`           | no              | `info` (`silent` under test) | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                          |
| `MONGO_CLOUD`         | yes             | —                            | The MongoDB URI (`mongodb://` or `mongodb+srv://`).                                                      |
| `SECRET_KEY`          | yes             | —                            | The JWT signing secret, at least 32 characters (for example `openssl rand -base64 48`).                  |
| `JWT_TTL`             | no              | `4h`                         | The session length: seconds, or `<n>s`, `<n>m`, `<n>h`, `<n>d`.                                          |
| `BCRYPT_COST`         | no              | `10`                         | The bcrypt cost of new password hashes, 10 to 14.                                                        |
| `GOOGLE_CLIENT_ID`    | yes             | —                            | The Google OAuth client id that Google ID tokens must be issued for.                                     |
| `CLOUDINARY_URL`      | yes             | —                            | `cloudinary://<api_key>:<api_secret>@<cloud_name>`, for images.                                          |
| `CORS_ORIGINS`        | no              | any origin                   | A comma-separated list of allowed origins; empty or `*` allows any.                                      |
| `TRUST_PROXY`         | no              | none                         | The number of reverse proxies in front of the app, so the client IP (and the login rate limit) is right. |
| `DOCS_ENABLED`        | no              | see below                    | `true` or `false`: serve `/docs` and `/docs/openapi.json`.                                               |
| `SEED_ADMIN_EMAIL`    | for `pnpm seed` | —                            | The first administrator `pnpm seed` creates when no active one exists.                                   |
| `SEED_ADMIN_PASSWORD` | for `pnpm seed` | —                            | That administrator's password (8 characters to 72 bytes). Never logged.                                  |

`DOCS_ENABLED` accepts exactly `true` or `false`; anything else stops the boot.

| `DOCS_ENABLED` | development | test | production                 |
| -------------- | ----------- | ---- | -------------------------- |
| unset or empty | on          | on   | off                        |
| `true`         | on          | on   | on, with a warning at boot |
| `false`        | off         | off  | off                        |

When it is off, `/docs` and `/docs/openapi.json` answer the standard 404.

## Scripts

| Script               | What it does                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Runs `src/server.ts` with reload on change, reading `.env`.                                                                |
| `pnpm build`         | Compiles `src/` to `dist/`.                                                                                                |
| `pnpm start`         | Runs the compiled server (`dist/server.js`), reading `.env`.                                                               |
| `pnpm migrate`       | Database migrations from `dist/`: `pnpm migrate up`, `pnpm migrate down` (both accept `--dry-run`), `pnpm migrate status`. |
| `pnpm seed`          | Creates the first administrator from `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`, when none is active.                    |
| `pnpm typecheck`     | Type-checks `src/` and `tests/`.                                                                                           |
| `pnpm lint`          | ESLint, including the layer import rules; no warnings allowed.                                                             |
| `pnpm format`        | Formats the repository with Prettier.                                                                                      |
| `pnpm format:check`  | Checks the formatting without changing files.                                                                              |
| `pnpm test`          | Runs every test once.                                                                                                      |
| `pnpm test:watch`    | Runs the tests in watch mode.                                                                                              |
| `pnpm test:coverage` | Runs every test with coverage and enforces the coverage gates.                                                             |

## Architecture

- Feature modules under `src/modules/` (auth, users, categories, products, search, media), each split into routes,
  controller and service, plus a model and zod schemas where the module owns data or input.
- Cross-cutting code in `src/core/`, `src/middlewares/` and `src/database/`; `src/app.ts` composes everything and
  `src/server.ts` starts it.
- Requests are validated with zod schemas; the same schemas generate the OpenAPI document in `src/docs/`.
- Every response uses one envelope, and every route's access rule is in one permission matrix.
- Layer boundaries are enforced by lint rules.

The details live in [`ARCHITECTURE.md`](ARCHITECTURE.md) (the target layout and layer rules are §2, the decision log
is §3) and [`API_PROGRESS.md`](API_PROGRESS.md). Planning and history: [`ROADMAP.md`](ROADMAP.md),
[`TECH_DEBT.md`](TECH_DEBT.md) and [`CHANGELOG.md`](CHANGELOG.md).

## Manual Google sign-in

`POST /api/auth/google` takes `{ "id_token": "<token>" }`. The token must be a Google ID token issued for
`GOOGLE_CLIENT_ID`, for an account with a verified email. One way to get one by hand:

1. In the Google Cloud console, open the OAuth client that `GOOGLE_CLIENT_ID` names and add
   `https://developers.google.com/oauthplayground` as an authorized redirect URI.
2. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), and in its settings choose "Use your
   own OAuth credentials" with that client's id and secret.
3. Authorize the `openid`, `email` and `profile` scopes, then exchange the authorization code for tokens.
4. Copy `id_token` from the response and send it within its lifetime (one hour).

## Tests

- `pnpm test` runs the whole suite. Integration tests start an in-memory MongoDB (mongodb-memory-server), so no
  database needs to be running; each test file gets its own database.
- `pnpm test:coverage` enforces a per-file floor of 90 % lines, 90 % functions, 80 % branches and 90 % statements, and
  80 % for the whole of `src/`. `src/server.ts` runs in a spawned process and is excluded.
- No `vi.mock`: tests inject fakes through each module's factory, or spy on the shared instance the code uses. A lint
  rule enforces it.

## Production checklist

Deploy the container (`Dockerfile`), not a dev process: PID 1 must be `node dist/server.js` so SIGTERM reaches
the graceful shutdown (running `pnpm start` as PID 1 skips it, OPS-04). Before the first serve:

- `SECRET_KEY`: at least 32 characters, never committed, unique per environment.
- `MONGO_CLOUD`: the production database, reachable from the container.
- `pnpm migrate up`: run to completion before serving (a production boot without `M001-normalize-email` exits 1,
  OPS-05). Migrations also build the indexes (`autoIndex` is off in production).
- `CORS_ORIGINS`: an explicit allowlist, never `*` (the boot only warns).
- `TRUST_PROXY`: the real reverse-proxy hop count, so the login rate limit keys on client IPs. Unset keeps
  `req.ip` as the socket address.
- `DOCS_ENABLED`: leave unset (stays off in production). `NODE_ENV=production`.
- `pnpm seed`: only to create the first admin on a fresh database, never on boot.
- Reused 2.x databases: review rogue admins and tampered `image` values (M1 T1.6) before migrating.
- Health: liveness `GET /health`, readiness `GET /ready` (200 when the database pings, otherwise 500).

## Releasing and Deploying

The delivery pipeline goes from pull request to production-ready artifact in GHCR. Production deployment
is manual through Dokploy's UI.

### 1. Pull request

Open a PR targeting `master`. The CI pipeline runs automatically:

- **verify**: format, lint, typecheck, build, test, audit
- **docker**: production image build and compose smoke test
- **dependency-review**: fails on high-severity vulnerabilities (PR only)
- **actionlint**: validates all workflow files
- **pr-title**: enforces conventional commit format (`feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`, `build`, `perf`)
- **CodeQL**: static security analysis (also runs weekly)

All checks must pass before merge.

### 2. Merge and version

Once the PR is merged to `master`, prepare the release:

1. Update `CHANGELOG.md` with a `[X.Y.Z]` section (hand-curated, no automatic generation).
2. Bump `version` in `package.json` to match.
3. Commit: `chore(release): X.Y.Z`.
4. Tag: `git tag vX.Y.Z`.

### 3. GitHub Actions release pipeline

Pushing the tag triggers the release workflow:

1. **Verify**: reuses the full CI pipeline.
2. **Version validation**: compares the tag with `package.json` — mismatch fails the release.
3. **CHANGELOG validation**: checks that `CHANGELOG.md` contains a `[X.Y.Z]` section — missing fails the release.
4. **Docker build**: builds the `runtime` target from the existing `Dockerfile`.
5. **GHCR push**: publishes to `ghcr.io/carlosandress101/backed-rest-server-js` with tags:
   - `X.Y.Z` — exact version (primary production reference)
   - `X.Y` — minor floating tag
   - `latest` — convenience, not recommended for production
   - `sha-<short>` — commit-pinned
6. **GitHub Release**: created from the `[X.Y.Z]` CHANGELOG section.

### 4. Dokploy manual deploy

Dokploy is configured manually through its UI. Point it at the versioned GHCR image:

```
ghcr.io/carlosandress101/backed-rest-server-js:3.2.1
```

Before the first serve, run migrations:

```bash
pnpm migrate up
```

The M9 production boot guard (`OPS-05`) refuses to serve until `M001-normalize-email` is recorded.

Healthcheck endpoints:
- **Liveness**: `GET /health` (always 200 when the process serves)
- **Readiness**: `GET /ready` (200 when the database pings, 500 otherwise)

### 5. Rollback

To roll back, select the previous version tag in Dokploy (e.g. `3.2.0` instead of `3.2.1`).
Dokploy pulls and runs the older image. Run `pnpm migrate down` before reverting if the release
included migrations.
