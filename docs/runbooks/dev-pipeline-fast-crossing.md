# Runbook — a fast dev pipeline that still crosses boundaries cleanly

**Applies to:** an org whose engineers iterate on a `dev` branch and occasionally promote that build
across a domain boundary, and who find the promotion slow.
**Design:** [ADR-0030](../adr/0030-dev-branch-pipelines.md) §1–§3, [ADR-0018](../adr/0018-domain-local-dev-pipelines.md),
[ADR-0013](../adr/0013-supply-chain-scan-sbom-manifest.md).

## The short version

**Scan in the dev pipeline's own CI, at build time. Do not wait until the crossing.**

A promotion that finds a passing, digest-bound scan already recorded for the digest **scans nothing**
— it short-circuits and exports immediately. The slow promotion and the fast one differ only in
*when* the scan ran, never in whether the artifact was scanned.

## Why the crossing is slow by default

`runPromotionScanStep` (`apps/server/src/federation/promotion-scan-step.ts`) runs at **export** time:
it pulls the image and runs the scanner while the operator waits.

It is **not** the vulnerability database. That is baked into the `scp-runner-scan` image and every
scan runs `--skip-db-update --offline-scan`, so nothing is downloaded per scan. The cost is the pull
plus the scan itself, paid on the critical path.

## What makes it fast

That same function's **first branch is a short-circuit**. If a `control_runs` row already carries a
scan outcome that

- parses as `ScanEvidenceSchema`,
- has `status: "pass"`,
- has `digestMatch: true`, and
- has `artifactDigest` **equal to the promoted digest**,

then the step scans nothing for that artifact. The predicate it uses (`isCoveringScanOutcome`) is
deliberately **the exact predicate the E6 export gate applies**, so "already covered here" means "E6
will accept it there" — the two ingresses cannot drift apart.

So the fix is to make that row exist *before* anyone asks for a promotion.

## Steps

### 1. Bind a scan control to the dev pipeline

Bind the shipped `scan-result-control` ControlPlugin (M17.1) to the component's pipeline. It turns a
Trivy verdict into gate evidence and is digest-binding.

### 2. Have the dev CI scan its own build and report the result

After the dev pipeline builds the image and knows its digest, run Trivy in CI and report the verdict
through the first-party report ingress. The report must carry **the digest that was actually
scanned** — that is what binds the evidence.

```bash
scp change-source report github --status applied --repo "$GITHUB_REPOSITORY" --ref refs/heads/dev --artifact-digest "$IMAGE_DIGEST"
```

`--status` is required. `--ref` is what reaches a **ref-scoped** mapping — without it the report
cannot match one (fail-closed, the same rule as an unknown path), so a dev pipeline selected by
`ref_pattern` would never see the report at all. `--artifact-digest` is the load-bearing part for
the scan evidence: it is what binds the outcome to the digest the crossing will check.

### 3. Confirm the evidence covers the digest

```bash
scp decision list --kind promotion-export-scan-gate
```

A crossing that still refuses will name the offending artifact and digest in its reason, and carries
a `decision_id` you can resolve for the full inputs.

## Checks that will still refuse you, and why that is correct

| Symptom | Cause |
|---|---|
| Export refuses despite a green CI scan | The reported `artifactDigest` is not the promoted digest. `digestMatch: false` refuses exactly like a missing scan — this is the binding working, not a bug. |
| Export refuses after a rebuild | A rebuild is a **new digest**. Evidence is per-digest by design; the new build needs its own scan. |
| Nothing gets faster | The evidence is being written after the promotion starts. It must exist *before*, or the short-circuit has nothing to find. |

## What this deliberately does NOT do

It does **not** exempt anything. There is no branch, label, or classification that skips the gate:

- `source_mappings.classification` (`dev`/`beta`) is **UI/reporting only**. Forging or removing it
  changes no gate outcome — pinned by the label-inertness tests in
  `apps/server/src/federation/federation.integration.test.ts`, which are mutation-proven against a
  gate that honours a dev-branch origin.
- The `dev` **branch** grants nothing either. `evaluatePromotionScanGate` takes only the substantive
  artifacts and the control-run outcomes; it has no source, ref, or classification input.

This matters because push access to a `dev` branch is typically **wider** than authority to approve a
cross-boundary promotion. An exemption keyed on the branch would be mintable by anyone who can push
([ADR-0030](../adr/0030-dev-branch-pipelines.md) §3). Scanning early is not a workaround for that —
it is the thing that makes the exemption unnecessary.

## If it is still too slow

Do **not** reach for an exemption. Use [ADR-0016](../adr/0016-scoped-scan-requirement-policies.md)
scoped scan-requirement policies: a **permissive per-severity threshold on the commercial trust
domain** and a strict one at the CDS partition. That makes the gate cheaper to *satisfy* without
making it absent, is operator-declared through an authorized API rather than mintable by a pusher,
and is already boundary-scoped by design.

## Related

- [ADR-0030](../adr/0030-dev-branch-pipelines.md) — ref-scoped pipeline selection; the inert label; §3, this decision.
- [ADR-0018](../adr/0018-domain-local-dev-pipelines.md) — why a **domain-local** dev deploy is exempt by PATH (it never reaches the export at all), and why that exemption cannot follow the artifact across a boundary.
- [scan-db-refresh.md](scan-db-refresh.md) — keeping the scanner DB current, and what a stale one does to a verdict.
