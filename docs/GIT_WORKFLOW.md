# Git workflow: branches, pull requests, releases and tags

This guide covers how a change gets from a branch to production, step by step, with the exact commands.

## 1. Branches

| Branch | Purpose |
|---|---|
| `master` | Production. Only receives what is being released. Release tags are created here. |
| `next` | Integration. Every change lands here first. |
| `feat/…`, `fix/…`, `docs/…`, `ci/…` | One branch per change, cut from `next`. |

```
feat/x ──PR──▶ next ──release commit──▶ promotion PR ──▶ master ──tag vX.Y.Z──▶ release.yml ──▶ GHCR ──▶ Dokploy (manual)
```

## 2. Make a change and open a pull request to `next`

```bash
git checkout next
git pull --ff-only origin next          # bring next up to date
git checkout -b fix/my-change           # new branch from next

# … edit …
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm test:coverage && pnpm audit --prod

git add <files>
git commit -m "fix(scope): what changed"
git push -u origin fix/my-change

gh pr create --base next --head fix/my-change \
  --title "fix(scope): what changed" --body "What and why"
```

- Commit messages **and the PR title** follow Conventional Commits: `feat`, `fix`, `docs`, `chore`, `ci`, `test`, `refactor`, `build`, `perf`. The *Validate PR title* check enforces the title.
- Wait for green checks: `gh pr checks <number> --watch`.
- Merge with a merge commit, not squash: `gh pr merge <number> --merge`, or the **Merge pull request** button.

## 3. Prepare the release (version commit on `next`)

```bash
git checkout next && git pull --ff-only origin next
```

Edit these four files:

| File | Change |
|---|---|
| `package.json` | `"version": "X.Y.Z"` |
| `src/docs/openapi.ts` | `API_VERSION = 'X.Y.Z'`. Must equal `package.json`; a test enforces it. |
| `CHANGELOG.md` | `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`. The release fails if this section is missing or empty. |
| `ROADMAP.md` | Header line (latest release). |

Which number to bump (SemVer, ADR-024):

- **PATCH** (`3.2.2`): a fix with no client-visible change.
- **MINOR** (`3.3.0`): something new that breaks nothing.
- **MAJOR** (`4.0.0`): a breaking change for API clients.

```bash
pnpm test                               # the version test must pass
git add package.json src/docs/openapi.ts CHANGELOG.md ROADMAP.md
git commit -m "chore(release): X.Y.Z"
git push origin next
```

## 4. Promote `next` to `master` (promotion PR)

```bash
gh pr create --base master --head next --title "chore(release): X.Y.Z" --body "Promotes next to master for X.Y.Z"
gh pr checks <number> --watch           # CodeQL runs here (it only runs for master)
gh pr merge <number> --merge
```

## 5. Create the tag (this triggers the release)

```bash
git checkout master
git pull --ff-only origin master
grep '"version"' package.json           # must say X.Y.Z
git tag -a vX.Y.Z -m "release: vX.Y.Z"  # annotated tag, with the "v" prefix
git push origin vX.Y.Z
```

Pushing the tag runs `release.yml`:

1. Validates that the tag equals `package.json` `version` and that the `[X.Y.Z]` CHANGELOG section exists.
2. Runs the full CI.
3. Builds the `runtime` image for `linux/amd64` and `linux/arm64`.
4. Pushes it to `ghcr.io/carlosandress101/backed-rest-server-js` with SBOM and provenance. The tags are `X.Y.Z`, `X.Y`, `latest` and `sha-<short>`.
5. Creates the GitHub Release with the CHANGELOG section as notes.

Follow it with `gh run watch`, or in the repository's **Actions** tab.

Tag rules:

- One tag per version.
- Never move or delete a published tag.
- If a release is wrong, fix it and ship the next PATCH.
- Never use `git push --force`.

## 6. Realign `next` with `master`

```bash
git checkout next
git merge --ff-only origin/master
git push origin next
```

## 7. Deploy

In Dokploy (Provider **Docker**), set the image to `ghcr.io/carlosandress101/backed-rest-server-js:X.Y.Z` and press **Deploy**. Never use `latest`. Then check:

```bash
curl -i https://<your-domain>/health    # 200
curl -i https://<your-domain>/ready     # 200 (database reachable)
```

Rollback: select the previous known-good `X.Y.Z` tag in Dokploy and deploy it. Images before `3.2.2` are `linux/amd64` only.

## Useful commands

| Task | Command |
|---|---|
| See which branch you are on and what changed | `git status` |
| History with branches and tags | `git log --oneline --decorate -15` |
| List tags | `git tag --list 'v*' --sort=-v:refname` |
| See an open PR and its checks | `gh pr view <number>` / `gh pr checks <number>` |
| Latest release runs | `gh run list --workflow release.yml --limit 5` |
| Published releases | `gh release list` |
