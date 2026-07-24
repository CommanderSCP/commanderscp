# Runbook — raising homelab docker-build runner concurrency

**Problem.** The `homelab-commanderscp-linux-docker-build` ARC scale set is configured
`maxRunners: 3`, and the ARC listener *correctly decides* to scale to 3 when 3 jobs are
assigned — but only **1** runner pod ever runs. The cause is **not** `maxRunners`; it is the
`github-runners` namespace **ResourceQuota**.

## Root cause (measured 2026-07-24)

```
resourcequota/github-runners-quota  (namespace github-runners, shared by ALL projects' runners)
  hard:  limits.memory=20Gi  limits.cpu=12  requests.memory=11Gi  requests.cpu=5500m  pods=8
```

One docker-build runner pod consumes: **`limits.memory` 12Gi** (runner 8Gi + DinD 4Gi via the
namespace LimitRange default), `limits.cpu` 6, `requests.memory` 3Gi, `requests.cpu` 1500m.

Binding constraint = `limits.memory`: `20Gi ÷ 12Gi = 1` pod. A 2nd needs 24Gi > 20Gi, so ARC's
extra ephemeral runners register with GitHub but their pods are **admission-blocked by the quota**
(`EphemeralRunnerSet: DESIRED=3 RUNNING=1 PENDING=2`). That is the "always 1" symptom.

Per-pod budget vs. the caps:

| Resource | per pod | quota hard | fits |
|---|---|---|---|
| `limits.memory` | 12Gi | 20Gi | **1** ← binds |
| `limits.cpu` | 6 | 12 | 2 |
| `requests.memory` | 3Gi | 11Gi | 3 |
| `requests.cpu` | 1500m | 5500m | 3 |

Node `home-lab` allocatable memory ≈ **22Gi**. Scheduling uses *requests* (3Gi/runner), so 2–3
runners schedule fine; *limits* oversubscribe the node, which is safe only if they don't all peak
at once — see the ordering note.

## Fix — pick the target concurrency

### 2 runners (minimal, only `limits.memory`)
`limits.cpu: 12` already fits 2 (2×6). Only raise `limits.memory` to `24Gi`:

```bash
kubectl --context homelab -n github-runners patch resourcequota github-runners-quota \
  --type merge -p '{"spec":{"hard":{"limits.memory":"24Gi"}}}'
```

### 3 runners (raise memory + cpu; requests headroom)
```bash
kubectl --context homelab -n github-runners patch resourcequota github-runners-quota \
  --type merge -p '{"spec":{"hard":{"limits.memory":"36Gi","limits.cpu":"18","requests.memory":"12Gi","requests.cpu":"6"}}}'
```

## ⚠️ Ordering — apply this AFTER the CI-speed PR (Lever 1)

Raising the quota lets 2–3 docker-build runners run **concurrently**. Until the "prebuild runner
images" lever lands, each of those runners still builds the heavy Fedora+OpenSCAP `scp-runner-scan`
image in-suite — 2–3 concurrent heavy builds can peak past the node's 22Gi and **OOM**. Once Lever 1
is merged, the runners only *pull* + run light scans, so concurrent runners are safe.

**Recommended sequence:** merge the CI-speed PR (prebuilt images) → then apply the quota patch for
your target N → the sharded/parallel integration jobs materialize as real concurrent runners.

## PREFERRED long-term fix — right-size the runner instead of inflating the quota

Once **Lever 1** (prebuilt runner images, PR #127) is merged, the docker-build runner no longer
builds the heavy `scp-runner-scan` image in-suite — it only *pulls* it — so it no longer needs an
8Gi memory limit. The 8Gi headroom existed only for that build.

**Pod budget breakdown (measured):** runner container (explicit `limits: 8Gi mem / 4 cpu`,
`requests: 2Gi / 1 cpu`) + DinD sidecar (`4Gi mem / 2 cpu` **from the namespace LimitRange
`github-runners-default-limits`**, `requests 1Gi / 500m`) = **12Gi limits.memory, 6 limits.cpu, 3Gi
requests.memory** per pod. That 12Gi limit ÷ 20Gi quota is the "only 1 runner" cap.

**Right-size the runner memory limit 8Gi → 4Gi** (ARC Helm values for the
`homelab-commanderscp-linux-docker-build` scale set — Helm-managed, so a `kubectl patch` is reverted;
this is a **values change**):

- pod drops to **~8Gi limits.memory** (4Gi runner + 4Gi DinD) → **2 fit in the existing 20Gi quota,
  no quota change, no node oversubscription** (2 pods = 16Gi limits < 22Gi node).
- to fit **3**, also lower the runner CPU limit (4→2) and the DinD limit (set an explicit ~2Gi, or
  lower the LimitRange default) → ~6Gi/pod → 3 fit; a small quota `limits.cpu` bump may be needed.

### `minRunners: 1` (one always-warm runner) — worthwhile *after* right-sizing

A warm idle runner's real standing cost is its **request (~3Gi node memory)**, not its limit; actual
idle RSS is a few hundred MB. On the *current* 12Gi-limit pod, a warm `minRunners: 1` would pin 12Gi
of the 20Gi quota and still block a 2nd runner — so do it **only after** the 4Gi right-size, where a
warm pod costs ~8Gi of quota and still leaves room to burst to 2. Set `minRunners: 1` in the same ARC
Helm values. Net after both edits: **one always-hot runner (fast starts, ~3Gi idle) bursting to 2,
inside the unchanged 20Gi quota.**

## Two independent axes — don't confuse them

| Bottleneck | Caps | Fix | Where |
|---|---|---|---|
| Runner **CPU limit** (4) | *within-shard* vitest fork depth (Lever 3) | raise CPU limit + `SCP_TEST_MAX_FORKS` | ARC Helm values (see BUILD_AND_TEST §6) |
| Namespace **memory quota** (20Gi) ÷ 12Gi/runner | *number of concurrent runners* (breadth) | right-size runner mem 8→4Gi (preferred) or raise quota | Helm values / `kubectl patch` (this runbook) |

## Verify after applying

```bash
kubectl --context homelab -n github-runners get ephemeralrunnerset \
  homelab-commanderscp-linux-docker-build-kzgwr
# DESIRED and RUNNING should both reach your target N when N jobs are queued; PENDING → 0.
kubectl --context homelab -n github-runners get pods | grep docker-build.*runner- | grep -v listener
# should show N Running pods under concurrent demand.
```
