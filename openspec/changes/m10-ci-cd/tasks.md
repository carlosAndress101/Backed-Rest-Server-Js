# M10 — CI/CD

> Branch: `feat/m10-ci-cd` · Base: `master` (3.2.0)
> Conventions: chained commits, conventional messages, no AI attribution, no push/merge/tag.

Slices land as sequential commits. Each slice ends with `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test` where applicable.

---

## S0 — OpenSpec

- [x] 0.1 Create `openspec/changes/m10-ci-cd/proposal.md`.
- [x] 0.2 Create `openspec/changes/m10-ci-cd/design.md`.
- [x] 0.3 Create `openspec/changes/m10-ci-cd/tasks.md`.
- [x] 0.4 Create `openspec/specs/delivery-pipeline/spec.md`.

## S1 — Security Gates

- [x] 1.1 Create `.github/workflows/codeql.yml`: PR + push to master + weekly cron, `javascript` language, `security-extended` query suite, minimal permissions, actions pinned by SHA.
- [x] 1.2 Add `dependency-review` job to `.github/workflows/ci.yml`: PR-only, `actions/dependency-review-action` pinned by SHA (v5.0.0), fail on `high` severity, minimal permissions.
- [x] 1.3 Add `actionlint` job to `.github/workflows/ci.yml`: download script v1.7.12, validates all `.github/workflows/*.yml` files, fails on error.
- [x] 1.4 PR: full `pnpm test` + typecheck/lint/format.

## S2 — Conventional PR Titles

- [x] 2.1 Create `.github/workflows/pr-title.yml`: `amannn/action-semantic-pull-request` pinned by SHA (v6.1.1), allowed types: feat/fix/docs/chore/ci/test/refactor/build/perf, minimal permissions.
- [x] 2.2 PR: full `pnpm test` + typecheck/lint/format.

## S3 — Renovate

- [x] 3.1 Create `renovate.json`: npm + GitHub Actions, weekly, grouped minor/patch, separate majors, `minimumReleaseAge: "1 day"`, digest pinning, no automerge.
- [x] 3.2 PR: full `pnpm test` + typecheck/lint/format.

## S4 — Release Pipeline

- [x] 4.1 Modify `.github/workflows/ci.yml` to support `workflow_call` trigger (add to existing triggers, keep current behavior unchanged).
- [x] 4.2 Create `.github/workflows/release.yml`: trigger on `v*.*.*` tag push, job 1 (verify) calls ci.yml via `workflow_call`, job 2 (release) validates tag vs package.json, validates CHANGELOG section, builds Docker `runtime` target, pushes to GHCR with semver+latest+sha tags, provenance+SBOM, creates GitHub Release from CHANGELOG.
- [x] 4.3 Third-party actions pinned by SHA with version comments. GitHub-owned actions follow project policy.
- [x] 4.4 PR: full `pnpm test` + typecheck/lint/format.

## S5 — Documentation

- [x] 5.1 Update `README.md`: add "Releasing and Deploying" section covering PR → CI → merge → tag → Actions → GHCR → Dokploy manual deploy → healthcheck → rollback.
- [x] 5.2 Update `ARCHITECTURE.md`: ADR-054 (GHCR tag strategy), ADR-055 (GHCR + manual Dokploy), ADR-056 (CHANGELOG + conventional PR titles), ADR-057 (Renovate + minimum release age).
- [x] 5.3 Update `TECH_DEBT.md`: close OPS-03 (image build/push → M10).
- [x] 5.4 Update `ROADMAP.md`: M10 outcome (CI/CD, GHCR, releases, security gates, Renovate, branch protection docs, manual Dokploy).
- [x] 5.5 Update `CHANGELOG.md`: `[Unreleased]` section with M10 additions.
- [x] 5.6 PR: full `pnpm test` + typecheck/lint/format.

## S6 — Full Verification

- [x] 6.1 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm audit --prod` — all exit 0.
- [x] 6.2 Verify no secrets committed, no `.env` files modified, no AI attribution in git log.
- [x] 6.3 Verify release workflow uses `runtime` Docker target.
- [x] 6.4 Verify tag/package.json mismatch blocks release.
- [x] 6.5 Verify `git status` is clean.

## Residuals (documented, not implemented)

- Dokploy API integration (explicitly out of scope).
- Release-please or automatic CHANGELOG generation (CHANGELOG stays hand-curated).
- Shared rate-limiter store for multi-instance (no target, YAGNI).
- SEC-16/17/18, CQ-06 and other open TECH_DEBT items.
