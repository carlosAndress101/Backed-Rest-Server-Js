# Proposal: M10 CI/CD

## Intent

ROADMAP M10's goal is "automated gates and delivery". After 3.2.0 (M9), the service has a production Dockerfile, `/health`/`/ready` endpoints, and a basic CI workflow (format, lint, typecheck, build, test, audit, docker smoke test). What is missing is the full delivery pipeline: security gates (CodeQL, dependency review, actionlint), conventional PR title enforcement, dependency update automation (Renovate), a release workflow that builds and publishes Docker images to GHCR on version tags, and GitHub Releases extracted from the hand-curated CHANGELOG.

The deployment target is Dokploy, managed manually from its UI. No GitHub Actions automation to Dokploy is in scope.

## Scope

### In Scope
1. **Security gates.** CodeQL analysis (JS/TS, on PR, push to master, weekly), dependency review (PR-only, fail on high+), actionlint (validate all workflow files).
2. **Conventional PR titles.** `amannn/action-semantic-pull-request` enforcing allowed types (feat, fix, docs, chore, ci, test, refactor, build, perf). No release-please, no automatic CHANGELOG generation.
3. **Renovate.** npm + GitHub Actions updates, weekly, grouped minor/patch, separate majors, `minimumReleaseAge: "1 day"`, no automerge.
4. **Release pipeline.** On `v*.*.*` tag push: verify (reuse CI), validate tag matches `package.json`, build Docker `runtime` target, push to GHCR with semver + latest + sha tags, provenance + SBOM, create GitHub Release from CHANGELOG section.
5. **Documentation.** README "Releasing and Deploying" section, ADR-054…057, TECH_DEBT OPS-03 closure, ROADMAP M10 update, CHANGELOG `[Unreleased]` M10 section, branch protection documentation.
6. **Spec.** A `delivery-pipeline` spec covering CI, security gates, PR title validation, Renovate, Docker image publishing, GHCR, semantic versioning, GitHub Releases, and manual Dokploy deployment boundary.

### Out of Scope
- Dokploy API integration, `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_APPLICATION_ID`.
- GitHub Action for automatic Dokploy deployment.
- Dokploy production secrets in GitHub.
- Release-please or automatic CHANGELOG generation.
- Any change to the application code, modules, or existing tests.

## Capabilities

### New Capabilities
- `delivery-pipeline`: the permanent spec describing CI, security gates, PR validation, Renovate, GHCR publishing, GitHub Releases, and manual Dokploy deployment.

### Modified Capabilities
- None. No application code or existing spec changes.

## Approach

Four implementation slices on `feat/m10-ci-cd` as chained commits:

1. **S1 — Security gates.** `codeql.yml`, dependency-review job in `ci.yml`, actionlint job in `ci.yml`.
2. **S2 — Conventional PR titles.** `pr-title.yml`.
3. **S3 — Renovate.** `renovate.json`.
4. **S4 — Release pipeline.** `release.yml` (verify, version validation, GHCR push, GitHub Release).

Followed by documentation updates (README, ADRs, TECH_DEBT, ROADMAP, CHANGELOG) and full verification.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `.github/workflows/codeql.yml` | New | CodeQL security analysis |
| `.github/workflows/ci.yml` | Modified | Add dependency-review and actionlint jobs |
| `.github/workflows/pr-title.yml` | New | Conventional PR title enforcement |
| `.github/workflows/release.yml` | New | Release pipeline (verify, GHCR, GitHub Release) |
| `renovate.json` | New | Dependency update automation config |
| `openspec/changes/m10-ci-cd/` | New | proposal, design, tasks |
| `openspec/specs/delivery-pipeline/spec.md` | New | Permanent delivery pipeline spec |
| `README.md` | Modified | "Releasing and Deploying" section |
| `ARCHITECTURE.md` | Modified | ADR-054…057 |
| `TECH_DEBT.md` | Modified | OPS-03 closure |
| `ROADMAP.md` | Modified | M10 outcome |
| `CHANGELOG.md` | Modified | [Unreleased] M10 section |
