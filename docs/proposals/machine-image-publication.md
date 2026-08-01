# Machine-image publication at the destination — and what the commander's signature attests to

**Status:** Draft — proposed 2026-07-31, **pending owner review**. Docs-first per the working conventions; nothing here is built.

**Origin.** Raised by the owner while resolving M13.3a's machine-image scan arm: *"if we're pushing an AMI, we want it to end up in AWS EC2 AMIs as an option… though there's usually some extra work needed on the AMI (ex: bake in additional crypto now that it's in the air-gap env)."* Those are two distinct problems, both **destination-side**, and neither belongs to the commander's scan step — which is why 13.3a closed without them.

**Relates to:** [ADR-0020](../adr/0020-first-class-commander-scanning.md) (commander scanning; its 2026-07-31 addendum explains why `trivy vm ami:` is the wrong subject and points here); [ADR-0018](../adr/0018-domain-local-dev-pipelines.md) (**the load-bearing precedent** — a change that never crosses a boundary is structurally exempt, backstopped by the fail-closed export gate); [ADR-0019](../adr/0019-artifact-byte-channel.md) §3 (the artifact-store credential class, and its limits); [ADR-0017](../adr/0017-ownership-refinement.md) (build devolution — an outpost builds its own originating artifacts); [ADR-0015](../adr/0015-cosign-cross-boundary-signing.md) (what the commander's signature covers); [ADR-0012](../adr/0012-registry-consolidation.md) (the outpost-local registry the bytes land in); PROJECT_CHARTER.md (principle 1 and the Managed Execution Exception).

---

## 1. What already works, precisely

Worth stating first, because it bounds the proposal to what is genuinely missing.

A machine image promoted across a CDS boundary today: it is exported to a **disk file** at the source (an AMI cannot cross a diode — bundles are metadata-only and bytes travel as files, [ADR-0019](../adr/0019-artifact-byte-channel.md)); the commander pulls it by digest, **scans it** (`trivy-vm`, M13.3a), evaluates against the resolved M17.5 threshold, and **cosign-signs a manifest enumerating the digest** only if the scan passes (E6); the bytes cross as a signed OCI-layout tarball or on operator-loaded media; the receiving outpost service re-verifies at import (M17.4a) and again digest-bound pre-deploy (M17.4b), then the bytes sit in its local registry.

So at the destination we have: **a verified disk image, and a commander signature attesting that exact disk passed scanning.** What we do not have is (a) any way to turn that disk into a bootable AMI in the destination account, or (b) any account of what the signature means once the image is modified.

## 2. Problem A — publication: disk → AMI in the destination account

### 2.1 What the work actually is

Registering an AMI from a disk is a fixed, boring sequence: stage the disk in an S3 bucket in the destination account; `ec2:ImportSnapshot`; poll `DescribeImportSnapshotTasks` to completion; `ec2:RegisterImage` naming that snapshot as the root device; record the resulting AMI id. It needs the AWS `vmimport` service role to pre-exist (an account prerequisite, not something SCP should create).

The permissions are narrow and image-scoped — `s3:PutObject` on one staging prefix, `ec2:ImportSnapshot`, `ec2:DescribeImportSnapshotTasks`, `ec2:RegisterImage` — with no compute, no VPC, no IAM. Narrow, but **unambiguously write** and unambiguously **cloud-provider IAM**. This is execution, not coordination.

### 2.2 Three ways to get it done

**Option 1 — COORDINATE (charter default).** SCP triggers the org's existing execution system — a pipeline, EC2 Image Builder, a Terraform/OpenTofu run they already own — through the standard executor interface (`observe`/`trigger`/`status`/`abort`). SCP holds no cloud credentials at all. Perfect charter fit. Requires the org to have something to trigger.

**Option 2 — MANAGED, via the existing `scp-managed-iac` executor (recommended for the pipeline-less case).** Express publication as a small OpenTofu module (`aws_ebs_snapshot_import` + `aws_ami`) and let the **already-sanctioned** managed-IaC runner apply it. This is worth dwelling on, because it is a much better trade than it first looks:

- The charter's Managed Execution Exception already enumerates `scp-managed-iac` for *"trivial IaC releases for orgs without pipelines"*. Importing a snapshot and registering an AMI is close to the canonical example of that sentence.
- It needs **no new enumerated managed class**, **no new runner image**, and **no new credential class** — `scp-runner-iac` already runs ephemerally with vaulted scoped credentials injected only into the container's env (`infraCredsSecretKeys`), redacted out of returned evidence.
- It inherits the isolation properties wholesale: ephemeral single-shot container, `--network none` by default (publication needs egress, so this becomes an operator-allowlisted exception — see §2.3), no docker socket, no bind mount.

**Option 3 — a dedicated `scp-managed-image-publish` executor** making AWS SDK calls directly. Nicer UX and better progress reporting than an OpenTofu apply, but it is a **third** enumerated managed class, a new runner image, and a new credential surface, to do something Option 2 already does. Recommended **against** unless Option 2 proves unworkable in practice.

**Recommendation: Option 1 as the default, Option 2 as the pipeline-less path.** This is deliberately the same shape M13 already uses for scanning — org-pipeline evidence is the preferred ingress, the managed runner exists for orgs that have no pipeline. Consistency here is not aesthetic: it means one story to explain, one adoption ramp, and one exception rather than two.

### 2.3 The honest costs

- **Egress.** A publishing runner must reach the destination account's S3/EC2 endpoints. The `--network none` default has to become an operator-allowlisted egress for this executor. That must be **operator-configured, never tenant-steered** — same posture as `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`.
- **Cloud credentials.** Real, and the reason this is a proposal rather than a patch. It stays within the existing exception's *category* (managed-IaC already holds infra credentials by design) but the blast radius is worth writing down explicitly for the AMI-publication scope, as ADR-0019 §3 did for the relay.
- **Size and time.** Snapshot import is minutes-to-hours for a large image and is asynchronous, so this is a genuinely long-running trigger — unlike the scan step, it cannot be a synchronous `trigger()`.
- **Non-AWS destinations exist.** vSphere, Azure, bare metal. Nothing here should hard-code AWS into the graph model; AWS is the first provider, not the shape.

## 3. Problem B — provenance when the image is modified after it crosses

This is the harder half and the one with real correctness content.

### 3.1 The claim that breaks

Scan-once-at-the-commander-before-signing ([ADR-0020](../adr/0020-first-class-commander-scanning.md) §4) is transitive **only because downstream receives the same bytes**. Bake air-gap-local crypto into the image at the destination and you have a **different artifact with a different digest**, which nothing has scanned and nothing has signed. The commander's signature does not cover it and was never claimed to.

That is not a bug to be fixed by extending the signature — it cannot be. It is a claim that must be stated narrowly and then backstopped.

### 3.2 The precedent already exists

[ADR-0018](../adr/0018-domain-local-dev-pipelines.md) settled the structurally identical question for dev/beta pipelines, and its reasoning transfers intact:

- The **only** cross-boundary egress is `exportPromotionBundle`, which requires a federation peer. A change that targets no peer never reaches export.
- Scanning is a **boundary-crossing authorization** gate, not a general quality gate. A change that never crosses has nothing for the gate to authorize.
- The export gate is **fail-closed and universal**: if that digest is *later* promoted across a boundary, export hard-refuses it unless a passing, digest-bound scan covers it.

Applied here: the modified image is a **new artifact originating in the destination domain**. It is domain-local; the outpost service deploys it locally and never promotes it onward (which is exactly the semantics M15+M17 already give the outpost). If someone ever *did* try to promote it onward, E6 refuses it fail-closed until it carries its own passing scan — the correct behaviour, already built, no new gate.

### 3.3 So what is actually missing

One thing, and it is small: **nothing records the derivation.** There is no way to answer "this AMI was deployed — what did the commander attest to?" The chain is: commander-signed `sha256:abc` (the base disk) → destination modification → `sha256:def` (the published image) → AMI id. Only the first and last links exist anywhere.

**Proposed: a first-class `derived_from` relationship** between the destination-originated artifact and the commander-signed base digest, plus the resulting provider-native image handle (AMI id) recorded as a property of the destination artifact. Graph-native (charter principle 2 — a relationship, not a new top-level table), and it makes three questions answerable that are currently unanswerable:

1. What commander-attested base does this running image derive from?
2. Which destination-local modification produced it, and who authorized that?
3. If the base is later found vulnerable, which destination-published images inherit the finding?

Question 3 is the one that will matter operationally, and it is unanswerable today.

### 3.4 The alternative, and why it usually fails

**Variant-at-source** — bake the destination-specific crypto *before* the commander scans and signs, and promote one signed variant per destination. Every deployed image is then commander-attested end to end, no derivation model needed. It is the cleanest answer and should be documented as the preferred path where it is possible.

It is frequently **not** possible, and for a good reason: it requires the destination's keys to exist in the source domain, which for air-gap-local crypto is precisely what the enclave exists to prevent. It also multiplies the build matrix by the number of destination domains. Proposing it as the only answer would be proposing that the owner's stated use case not happen.

## 4. Open questions for the owner

1. **Is Option 2 (publish via `scp-managed-iac`) an acceptable reading of the existing exception, or does AMI publication want its own charter paragraph?** The recommendation reads it as squarely inside *"trivial IaC releases for orgs without pipelines"*, but that is the owner's sentence to interpret.
2. **Does a publishing executor's egress allowlist belong on the executor binding, or as a deployment-level operator setting?** The binding is more expressive; the deployment setting is harder for a tenant to influence. Current instinct: deployment-level, consistent with every other egress surface.
3. **Is `derived_from` (§3.3) worth building on its own, ahead of publication?** It has standalone value — the modify-after-crossing pattern already happens wherever an outpost rebuilds anything — and it is much smaller than publication.
4. **Does the M15.4 bundled-backend role matrix need to change** so an outpost-role deployment can run a publishing executor at all, or is the coordinated/BYO path ([ADR-0017](../adr/0017-ownership-refinement.md)'s build devolution) sufficient here as it was there?
5. **Which non-AWS destinations, if any, should shape the model now** rather than being retrofitted?

## 5. What this proposal deliberately does not touch

- **The commander's scan step.** Unchanged. It scans the disk at the source before signing, exactly as M13.3a built it.
- **Any gate.** E6, M17.4(a)/(b) and M17.5 are untouched by everything above; §3.2's whole point is that existing fail-closed behaviour is already correct for the derived artifact.
- **`trivy vm ami:`/`ebs:`.** Still the wrong subject, for the structural reasons in [ADR-0020](../adr/0020-first-class-commander-scanning.md)'s addendum. Nothing here revives it.
