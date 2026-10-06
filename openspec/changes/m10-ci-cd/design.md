# Design: M10 CI/CD

## Decisions

### D1 — CodeQL runs on PR, push to master, and weekly

CodeQL analyzes JavaScript/TypeScript. It runs on `pull_request` (targeting `master`), `push` to `master`, and on a weekly schedule (`cron: '0 6 * * 1'`). Permissions are minimal: `security-events: write` only in the analyze job, `contents: read` and `actions: read` globally. Actions are pinned by SHA. The `javascript` language is used with `security-extended` query suite for broader coverage.

### D2 — Dependency review is PR-only and fails on high+

`actions/dependency-review-action` runs only on `pull_request`. It is configured to fail on vulnerabilities of severity `high` or above. This prevents merging PRs that introduce known-vulnerable dependencies. Pinned by SHA. Minimal permissions: `contents: read`.

### D3 — Actionlint validates all workflow files

`rhysd/actionlint` (pinned by SHA with version comment) validates every `.yml` file in `.github/workflows/`. This catches YAML syntax errors, invalid action references, expression mistakes, and other workflow issues before they reach GitHub. Runs on PR and push to master, matching CI's trigger pattern.

### D4 — Conventional PR titles enforce quality without automatic releases

`amannn/action-semantic-pull-request` (pinned by SHA) validates PR titles against the allowed types: `feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`, `build`, `perf`. This enforces consistency and enables future tooling without introducing release-please or automatic CHANGELOG generation. The CHANGELOG stays hand-curated (ADR-056).

### D5 — Renovate proposes, never automerges

`renovate.json` configures: npm dependencies + GitHub Actions, weekly schedule, grouped minor/patch updates (one PR), separate PRs for majors, `minimumReleaseAge: "1 day"` (ADR-025 alignment), digest pinning for GitHub Actions, and no automerge. Renovate proposes; humans decide (ADR-057).

### D6 — Release workflow: verify, build, publish, release

Triggered by `push` of tags matching `v*.*.*`. Two jobs:

**Job 1 — verify:** Reuses the existing CI workflow via `workflow_call`. The existing `ci.yml` is refactored to support both `push`/`pull_request` and `workflow_call` triggers. This avoids duplicating CI steps.

**Job 2 — release:** Depends on verify. Steps:
1. **Version validation:** Extract version from tag (`v3.2.1` → `3.2.1`), compare with `package.json` version. Mismatch → fail.
2. **CHANGELOG validation:** Check that `CHANGELOG.md` contains a section for `[3.2.1]`. Missing → fail.
3. **Docker build + GHCR push:** Uses `docker/setup-buildx-action`, `docker/login-action` (GITHUB_TOKEN), `docker/metadata-action` (tags: `3.2.1`, `3.2`, `latest`, `sha-<short>`), `docker/build-push-action` with `--target runtime`, provenance and SBOM enabled.
4. **GitHub Release:** Extract the `[3.2.1]` section from CHANGELOG.md as the release body. Create release via `gh release create` or `softprops/action-gh-release`.

Permissions: `packages: write` (GHCR), `contents: write` (release), `security-events: write` (if needed by verify).

### D7 — GHCR image tags follow semver conventions

For tag `v3.2.1`, publish:
- `3.2.1` — exact version, the primary production reference
- `3.2` — minor floating tag
- `latest` — convenience, not recommended for production
- `sha-abc1234` — commit-pinned

Image: `ghcr.io/carlosandress101/backed-rest-server-js`. The `runtime` Dockerfile target is used (M9 ADR-051).

### D8 — CI workflow supports workflow_call for reuse

The existing `ci.yml` is modified to add `workflow_call` to its trigger list. This allows `release.yml` to call it without duplicating steps. The `verify` and `docker` jobs remain as-is for direct PR/push triggers.

### D9 — Dokploy is manual; documentation only

The release pipeline ends at GHCR. Dokploy consumes a versioned image (e.g. `ghcr.io/carlosandress101/backed-rest-server-js:3.2.1`) configured manually through its UI. Rollback is selecting a previous image tag. No API, no secrets, no automation.

## Alternatives considered

- **Separate verify workflow called by release:** chosen over duplicating steps (DRY, single source of truth for CI gates).
- **release-please for automatic CHANGELOG:** rejected — the CHANGELOG is hand-curated by design (ADR-056). Conventional PR titles enforce quality without automatic generation.
- **Dependabot instead of Renovate:** rejected — Renovate offers more flexible grouping, `minimumReleaseAge`, and digest pinning in a single config file.
- **Docker Hub instead of GHCR:** rejected — GHCR is the natural choice for GitHub-hosted repos, uses `GITHUB_TOKEN` (no extra secrets), and integrates with GitHub's package UI.
- **`latest` as production tag:** rejected — `latest` is a convenience tag, not a deployment reference. Production should pin exact versions.

## Risks

- **workflow_call compatibility:** the existing CI workflow must be refactored cleanly to support both direct triggers and `workflow_call`. If the refactor introduces issues, the release pipeline breaks. Mitigation: test with `act` or a draft tag.
- **CHANGELOG section format:** the release extraction script depends on a consistent `[X.Y.Z]` heading format in CHANGELOG.md. A typo in the heading blocks the release. Mitigation: the validation step fails early with a clear message.
- **GHCR permissions:** `GITHUB_TOKEN` with `packages: write` must be available. This is the default for GitHub Actions in the same repo. Mitigation: documented in the workflow.
