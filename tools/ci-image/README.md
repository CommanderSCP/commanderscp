# tools/ci-image

The versioned CI runner image BUILD_AND_TEST.md §6 calls for: "Required tooling (Node, pnpm
store, Playwright browsers, oasdiff) is baked into a versioned CI runner image built from
`tools/ci-image/Dockerfile`." Not an npm workspace package — a Docker build context (like
`apps/runner-iac`), except this one needs files from outside its own directory (see below).

## What it bakes in

See `Dockerfile`'s own header comment for the full rationale. Summary: Node 22, corepack-pinned
pnpm 10.12.1, a pnpm store pre-warmed from the committed `pnpm-lock.yaml`, Playwright's Chromium +
its Debian OS-level deps (version-matched to the exact `@playwright/test` version resolved in the
lockfile, not just `apps/web/package.json`'s semver range), the Docker CLI + `docker compose` v2
plugin, git, and the vendored `oasdiff` binary from `tools/openapi/bin/`.

## Build

Build context **must be the repo root**, not this directory — the Dockerfile reads the root
`pnpm-lock.yaml` and `tools/openapi/bin/oasdiff-linux-amd64`:

```bash
docker build -f tools/ci-image/Dockerfile -t scp-ci-image:dev .
```

This needs network access (apt, `npx playwright install`) — that's expected; see the Dockerfile's
"IMPORTANT DISTINCTION" comment for why build-time fetching is fine and distinct from the
run-time offline guarantee the built image then provides.

## How CI actually uses it today (honest scope)

`.github/workflows/ci.yml` has two relevant jobs:

- **`ci-image`** — builds this image and hands it to `e2e-web` via a workflow artifact
  (`docker save | gzip` → `actions/upload-artifact` → `actions/download-artifact` → `gunzip |
docker load`), main-branch pushes only.
- **`e2e-web`** — loads the image, then runs `scripts/e2e-web.sh` entirely inside a container
  built from it (Docker-outside-of-Docker via a bind-mounted `/var/run/docker.sock`, plus
  `--network host` so Playwright can reach the compose stack's published port). No `playwright
install` / cache-plus-network-fetch-on-miss step anymore — that's the whole point of this
  change. See the job's own comments in `ci.yml` for the full mechanics.

As of **M9**, this uses **build-once → publish to GHCR → pull** (realizing what earlier notes here
flagged as a follow-up). The `ci-image` job in `ci.yml` tags the image by a content hash of
`tools/ci-image/Dockerfile` + `pnpm-lock.yaml`, pulls `ghcr.io/commanderscp/scp-ci-image:<hash>`,
and rebuilds + pushes **only on a cache miss** (the toolchain or lockfile actually changed); the
`e2e-web` job pulls the same tag. This means:

- the multi-GB image is **rebuilt only on `Dockerfile`/lockfile changes**, not every main push;
- the Chromium download from `cdn.playwright.dev` happens **only on that occasional rebuild** (with
  retries baked into the Dockerfile) — so per-merge CI has **zero external network dependency for
  tooling**, the air-gap posture CLAUDE.md #5 requires;
- the image is reusable across workflow runs (no same-run artifact hand-off) and pinned by tag.

Auth is the workflow's `GITHUB_TOKEN` (the repo is private → the package is private); no extra
secret is needed **as long as the org permits `GITHUB_TOKEN` `packages:write`** — the same GHCR
publish model the homelab uses. If the org restricts that, point the login at a GHCR PAT secret
instead. Still open as a possible future step: let other CI jobs (e.g. the `integration`
Testcontainers suite) run inside this image too, now that it's a pullable artifact.

## Known gaps / follow-ups (tracked, not silently skipped)

- **`tools/openapi/check.sh` is not yet wired into the `codegen-drift` CI job.** The script exists,
  is vendored, and is tested (manual breaking/non-breaking transcript in the PR description that
  introduced it), but wiring it into `.github/workflows/ci.yml`'s `codegen-drift` job (plus giving
  that job enough git history — `fetch-depth: 0` — to resolve a merge base) was scoped out of this
  change; see `tools/openapi/README.md`.
- **Only `linux/amd64` is vendored/tested for `oasdiff`** — matches the self-hosted CI runner
  architecture. A local dev machine on another architecture needs its own vendored binary to run
  `check.sh` directly (or can run it inside a `tools/ci-image` container, which is `linux/amd64`
  regardless of host).
- **The Docker-outside-of-Docker + `--network host` wiring in the `e2e-web` job was verified
  locally** (Docker CLI + `docker compose` from inside a `tools/ci-image` container reaching a
  real host daemon; a fully offline `pnpm install --offline --frozen-lockfile` against the baked
  store under `--network none`; a real Chromium launch under `--network none`) **but not against
  an actual run on the homelab self-hosted runners.** If those runners are container-per-job
  (e.g. Actions Runner Controller pods) rather than plain VMs/hosts, the socket bind-mount and
  `--network host` may need runner-specific adjustment — flagged in the job's own comments too.
- Local development/testing of this Dockerfile was done on `linux/arm64` (the author's machine);
  cross-building for `linux/amd64` locally was not possible in that environment (no `buildx`
  component installed, and the legacy builder mishandles `--platform` for multi-stage `COPY`
  reliably enough to be unusable here). This doesn't affect real CI, which builds natively on
  `linux/amd64` self-hosted runners — no emulation involved there.
