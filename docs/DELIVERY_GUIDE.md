# From code to production: how this API is built, checked, released and deployed

This API ships with a pipeline you can reuse for any Node.js service:

- every pull request is checked automatically;
- a git tag publishes a verified, multi-architecture Docker image to GHCR;
- Dokploy runs that exact image.

This guide explains each piece, why it exists, and what to watch out for. The day-to-day git commands are in [GIT_WORKFLOW.md](GIT_WORKFLOW.md).

## Quick path: the whole flow

```
branch ─▶ PR to next ─▶ CI checks ─▶ merge ─▶ release commit ─▶ PR next→master (+CodeQL) ─▶ merge
       ─▶ tag vX.Y.Z ─▶ release.yml ─▶ GHCR image (amd64+arm64, SBOM, provenance) + GitHub Release
       ─▶ Dokploy: pick :X.Y.Z ─▶ Deploy ─▶ /health + /ready = 200
```

| Stage | Where it lives | What it guarantees |
|---|---|---|
| App readiness | `src/config`, `src/platform/health.ts`, `src/server.ts` | The app fails fast on bad config, reports liveness and readiness, and shuts down cleanly. |
| Container | `Dockerfile`, `.dockerignore` | A small, non-root, production-only image. |
| Pull-request checks | `.github/workflows/ci.yml`, `codeql.yml`, `pr-title.yml` | Nothing broken, insecure or badly named reaches `next`/`master`. |
| Dependency updates | `renovate.json` | Updates arrive as PRs, never same-day releases. |
| Release | `.github/workflows/release.yml` | A tag becomes an immutable image plus release notes. |
| Deploy | Dokploy (UI) | Production runs a pinned version, and rollback is one click. |

---

## 1. Make the app deployable (before any CI)

A pipeline cannot fix an app that is not ready for containers. These came first:

| Capability | How it is done here | Why it matters |
|---|---|---|
| Validated config | `src/config/env.ts`: a zod schema over `process.env`; the boot stops on any invalid variable. | A typo in production fails loudly at boot, not at the first request. |
| Liveness probe | `GET /health` returns `200 {"data":{"status":"ok"}}` and never touches the database. | Tells the platform the process is alive. |
| Readiness probe | `GET /ready` pings MongoDB: 200 when reachable, 500 otherwise. | Tells you the app can actually serve. |
| Graceful shutdown | SIGTERM/SIGINT → close the server → disconnect the DB → exit (10 s hard timeout). | Deploys and restarts do not cut requests mid-flight. |
| Migration guard | In production, the boot refuses to serve until migration `M001` is applied. | Prevents running new code on an old database shape. |
| Logs to stdout | Structured logger, no files. | The platform (Dokploy) collects them. |

**Keep in mind:** in production the process reads only environment variables. Never ship a `.env` file inside the image (`.dockerignore` excludes `.env*`).

## 2. The Docker image (`Dockerfile`)

The Dockerfile has three stages, so the final image contains only what runs:

1. **deps**: installs **production** dependencies. It has build tools (`python3 make g++`) because `bcrypt` compiles a native addon.
2. **build**: does a full install (dev dependencies included) and runs `pnpm build`, which compiles TypeScript to `dist/`.
3. **runtime**: a clean `node:24-alpine` image with only `package.json`, the production `node_modules` and `dist/`. It runs as `USER node` (not root), has a `HEALTHCHECK` on `/health`, and its command is `CMD ["node", "dist/server.js"]`.

**Keep in mind:**

- **Copy every file the package manager reads.** Here that is `package.json`, `pnpm-lock.yaml` **and `pnpm-workspace.yaml`**: it holds `allowBuilds: bcrypt: true`, and without it the native build is skipped.
- **Start Node directly**, not through `pnpm start`. Node is then PID 1 and receives SIGTERM, so graceful shutdown works.
- **Install build tools in every stage that may compile** native addons, but never in the runtime stage.
- `docker-compose.yml` is **for local development only**: it builds the `build` target, because the runtime stage has no dev tools. It is never a production template.

## 3. Pull-request checks (`.github/workflows/ci.yml`)

These run on every PR and on every push to `master`.

| Job | What it runs | Fails when |
|---|---|---|
| `verify` | `pnpm install --frozen-lockfile`, then `format:check`, `lint`, `typecheck`, `build`, `test:coverage`, `audit --prod` | Any check fails, coverage drops below its threshold, or a production dependency has a known vulnerability. |
| `docker` | Builds the production image (amd64 and **arm64**), loads `bcrypt` on arm64, boots the compose stack, then `curl /health` | The image does not build or does not start. |
| `dependency-review` | Inspects dependencies added by the PR (PRs only). | A new dependency has a high-severity vulnerability. |
| `actionlint` | Lints every workflow file; the binary is verified by SHA-256 before it runs. | A workflow has a syntax or logic error. |

Other workflows:

- **`codeql.yml`**: static security analysis on PRs to `master`, on pushes to `master` and weekly. It ignores `docs/diagrams` (generated files).
- **`pr-title.yml`**: the PR title must be a Conventional Commit (`feat:`, `fix:`, `docs:`…).

**How it was made safe.** Copy these patterns:

- **`permissions: contents: read`** at the top, with more only on the job that needs it. A compromised step cannot push code.
- **Every external action pinned to a full commit SHA**, with the version in a comment (`uses: actions/checkout@9c091bb… # v7.0.0`). A tag can be moved by an attacker; a SHA cannot.
- **`persist-credentials: false`** on checkout. The git token is not left on disk for later steps.
- **`concurrency` with `cancel-in-progress` only for PRs.** New pushes to a PR cancel stale runs, but a run on `master` always finishes.
- **`workflow_call`**: `ci.yml` is reusable, so the release runs **the same checks** instead of a copy that drifts.
- **Smoke tests that survive real startup.** Use `curl --retry-all-errors`, print logs on failure, and always clean up with `if: always()`.

## 4. Dependency updates (`renovate.json`)

- Renovate opens PRs weekly ("before 6am on monday"). Minor and patch updates are grouped; majors come one by one.
- **`minimumReleaseAge: 1 day`**: a version must be at least 24 h old. Brand-new releases are where compromised packages hide (ADR-025).
- GitHub Actions updates keep the SHA pins (`pinDigests`). Nothing merges automatically.
- **Setup:** install the **Renovate GitHub App** on the repository once.

## 5. The release (`.github/workflows/release.yml`)

It is triggered by pushing a tag `vX.Y.Z` on `master`, and runs these steps in order:

1. **Verify**: reuses `ci.yml` in full.
2. **Validate version**: the tag must equal `package.json` `version`, or the release stops.
3. **Extract release notes**: takes the `[X.Y.Z]` section of `CHANGELOG.md`. It **fails closed** if the section is missing, duplicated or empty.
4. **QEMU and Buildx**: build for **`linux/amd64` and `linux/arm64`**, so one tag runs on Intel/AMD and ARM servers.
5. **Log in to GHCR** with the built-in `GITHUB_TOKEN`. No personal token or external secret is needed.
6. **Metadata and tags**: `X.Y.Z` (production reference), `X.Y`, `latest`, `sha-<commit>`.
7. **Build and push**: `target: runtime`, `provenance: true`, `sbom: true`. The image carries a bill of materials and proof of where it was built.
8. **GitHub Release**: created with the CHANGELOG section as its notes.

Required job permissions: `contents: write` (release), `packages: write` (GHCR), `attestations: write` and `id-token: write` (provenance).

**Keep in mind:**

- Before tagging, the release commit must bump **`package.json` and `API_VERSION` together**: a test ties them. It must also cut the CHANGELOG. See [GIT_WORKFLOW.md](GIT_WORKFLOW.md#3-prepare-the-release-version-commit-on-next).
- After the first release, check that the **GHCR package is public** (or give Dokploy registry credentials).
- **Never move or delete a published tag.** If a release is wrong, ship the next PATCH.

## 6. Deploying with Dokploy

| Setting | Value | Note |
|---|---|---|
| Provider | **Docker** (not GitHub or Nixpacks) | Runs the image the pipeline built and verified, instead of rebuilding from source. |
| Docker Image | `ghcr.io/carlosandress101/backed-rest-server-js:X.Y.Z` | Always an exact version, **never `latest`**. |
| Registry, user, password | empty | The package is public. |
| Domains | host + **Container Port `1500`**, HTTPS with Let's Encrypt | The DNS `A` record must point to the server first. |
| Environment | `MONGO_CLOUD`, `SECRET_KEY` (32+ chars, new for production), `GOOGLE_CLIENT_ID`, `CLOUDINARY_URL`, `CORS_ORIGINS`, `TRUST_PROXY` | `NODE_ENV=production` comes from the image. |
| Advanced → Command (first deploy only) | `sh -c "node dist/cli.js migrate up && node dist/server.js"` | Applies migrations once; remove it afterwards. |

**Keep in mind:**

- **`TRUST_PROXY` = the number of proxies in front of the app.** It is `1` with Dokploy's Traefik alone, and **`2` with Cloudflare + Traefik**. A wrong value makes the login rate limiter treat every user as one client.
- **`CORS_ORIGINS`**: the real frontend origin(s). `*` lets any website call the API from a browser.
- **`DOCS_ENABLED`**: leave it unset in production unless you want `/docs` public.
- **MongoDB Atlas**: add the server's public IP under **Network Access** (`<ip>/32`), or the app cannot connect.
- **Verify** after every deploy: `/health` and `/ready` must return 200.
- **Rollback**: select the previous `X.Y.Z` tag and deploy. Images before `3.2.2` are amd64 only.

## 7. Problems we hit, and their fixes

| Symptom | Cause | Fix |
|---|---|---|
| Dokploy: `no matching manifest for linux/arm64/v8` | The image was built for amd64 only; the server is ARM. | QEMU + `platforms: linux/amd64,linux/arm64` in the release; CI builds arm64 too (3.2.2). |
| Compose `api` service did not start | Compose built the `runtime` stage, which has no `pnpm`/dev dependencies. | `build.target: build` in compose. |
| Native `bcrypt` build skipped or failing | `pnpm-workspace.yaml` was not copied; no build tools in the build stage. | Copy it in both install stages, and add `python3 make g++`. |
| CI smoke test failed on the first run | `curl --retry-connrefused` does not retry "connection reset". | `--retry-all-errors`, plus logs on failure. |
| CI only proved the dev image | The compose build skipped the production stages. | An explicit `docker build --target runtime`. |
| CodeQL failed on documentation | Generated HTML viewers contained flagged JavaScript. | `paths-ignore: docs/diagrams` in `codeql.yml`. |
| Release would fail on the tag | The version and CHANGELOG were not bumped. | A `chore(release): X.Y.Z` commit before tagging. |
| App could not reach the database | The Atlas IP allowlist did not include the server. | Add the server IP in Atlas Network Access. |
| `gh pr merge` / push to `master` failed with server errors | A temporary GitHub-side error. | Merge from the web UI or retry later; never force-push. |

## 8. Checklist for your next app

- [ ] Config validated at boot; no `.env` inside the image.
- [ ] `/health` (no dependencies) and `/ready` (checks the database).
- [ ] Graceful shutdown on SIGTERM; `CMD ["node", …]` directly.
- [ ] Multi-stage Dockerfile, non-root runtime, `.dockerignore` with `.env*`, `.git`, `node_modules`.
- [ ] Every config file the package manager reads is copied into the image.
- [ ] CI: verify + docker (amd64 **and** arm64) + dependency review + actionlint + CodeQL + PR title.
- [ ] Actions pinned by SHA, least-privilege `permissions`, `persist-credentials: false`.
- [ ] Release on tags: version check, CHANGELOG notes, multi-arch image, SBOM + provenance.
- [ ] Renovate installed, with a minimum release age.
- [ ] GHCR package public (or registry credentials in the platform).
- [ ] Platform: exact version tag, env vars, port, HTTPS, migrations on first deploy.
- [ ] `TRUST_PROXY` matches the real proxy chain; `CORS_ORIGINS` is explicit.
- [ ] Database firewall allows the server IP.
- [ ] Branch protection on `master`/`next`: PR required, checks required, no force-push.

## Next step

For the exact commands to branch, open PRs, cut a release and push a tag, follow [GIT_WORKFLOW.md](GIT_WORKFLOW.md).
