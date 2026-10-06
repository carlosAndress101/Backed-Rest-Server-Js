# Delivery Pipeline Specification

## Purpose

Define the delivery pipeline that takes a code change from pull request to production-ready artifact: CI validation, security gates, PR title enforcement, dependency update automation, Docker image publishing to GHCR, semantic versioning through git tags, GitHub Releases extracted from the hand-curated CHANGELOG, and the manual deployment boundary at Dokploy.

## Requirements

### Requirement: Every pull request passes CI gates before merge

The system MUST run a CI workflow on every pull request and every push to `master` that executes: format check, lint, typecheck, build, test with coverage, and production dependency audit. The workflow MUST cancel a superseded run only on pull requests; a `master` run MUST NOT be canceled once started.

#### Scenario: A pull request passes all CI gates

- GIVEN a pull request targeting `master`
- WHEN the CI workflow runs
- THEN format check, lint, typecheck, build, test, and audit all pass
- AND the workflow reports success

#### Scenario: A master push is never canceled

- GIVEN a push to `master` that triggers the CI workflow
- WHEN another push to `master` arrives before the first run completes
- THEN the first run continues to completion without cancellation

### Requirement: CodeQL analyzes JavaScript and TypeScript on PR, push, and weekly

The system MUST run GitHub CodeQL analysis for the `javascript` language on pull requests targeting `master`, on pushes to `master`, and on a weekly schedule. The analysis MUST use the `security-extended` query suite. Permissions MUST be minimal: `security-events: write` only where needed, `contents: read` and `actions: read` globally.

CodeQL findings are advisory: finding alerts MUST NOT by themselves fail the workflow. The repository owner MAY configure the successful CodeQL workflow check as required through branch protection or rulesets; this repository does not configure those GitHub settings.

#### Scenario: CodeQL runs on a pull request

- GIVEN a pull request targeting `master`
- WHEN the CodeQL workflow triggers
- THEN it analyzes the JavaScript/TypeScript codebase
- AND uploads results to the GitHub Security tab

#### Scenario: CodeQL runs weekly

- GIVEN the weekly cron schedule
- WHEN the scheduled time arrives
- THEN the CodeQL workflow runs and updates the Security tab

### Requirement: Dependency review fails on high-severity vulnerabilities in PRs

The system MUST run `actions/dependency-review-action` on every pull request. It MUST fail the check if any new dependency has a vulnerability of severity `high` or above. It MUST NOT run on pushes to `master` (only on PRs).

#### Scenario: A PR introduces a high-severity vulnerability

- GIVEN a pull request that adds a dependency with a known high-severity vulnerability
- WHEN the dependency review job runs
- THEN the job fails with a message identifying the vulnerable dependency

#### Scenario: A PR with no new vulnerabilities passes

- GIVEN a pull request with no new vulnerable dependencies
- WHEN the dependency review job runs
- THEN the job passes

### Requirement: Actionlint validates all workflow files

The system MUST run `rhysd/actionlint` on every pull request and push to `master` to validate all `.yml` files in `.github/workflows/`. The check MUST fail if any workflow file contains syntax or structural errors.

#### Scenario: A workflow file has a syntax error

- GIVEN a pull request that introduces a YAML syntax error in a workflow file
- WHEN the actionlint job runs
- THEN the job fails with an error identifying the problematic file and line

### Requirement: PR titles follow conventional commit format

The system MUST validate that every pull request title matches the conventional commit format: one of the allowed types (`feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`, `build`, `perf`) followed by an optional scope and colon. The check MUST run on `pull_request_target` events targeting `master` or `next`, and MUST NOT run for pull requests targeting auxiliary branches.

#### Scenario: A PR title is valid

- GIVEN a pull request with title `feat(auth): add rate limiting`
- WHEN the PR title check runs
- THEN the check passes

#### Scenario: A PR title uses a disallowed type

- GIVEN a pull request with title `added new feature`
- WHEN the PR title check runs
- THEN the check fails

### Requirement: Renovate proposes dependency updates weekly without automerge

The system MUST have a `renovate.json` configuration that: monitors npm dependencies and GitHub Actions, runs on a weekly schedule, groups minor and patch updates into a single PR, creates separate PRs for major updates, enforces a `minimumReleaseAge` of 1 day, pins digests for GitHub Actions, and does NOT automerge any updates.

#### Scenario: A minor update is proposed

- GIVEN a npm dependency has a new minor version published more than 1 day ago
- WHEN Renovate runs its weekly schedule
- THEN it creates or updates a PR with the minor version bump
- AND the PR is not automerged

#### Scenario: A major update gets its own PR

- GIVEN a npm dependency has a new major version
- WHEN Renovate runs
- THEN it creates a separate PR for the major update (not grouped with other updates)

### Requirement: Version tags trigger a release pipeline

The system MUST trigger a release workflow when a tag matching `v*.*.*` is pushed. The workflow MUST first run the full CI verification (reusing the CI workflow). If verification fails, the release MUST NOT proceed.

#### Scenario: A version tag triggers the release pipeline

- GIVEN a tag `v3.2.1` is pushed
- WHEN the release workflow triggers
- THEN it first runs the full CI verification
- AND only proceeds to the release job if verification passes

#### Scenario: A failed CI blocks the release

- GIVEN a tag `v3.2.1` is pushed but tests fail
- WHEN the CI verification job fails
- THEN the release job does not run
- AND no Docker image is pushed

### Requirement: Tag version must match package.json version

The release workflow MUST extract the version from the tag (e.g. `v3.2.1` → `3.2.1`) and compare it with the `version` field in `package.json`. If they do not match, the release MUST fail before building or pushing any image.

#### Scenario: Tag matches package.json

- GIVEN tag `v3.2.1` and `package.json` version `3.2.1`
- WHEN the version validation step runs
- THEN it passes

#### Scenario: Tag mismatches package.json

- GIVEN tag `v3.2.1` but `package.json` version `3.2.0`
- WHEN the version validation step runs
- THEN the workflow fails with a clear error message

### Requirement: CHANGELOG must contain a section for the release version

The release workflow MUST locate exactly one `## [X.Y.Z]` version heading matching the tag, extract its content through the next version heading, and trim surrounding whitespace. Missing, duplicate, or empty sections MUST fail the release before publishing.

#### Scenario: CHANGELOG section exists

- GIVEN tag `v3.2.1` and `CHANGELOG.md` contains `## [3.2.1]`
- WHEN the CHANGELOG validation step runs
- THEN it passes

#### Scenario: CHANGELOG section is missing

- GIVEN tag `v3.2.1` but `CHANGELOG.md` has no `[3.2.1]` section
- WHEN the CHANGELOG validation step runs
- THEN the workflow fails

#### Scenario: CHANGELOG section exists but is empty

- GIVEN tag `v3.2.1` and `CHANGELOG.md` contains `## [3.2.1]` followed only by whitespace before the next version heading
- WHEN the release-notes extraction runs
- THEN the workflow fails
- AND no GitHub Release is created

### Requirement: Docker image is built and pushed to GHCR with semver tags

The release workflow MUST build the Docker image using the `runtime` target from the existing `Dockerfile`. It MUST push to `ghcr.io/carlosandress101/backed-rest-server-js` with the following tags for version `v3.2.1`:
- `3.2.1` (exact version, primary production reference)
- `3.2` (minor floating)
- `latest` (convenience, not recommended for production)
- `sha-<short-sha>` (commit-pinned)

The workflow MUST enable provenance and SBOM generation. Login MUST use `GITHUB_TOKEN`.

#### Scenario: Image is pushed with correct tags

- GIVEN a release for `v3.2.1` at commit `abc12345`
- WHEN the Docker build and push step runs
- THEN the image is pushed with tags `3.2.1`, `3.2`, `latest`, and `sha-abc1234`
- AND provenance and SBOM are attached

#### Scenario: Image uses the runtime Dockerfile target

- GIVEN the release workflow
- WHEN the Docker build step runs
- THEN it uses `--target runtime` from the existing Dockerfile

### Requirement: GitHub Release is created from the CHANGELOG

The release workflow MUST create a GitHub Release for the tag. The release body MUST be extracted from the corresponding `[X.Y.Z]` section in `CHANGELOG.md`. If the section is missing, the release MUST NOT be created (validated earlier).

#### Scenario: Release is created with CHANGELOG content

- GIVEN tag `v3.2.1` and a matching CHANGELOG section
- WHEN the GitHub Release step runs
- THEN a release is created at `v3.2.1`
- AND the body contains the content from the `[3.2.1]` CHANGELOG section

### Requirement: Production deployment is manual via Dokploy

The system MUST NOT automate deployment to Dokploy. The pipeline ends at GHCR. Dokploy consumes an immutable version tag (e.g. `ghcr.io/carlosandress101/backed-rest-server-js:3.2.1`) configured manually through its UI; `latest` is not a production reference. Rollback is achieved manually by selecting and deploying a previous known-good image (e.g. `3.2.0`) in Dokploy. No automatic rollback is implemented.

No Dokploy API keys, URLs, or application IDs MUST appear in GitHub secrets or workflow files.

#### Scenario: Production deployment uses a versioned tag

- GIVEN the GHCR image `ghcr.io/carlosandress101/backed-rest-server-js:3.2.1`
- WHEN an operator configures Dokploy to deploy this image
- THEN the service runs the exact version 3.2.1

#### Scenario: Rollback uses a previous tag

- GIVEN production is running `3.2.1` and needs rollback
- WHEN the operator selects `3.2.0` in Dokploy
- THEN Dokploy pulls and runs the `3.2.0` image

### Requirement: Branch protection enforces required checks

The `master` and `next` branches MUST require the following checks to pass before merge: `verify` (CI), `docker`, `actionlint`, `dependency-review`, `CodeQL`, and `pr-title`. CodeQL findings themselves are advisory and MUST NOT fail the workflow; only the successful workflow check may be made required. Force push and branch deletion MUST be prohibited. The actual branch protection configuration is performed by the repository owner in GitHub settings; this requirement documents the expected configuration and is not applied by this repository.

#### Scenario: A PR with failing CI cannot merge

- GIVEN branch protection requiring the `verify` check
- WHEN a PR has a failing `verify` check
- THEN GitHub blocks the merge

### Requirement: Migrations must run before production serve

Before the first production serve, `pnpm migrate up` MUST be run to completion. The M9 production boot guard (`OPS-05`) refuses to serve until `M001-normalize-email` is recorded. The release documentation MUST state this requirement.
