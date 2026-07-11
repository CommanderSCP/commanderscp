---
---

M8 (Hardening, Packaging & Release Candidate): no bump for `@scp/plugin-api` or `@scp/sdk` — their
public surfaces are unchanged in this milestone (confirmed via `git diff` against `main`). Every
change lands in private, internally-versioned packages (`apps/server`, `deploy/helm`,
`deploy/airgap`, `tools/*`) and the overall platform version, bumped by hand to `1.0.0-rc.0` in
the root `package.json` and `deploy/helm/Chart.yaml` (`version`/`appVersion`) — see CHANGELOG.md
for the full M8 summary. This empty changeset exists only to satisfy `pnpm changeset status`
(which flags "packages changed, no changeset found" against ANY workspace package, not just the
two independently-semver'd ones) with an explicit, documented "no release needed here" marker
rather than silently ignoring the check.
