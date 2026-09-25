# ADR-0059: The `re-vendor` bump strategy splits fetch+verify (orchestrator) from parse+transform (a credential-free sandbox)

**Status:** Accepted (2026-09-25, M29.8a) — rewritten the same day per a direct owner decision responding to the
`#420` adversarial review, which found the FIRST version of this ADR both architecturally wrong (untrusted
upstream bytes reached the same process that later holds the repository-write credential) and factually
wrong about its own claims (see "What the first version got wrong," below). This version implements the
owner's own decision verbatim: **"Split + small amendment."**
**Relates to:** ADR-0032 §8 (`scp-managed-dep`'s standard executor interface); PROJECT_CHARTER.md's
`scp-managed-dep` amendments (2026-08-15's orchestrator/runner network split; **2026-09-25's narrow
re-vendor grant**, added alongside this ADR); `tools/vendor-refresh` (the planner, now split across the
boundary this ADR draws); `docs/proposals/zero-to-running.md` §9.1 step 1; `apps/runner-dep-vendor`
(the new sandbox image)

## Context

Proposal §9.1 step 1 and BUILD_AND_TEST.md's M29.8(a) call for a **re-vendor bump strategy** on top of the
existing `scp-managed-dep` actuator: a component whose dependency is a vendored upstream Standard Stack
backend (Argo CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea) bumps by re-fetching and re-vendoring
the upstream manifest set at a new tag, not by editing one version string.

### What the first version of this ADR got wrong

The `#420` review read the first version and found it both architecturally unsound and, in three places,
factually false about the very code it was describing:

1. **"There is no untrusted party on the re-vendor path"** (§ old, ~line 61) was false. The upstream
   manifest bytes ARE untrusted — they are fetched from a third-party host over plain HTTPS, by a MUTABLE
   tag, with no signature or checksum verification of any kind. The first version's OWN orchestrator
   (`triggerRevendor`) both fetched those bytes and held the per-run repository-write credential in the
   same process, in the same function, with nothing between them. That is exactly the "untrusted bytes
   meet the write credential" shape the charter's `scp-managed-scan`/`scp-managed-dep` splits exist to
   prevent for every OTHER managed class.
2. **"`backend` and `tag` are drawn from an enum-like set"** (§ old, ~line 64) was false for `tag`. Only
   `backend` was validated against an enum; `fromTag`/`toTag` were validated for CONTROL CHARACTERS only.
   The review's probe P1 fed `../../../attacker/evil/main`-shaped tags straight into a fetch URL, which
   `new URL()`'s own path normalisation resolved to a different repository/path entirely. (Fixed
   independently of this redesign — see the PR's finding-5 commit — but the ADR's own claim was wrong
   when it was written, which is worth recording rather than quietly correcting.)
3. **"…hosts already reached… (M21.4)"** (§ old, ~line 142) overstated an existing precedent: the M21.4
   version-index code reaches OCI registries and language package indexes through `@scp/cosign`'s
   `resolveSkopeo()`/the plugin host's configured index URLs — it does not reach `raw.githubusercontent.com`
   or `github.com/…/releases/download/…` at all. The "two more classes of host" were NOT already reached by
   anything; they were new, and the ADR should have said so plainly rather than borrowing a precedent that
   does not cover them.

None of these were separately caught by CI, because none of them are the kind of thing a type-checker or a
unit test asserts about an ADR's OWN PROSE — they were caught by an adversarial second read. That is the
process working as intended, not a near-miss; it is recorded here because CLAUDE.md's own discipline says a
found defect names the property, and the property here is **"an architecture decision's stated justification
was not independently checked against the code it justifies before being marked Accepted."**

## Decision — the owner's "Split + small amendment"

The `re-vendor` strategy is split across a trust boundary that did not exist before:

1. **The ORCHESTRATOR** (`packages/plugins/managed-dep`, running in `scpd`/the worker, holding the
   per-run repository-write credential) does ONLY:
   - Resolve the upstream tag to a commit SHA and fetch BY SHA, never by tag, for the two backends whose
     manifest lives in the upstream source tree (Argo CD, Argo Events) — a mutable tag is not an identity
     (the same principle `tools/ci-mirror/images.list`'s own header states for container image tags).
   - Fetch the GitHub Release asset for the two backends that publish one instead (Argo Workflows, Argo
     Rollouts), and verify it against a published checksum/provenance file where the release carries one.
   - Fetch the Gitea chart tarball from the chart repository's own index, verified against the digest the
     index itself declares.
   - Resolve every tracked image's digest through the repo's pinned skopeo, and verify each image's cosign
     signature against the expected upstream identity BEFORE accepting the digest.
   - Validate that the fetched manifest's own declared image tags equal `toTag`, that `toTag` is NEWER than
     the version this repository's OWN `values.yaml` currently declares (read from the target repo, which is
     CommanderSCP's own — never upstream, never untrusted), and refuse a downgrade.
   - Treats every upstream byte as OPAQUE. It never parses the fetched manifest as YAML; the only parsing it
     does is of SMALL, STRUCTURED METADATA it fetches for exactly this purpose — a release JSON descriptor, a
     checksums file, a chart index entry — none of which is the multi-megabyte manifest itself.
   - Hands the verified, opaque bytes (plus the resolved/verified image digest map, plus this repository's
     OWN current `values.yaml`/`bundle-images.ts`/`images.list` content) to the sandbox, and receives files
     back.
   - Checks every returned file path against the FIXED, per-backend path set (`FIXED_VENDOR_PATHS`,
     `tools/vendor-refresh`) — never the caller-supplied `declaredManifestPaths` the intent carries, which
     is now cross-checked against the fixed set rather than trusted — and that the target repository equals
     `config.scpRepo`, a SERVER-INJECTED setting naming the one repository this strategy may ever write to.
     Both checks run before a single blob is created.
   - Commits the sandbox's returned files via the Git Data API and records the sandbox's diff classification
     (below) as the outcome's decision record.

2. **THE SANDBOX** (`apps/runner-dep-vendor`, a new image; see "Why a sibling image, not
   `scp-runner-dep` itself," below) holds NO credential of any kind, reaches NO host (`--network none`,
   unconditionally, mirroring `scp-runner-dep`'s own clause), and receives ONLY the orchestrator-verified
   bytes. It does everything the untrusted-input-shaped work actually is:
   - Parses the manifest YAML, splits it (Argo Workflows), strips Gitea's Secrets and extracts its
     config/init scripts, runs `helm template` against the LOCALLY-supplied chart tarball (Gitea only —
     this is not a network operation; the tarball already arrived from the orchestrator).
   - Rewrites `values.yaml`/`bundle-images.ts`/`images.list` and the chart's `vendoredXxx` retarget-source
     fields using the resolved image digest/tag map the orchestrator handed it (never resolving anything
     itself).
   - Computes the semantic diff classification (below) between the OLD and NEW parsed manifest, and returns
     it alongside the files.
   - Returns files + classification; commits nothing, reaches nothing, holds nothing.

### The semantic diff classifier

`classifyRevendorDiff` (`tools/vendor-refresh/src/classify.ts`) parses the OLD and NEW manifest text into
per-object records and classifies the change:

- **`image-only`**: every difference between OLD and NEW is confined to a TRACKED image's tag/digest text.
- **`requires-review`**, naming every offending object, when ANY of the following changed: `Role`/
  `ClusterRole` rules, `RoleBinding`/`ClusterRoleBinding` subjects or role refs, a `ValidatingWebhookConfiguration`/
  `MutatingWebhookConfiguration`, a `CustomResourceDefinition` (its conversion webhook included), a
  `Namespace`, a `ServiceAccount`, a container's `privileged`/`hostPath`/`hostNetwork` posture, any `Secret`,
  or a NEW image coordinate that is not one of this backend's tracked images.

This is a pure function over parsed objects, not a governance-engine Decision record in the charter §6 sense
(that would need its own migration and apps/server wiring — explicitly out of scope for this increment, see
"Consequences"); it is threaded into the run's outcome and the pull-request body so the classification is
visible and auditable even though it is not yet a first-class Decision row. M29.8(b) is where an
`image-only` classification becomes the auto-merge gate this class needs; this increment computes and
records it, and refuses nothing on it yet beyond what `requires-review`'s own visibility already buys.

### Why a sibling image, not `scp-runner-dep` itself

`scp-runner-dep`'s entire design is built around having as close to nothing in it as possible — `FROM
scratch`, one static BusyBox binary, seven applets, no package manager, enforced by what the image
literally cannot contain (ADR-0032 §8e). The re-vendor sandbox needs a YAML parser, a Helm binary, and a
Node runtime to run them — a categorically different, much larger footprint that would either force
`scp-runner-dep`'s minimal image to carry a toolchain the tag-edit strategy never needs, or force a
conditional, multi-purpose image whose contents depend on which strategy launched it (itself a containment
smell: "what this container can do" would stop being a property of the image alone). `apps/runner-iac`
already establishes the "a runner MAY be a full pinned toolchain when the job genuinely needs one" precedent
in this same family of images; `apps/runner-dep-vendor` follows that precedent, not `scp-runner-dep`'s.

## Alternatives considered

1. **Keep the FIRST version's design (all fetch+parse in the orchestrator).** Rejected outright by the owner
   — this is the exact defect the review found.
2. **Give the runner a registry-pull exception, mirroring `scp-managed-scan`'s qualified clause, and put
   everything (fetch AND parse) in the runner.** Rejected: this still puts the upstream fetch behind the
   SAME process that would need the repository-write credential to do anything useful with what it fetched,
   unless the runner is ALSO denied the credential — which is exactly the two-tier split this ADR adopts,
   just organized around one container instead of two. Two containers with two distinct trust levels (fetch
   + verify with a credential and no parsing; parse + transform with parsing and no credential) is a
   stronger boundary than one container with a network exception carved into an otherwise credentialed
   process.
3. **Extend `scp-runner-dep` itself with Node+Helm rather than a sibling image.** Rejected for the reason
   given above (a toolchain the tag-edit strategy never needs, and a containment story that becomes
   conditional on which strategy launched the container rather than a property of the image).

## Consequences

- The orchestrator's egress footprint gains a SMALL, NAMED set of hosts: `raw.githubusercontent.com`,
  `github.com` (release assets and their checksums/provenance), the Gitea chart repository's index host,
  and whatever OCI registries the pinned skopeo already reaches for other dependency-automation jobs. Every
  fetch routes through the plugin host's `ctx.http` — the SAME SSRF/allowlist/redirect-refusal/DNS-pinning
  guard every other plugin's outbound call already goes through (`docs/plugin-host.md` §23/§28) — with a
  hardcoded host allowlist, never an operator- or tenant-settable one.
- `apps/runner-dep-vendor` is a NEW image with its own CI publish wiring (`.github/workflows/ci.yml`'s
  `runner-images` job, `scripts/runner-image-tags.sh`) and its own air-gap bundle entry
  (`deploy/airgap/src/bundle-images.ts`) — mechanical additions following the exact pattern the four
  existing runner images already establish.
- A future SIXTH bundled backend needs its own `tools/vendor-refresh` backend spec on BOTH sides of the
  split (what the orchestrator fetches+verifies; what the sandbox parses+transforms) — this ADR is scoped to
  the five backends `tools/vendor-refresh` names today, not a blanket grant.
- **Named, not silently deferred:** full apps/server governance-engine Decision-table persistence for the
  diff classification (a charter §6 Decision record with a `decision_id`, as opposed to this increment's
  outcome-detail + PR-body recording) needs its own migration and its own review, and is left for a
  follow-up increment rather than built hastily under this PR's own time pressure. Genuine, real, checksum/
  provenance coverage for Argo Workflows/Argo Rollouts' `install.yaml` release asset is ALSO incomplete:
  measured against the real releases (2026-09-25), neither project's published checksums file actually
  covers `install.yaml` (only their CLI binaries/SBOM are covered) — the orchestrator records this
  explicitly as "unverified, no checksum published" rather than fabricating a pass, and closing that gap
  needs either an upstream ask or a different verification mechanism, not a silent claim of coverage this
  ADR does not have.
