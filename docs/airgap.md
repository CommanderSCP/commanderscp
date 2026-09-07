# airgap

Long-form reference for the **airgap** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 61 of 61 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`deploy/airgap/src/build-bundle.ts`](#deploy-airgap-src-build-bundle-ts) — §1–§1
- [`deploy/airgap/src/bundle-images.test.ts`](#deploy-airgap-src-bundle-images-test-ts) — §2–§15
- [`deploy/airgap/src/bundle-images.ts`](#deploy-airgap-src-bundle-images-ts) — §16–§18
- [`deploy/airgap/src/checksums.ts`](#deploy-airgap-src-checksums-ts) — §19–§21
- [`deploy/airgap/src/ci-offline-mirror.test.ts`](#deploy-airgap-src-ci-offline-mirror-test-ts) — §22–§28
- [`deploy/airgap/src/compose-retarget.ts`](#deploy-airgap-src-compose-retarget-ts) — §29–§31
- [`deploy/airgap/src/cosign-bin.test.ts`](#deploy-airgap-src-cosign-bin-test-ts) — §32–§34
- [`deploy/airgap/src/cosign-bin.ts`](#deploy-airgap-src-cosign-bin-ts) — §35–§35
- [`deploy/airgap/src/cosign.ts`](#deploy-airgap-src-cosign-ts) — §36–§36
- [`deploy/airgap/src/index.ts`](#deploy-airgap-src-index-ts) — §37–§37
- [`deploy/airgap/src/install-sh-tamper.test.ts`](#deploy-airgap-src-install-sh-tamper-test-ts) — §38–§42
- [`deploy/airgap/src/manifest.test.ts`](#deploy-airgap-src-manifest-test-ts) — §43–§43
- [`deploy/airgap/src/manifest.ts`](#deploy-airgap-src-manifest-ts) — §44–§44
- [`deploy/airgap/src/oci-layout.test.ts`](#deploy-airgap-src-oci-layout-test-ts) — §45–§45
- [`deploy/airgap/src/oci-layout.ts`](#deploy-airgap-src-oci-layout-ts) — §46–§48
- [`deploy/airgap/src/offline-install-doc.ts`](#deploy-airgap-src-offline-install-doc-ts) — §49–§49
- [`deploy/airgap/src/skopeo-bin.test.ts`](#deploy-airgap-src-skopeo-bin-test-ts) — §50–§55
- [`deploy/airgap/src/skopeo.ts`](#deploy-airgap-src-skopeo-ts) — §56–§57
- [`deploy/airgap/src/types.ts`](#deploy-airgap-src-types-ts) — §58–§58
- [`deploy/airgap/src/verify-bundle.ts`](#deploy-airgap-src-verify-bundle-ts) — §59–§59
- [`deploy/airgap/vitest.config.ts`](#deploy-airgap-vitest-config-ts) — §60–§61

## `deploy/airgap/src/build-bundle.ts`

### §1. @scp/airgap build-bundle — builds `scp-bundle-<version>.tar.gz`

@scp/airgap build-bundle — builds `scp-bundle-<version>.tar.gz` (DESIGN.md §16 "Air-gapped bundle", BUILD_AND_TEST.md §8 M8). See deploy/airgap/README.md for the full bundle format and usage; this file's own comments explain the WHY of each step, not just the WHAT.

Run: `pnpm --filter @scp/airgap bundle -- --version 1.0.0-rc` (extra args after `--` are commander's; see `--help` for the full flag list). Requires `skopeo`/`cosign`/`tar` on PATH — see BUILD_AND_TEST.md §1. Reads each source image from wherever it already is (local Docker daemon by default — see `--*-source`); never pulls anything from the network unless explicitly told to via `--*-source docker` (a deliberate, documented, operator-chosen pull — not a phone-home).

WHAT THE BUNDLE CARRIES IS NOT DECIDED HERE. `bundle-images.ts` holds the canonical list, and this file derives BOTH its `--*-ref`/`--*-source` flags AND the images it copies from that one array — so a bundle cannot carry an image the CLI can't point at, and the CLI cannot advertise a flag for an image the bundle won't carry. `--list-images` prints the resolved list without touching skopeo, which is also how `bundle-images.test.ts` proves this wiring is live.

## `deploy/airgap/src/bundle-images.test.ts`

### §2. The gate behind M21.7 item 1

The gate behind M21.7 item 1: for two releases the air-gap bundle carried ONE of the product's three managed-execution runner images. `scp-runner-scan` (M13.3b) and `scp-runner-dep` (M21.5) were built by `apps/runner-*`, published by `publish-images.yml`, referenced by `deploy/helm/values.yaml` — and absent from every bundle, so on a disconnected install those two executors had no image to run. Charter principle 5 makes air-gap first-class.

The PROPERTY that allowed it: nothing enumerated the class "runner images the product ships", so the bundle's list and the repo's runners could disagree indefinitely and no test could notice. These assertions close the class rather than the two instances — a fourth runner added under `apps/` and left out of the bundle fails here on its first CI run.

Deliberately NOT asserted anywhere below: a COUNT of images, or their ORDER. Both would go green on the wrong list. Every assertion names the specific image it is about.

### §3. The census is taken from the filesystem, not a list here

The census is taken from the FILESYSTEM, not from a list in this file: `apps/runner-*` is the set of runner images that exist, and it is not something a change to `bundle-images.ts` can quietly shrink. (A filter here would be where the next missing runner hides — CLAUDE.md "Census by property, not by symptom".)

### §4. THE WIRING PROOF

THE WIRING PROOF. Everything above tests the LIST; this RUNS the entrypoint and reads the list it actually resolved. A `bundle-images.ts` that names all three runners while `build-bundle.ts` keeps a hardcoded array of its own is precisely the "component built, never installed" defect this repo keeps shipping, and only running the entrypoint can rule it out.

IT RUNS `src/build-bundle.ts` UNDER tsx — NOT `dist/build-bundle.js`, which is what it used to do and which made the proof only as fresh as the last `tsc`. Under the exact command this package's README documents (`pnpm --filter @scp/airgap test` — vitest directly, NOT through turbo, so `dependsOn: ["build"]` never runs), a stale `dist/` passed while the source was broken: reverting `resolveImageSources` to a hardcoded three-image array and NOT rebuilding left this suite green. A wiring proof that can pass against a build nobody just made is not a proof of anything. Nothing is given up by driving the source: `dist/build-bundle.js` is `tsc` output of this exact file and of nothing else, and the `build`/`typecheck` tasks cover that compile step.

### §5. Every stem in one run, proving the mapping is a bijection

Every stem probed in ONE run, each with a ref unique to that stem: this proves the flag->image mapping is a bijection, which eleven separate single-flag runs would not — two stems that both wrote the same option key would each pass alone and only disagree here.

### §6. install.sh does not know any image's name

install.sh does not know any image's name: it loops over `$BUNDLE_IMAGE_NAMES` and derives each variable stem with `printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_'`. manifest.ts derives the same stem with a JS regex. Two independent implementations of one rule, and the new names are the first to exercise a doubled hyphen path (`scp-runner-scan` -> SCP_RUNNER_SCAN), so they are checked by RUNNING the bash pipeline rather than by restating it.

### §7. The M21.7 class, INVERTED. Above

The M21.7 class, INVERTED. Above: an image the bundle carries that install.sh cannot address. Here: an image install.sh addresses that the bundle does not carry — the same disagreement from the other side, and the one that fails at 3am on a disconnected cluster with `SCP_RUNNER_X_DIGEST: unbound variable` under `set -u`.

install.sh's verify/push loops are generic over `$BUNDLE_IMAGE_NAMES`, but its step-4 helm wiring necessarily names stems literally (each maps to a different chart value or env var). Those literals are read OUT OF THE REAL SCRIPT here rather than restated, so a stem added to install.sh without an image behind it fails on its first run.

### §8. KNOB EXTRACTION, SHARED BY EVERY SURFACE THAT PRESCRIBES ONE

KNOB EXTRACTION, SHARED BY EVERY SURFACE THAT PRESCRIBES ONE.

Hoisted out of the install.sh describe below because install.sh is not the only place that tells an operator what to set: the SAME activation guidance is rendered into the bundled `docs/OFFLINE_INSTALL.md` (`offline-install-doc.ts`), which `deploy/airgap/README.md` calls "the one to actually read" and which ships INSIDE the bundle, on the far side of the gap. When only install.sh was gated, the identical no-op instruction could be reintroduced in the doc and the whole suite stayed green — measured. One definition, both surfaces.

### §9. The env vars the server actually reads

The env vars the server actually reads — the one module all three managed classes read from.

READ WITH COMMENTS STRIPPED, and that is the whole point of the check. MEASURED 2026-08-17: with `runnerImage: process.env.SCP_MANAGED_DEP_RUNNER_IMAGE` commented out of that module, this file stayed green at 87/87 — because the module also DOCUMENTS the variable in a doc comment eight lines above the read ("SCP_MANAGED_DEP_RUNNER_IMAGE — the vetted, pinned `scp-runner-dep` image…"). So "verify the lever, not just the signal" was verifying a third thing: the PROSE about the lever. `@scp/source-census` exists so this package and `apps/server` share one reader rather than each carrying a copy of the stripper.

THE LIMIT, stated where the assertion is: stripping proves the module still MENTIONS the variable in code. It cannot prove the value is used, reaches a runner, or is read on the path an operator's compose install takes — `process.env.X` assigned to a field nobody consumes would satisfy every assertion below. What proves the rest is `runner-image.integration.test.ts`, which launches the runner for real.

### §10. The scan-runner activation block was printed under one flag

M21.7 item 1's follow-up defect, and the reason this whole describe exists: the block that tells an air-gapped operator how to switch on `scp-runner-scan` was printed ONLY under `--mode helm`, and named `SCP_MANAGED_SCAN_RUNNER_IMAGE`. Under helm the only lever an operator has is a chart value, and the chart has none for that env var (helm/README.md, "Still NOT settable"), so the instruction did nothing — silently, with no error, on the far side of an air gap where "it didn't take" is expensive to discover. An instruction that silently no-ops is worse than no instruction at all: it reads as coverage.

The PROPERTY, not the instance: a knob is only real in the mode whose deployment mechanism can carry it. Chart values are levers under helm and mean nothing under compose; env vars on the `scp` service are levers under compose (and VM — `scp.platform`'s Ansible role runs install.sh with `--mode compose`) and mean nothing under helm. So both directions are asserted for both modes, over the text install.sh ACTUALLY PRINTS, extracted from the real script.

### §11. install.sh's step 4 is one top-level

install.sh's step 4 is one top-level `if [[ "$MODE" == "helm" ]] ... else ... fi`; every nested `else`/`fi` inside it is indented, so slicing on the column-0 keywords yields exactly the text an operator in each mode sees.

### §12. VERIFY THE LEVER, NOT JUST THE SIGNAL

VERIFY THE LEVER, NOT JUST THE SIGNAL. The compose-mode instruction is only real if the product reads that env var. All three managed classes read theirs in one module — deliberately the only place this looks, and deliberately named in `turbo.json`'s inputs for this package, so the two stay in step: move the read and this fails loudly rather than going quietly stale.

### §13. Both docs kept restating the list they promised to point at

The M21.7 commit said README.md and DESIGN §16 "stop restating the list and point at it", and then both went on restating it — README's contents tree enumerated all eleven images, DESIGN §16 enumerated them one sentence before the paragraph explaining that enumerating them anywhere else is how `scp-runner-scan` and `scp-runner-dep` were missed for two releases. A doc contradicting its own next paragraph is this repo's recurring shape, and nothing failed when it happened, because nothing looked.

WHY "MUST NOT NAME THEM ALL" RATHER THAN "MUST NAME THEM ALL": a doc that carries the whole inventory has to be maintained in lockstep with `bundle-images.ts` forever, and the failure mode when it isn't — a list that LOOKS complete and is one image short — is precisely the bug. A doc that carries a POINTER cannot go stale. So the gate is on the restatement itself: the moment a doc names every image again, it fails here.

The bundled, operator-facing `docs/OFFLINE_INSTALL.md` is the deliberate exception, and it is exempt because it is not prose: `offline-install-doc.ts` GENERATES its contents tree from the same array, and the describe below holds it to naming every image.

### §14. The case above is a doc<->spec CONSISTENCY check

The case above is a doc<->spec CONSISTENCY check: drop an image from the spec and both sides shrink together, so it goes green on the wrong list. This one is anchored to the runner class instead (which `RUNNER_IMAGE_NAMES` holds against `apps/runner-*`), so the inventory an operator reads cannot quietly lose a runner.

### §15. Naming the runner is not checking what to set

THE CASE ABOVE ONLY CHECKS THE RUNNER'S NAME IS PRESENT, NEVER WHAT THE DOC TELLS THE OPERATOR TO SET. That gap was measured: rewriting the scan runner's activation cell to `helm: --set managedScan.runnerImage=<printed ref>` — a chart value NEITHER shipped chart defines, so the exact silent no-op M21.7 item 1 was written to remove — left the whole @scp/airgap suite green (10 files, 139 passed, 0 failed).

This doc is the higher-consequence surface of the two: install.sh's guidance scrolls past once, while `docs/OFFLINE_INSTALL.md` ships inside the bundle and is the thing an air-gapped operator actually reads. So it gets the SAME two-directional check install.sh's describe runs, over the same extraction — a knob is real only in the mode whose deployment mechanism can carry it.

## `deploy/airgap/src/bundle-images.ts`

### §16. THE canonical list of images the air-gap bundle carries

THE canonical list of images the air-gap bundle carries — the single source of truth every other bundle-contents enumeration is derived from.

WHY THIS FILE EXISTS. Until M21.7 the list lived as a literal array inside `build-bundle.ts`, and four other places restated it in prose or shell: the CLI's own `--*-ref` flags, `offline-install-doc.ts`'s "What's in the bundle" tree, `README.md`, and install.sh's per-backend `--set` blocks. Restated lists drift, and the drift is invisible until an operator is standing on the far side of an air gap: `scp-runner-scan` (M13.3b) and `scp-runner-dep` (M21.5) were both built, both published by `publish-images.yml`, both referenced by `deploy/helm/values.yaml` — and neither was ever in the bundle. The managed-scan and managed-dep executors therefore had NO IMAGE TO RUN on a disconnected install, and no test said so, because no test could: nothing enumerated the class "runner images the product ships".

So the list is data now, in one place, and `bundle-images.test.ts` holds it against the filesystem: every `apps/runner-*` the repo builds must appear here.

UNCONDITIONAL, NOT OPT-IN — the shape decision, and the evidence for it
Every image below rides EVERY bundle. None of them is gated on a build-time flag, including the ones whose feature is off by default. That is not an oversight carried forward; it is the existing, deliberate design, and the two new runners follow it:

```text
- `scp-runner-iac` has always been bundled unconditionally even though `managedIac.enabled`
  defaults to `false`. Same for `argocd`/`valkey`/`gitea`/`argo-*`, all of whose
  `bundledExecutor.*.enabled` default to `false`. The conditionality in this system is at
  DEPLOY time (which images the cluster pulls), never at BUNDLE time — build-bundle.ts's own
  comment on the Argo CD entry says exactly this: "pulled only by domains that enable
  bundledExecutor.argocd".
- The failure modes are not symmetric. An oversized bundle is a logistics cost the operator
  can see and plan around BEFORE the media crosses the boundary. A missing image is discovered
  AFTER it crossed, in the one environment where "go fetch the other image" is precisely the
  thing that cannot be done. Charter principle 5 makes air-gap first-class; a bundle that
  silently cannot run a feature the operator enabled is not first-class.
- Charter principle 7 puts Simplicity first. One unconditional list needs no new flag, no new
  conditional path in install.sh, and no way to build a bundle that is wrong.
```

THE RESIDUAL, STATED RATHER THAN PAPERED OVER: `scp-runner-scan` is the largest image here (a Fedora base carrying `oscap` + the SSG datastreams + `trivy` + a baked vulnerability DB), and it is only ever launched by the COMMANDER (ADR-0020 — scanning is commander-resident; outposts and retrans own no scanner). A per-role bundle would let outpost media drop it. There is no per-role bundle today — one release artifact installs every role — and inventing one to save space on a medium that is already carrying Argo CD and Gitea is the wrong trade at this size. If per-role bundles ever arrive, THIS list is where the role facet belongs.

### §17. The three ephemeral runner images the exception is built in

The three ephemeral single-shot runner images the Managed Execution Exception is implemented in (charter principle 1 + its `scp-managed-scan` / `scp-managed-dep` amendments). Named as a CLASS rather than one-by-one so `bundle-images.test.ts` can hold the class against `apps/runner-*` — the property that made the M13.3b/M21.5 gap possible was that nobody could enumerate it.

### §18. Bundled Gitea (Mode B — the DEFAULT unified registry, ADR-0012)

Bundled Gitea (Mode B — the DEFAULT unified registry, ADR-0012). Single image: Gitea runs self-contained on SQLite (chart v12.6.0 minimal profile — the only upstream busybox ref was the helm-test Pod, which is stripped from the vendored manifest). install.sh retargets it onto bundledExecutor.gitea.image. Harbor is REMOVED from the bundled stack; an existing Harbor is served via the import path (coordinated as an execution system), not bundled.

## `deploy/airgap/src/checksums.ts`

### §19. CHECKSUMS.txt in sha256sum format, dependency-free

`CHECKSUMS.txt` generation/parsing — the coreutils `sha256sum`-format manifest the milestone brief asks for ("checksums file, e.g. sha256sum-format CHECKSUMS.txt"). Kept dependency-free (`node:crypto`/`node:fs` only) and pure enough to unit test without touching skopeo/cosign.

Format: one line per file, `<64-hex-char sha256>  <path relative to bundle root>\n` (two spaces, matching `sha256sum`'s own output so `sha256sum -c CHECKSUMS.txt` — a tool every Linux/macOS box already has — works as a manual sanity check even without this package's own verify-bundle.ts).

### §20. Entries for every bundle file, excluding itself and its sig

Compute a CHECKSUMS.txt-shaped entry list for every file under `bundleRoot`, excluding the checksums file itself and its signature (they can't checksum themselves, and the signature file's own integrity is what covers CHECKSUMS.txt).

### §21. Verify every entry; the installer's exit code hinges on it

Verify every entry in `expected` against the real files under `bundleRoot`. Returns an empty array on success. This is the function verify-bundle.ts's exit code hinges on — it must never silently pass a bundle where a file was added, removed, or modified.

## `deploy/airgap/src/ci-offline-mirror.test.ts`

### §22. THE OFFLINE-CI GATE

THE OFFLINE-CI GATE — "everything, CI included, must run offline" as a CHECK, not a claim

Charter principle 5 and the working convention "Tests never touch the internet". CI was breaking both: `promotion-scan-step.integration.test.ts` pulled its scan subjects straight from Docker Hub, `oidc.integration.test.ts` pulled Keycloak from quay.io, and the two pinned-CLI installers `docker create`d out of quay.io/ghcr.io — all on the REQUIRED integration gate. Measured over ~31 days of history, ~13% of failing integration-shard jobs (3 of 23, on PR branches AND on `main`) were external-registry failures rather than anything to do with the code.

`tools/ci-mirror/images.list` is the census that closed it. This file is what stops the census from rotting — and it exists because the LAST attempt at this property was a comment. Job 5's env block asserted, in prose, that ryuk was "THE LAST UNMIRRORED DOCKER HUB PULL ON THE REQUIRED GATE'S PATH"; four classes of pull were open at the time, and stayed open for months behind that sentence. A well-written comment naming a hazard is a signal to sweep, not evidence it was handled (CLAUDE.md, "census by property, not by symptom").

WHAT THIS PROVES, AND WHAT IT CANNOT — read `@scp/source-census`'s own module doc first
This is a SOURCE CENSUS: it reads the repo's own text and asserts what it still says. It proves a NECESSARY condition ("no file names an image the mirror does not carry"), never a sufficient one. It cannot see an image name assembled at runtime, one arriving through an env var this file does not know about, or a `docker pull` inside a shell script a test spawns.

THE RUNNING HALF IS THE `blackhole` STEP in workflow job 5: before the suite starts, every upstream registry this manifest mirrors is pointed at 127.0.0.1 in /etc/hosts. A pull this census cannot see still cannot succeed. Read the two together — the census says "you did not write it down", the blackhole says "and it would not have worked anyway".

NUL-BYTE NOTE: the walker below reads files through Node, which is why it sees all of them. Four source files in this repo contain NUL bytes, and plain `grep -r` skips those SILENTLY — printing nothing at all, not even "Binary file matches". A census run with `grep` (rather than `grep -a`) would report a clean sweep over a tree it never fully read.

### §23. Every `.ts` in the tree EXCEPT this file

Every `.ts` in the tree EXCEPT this file. A census that quotes the patterns it hunts for cannot be a subject of itself — the example refs in the assertion messages and doc comments above would be reported as real findings. This is the only exclusion, and it is the file doing the excluding; anything else earning one would be a filter, and a filter is where the next instance hides.

### §24. Read and comment-strip the whole tree ONCE

Read and comment-strip the whole tree ONCE. Three assertions below walk it, and doing the strip per assertion put this file over vitest's 5s default the moment the suite ran alongside its siblings rather than alone — a census that times out is a census that does not run.

### §25. Testcontainers pulls whatever string it is handed

Testcontainers pulls whatever string it is handed. This is the assertion that would have caught `quay.io/keycloak/keycloak:26.0` — the one Testcontainers image job 4d never mirrored, invisible to a sweep that looked only for `docker.io`.

NOT restricted to `*.test.ts`, deliberately: `test-support/global-setup.ts` is the file that starts the Postgres every integration test uses, and it is not a test file. A filter is where the next instance hides.

### §26. skopeo talks to a registry and never sees the local store

skopeo talks to a registry directly and never consults the local Docker image store, so the `docker tag` that keeps Testcontainers off Docker Hub is invisible to it. A hardcoded external host in a `docker://` source is therefore a live pull no amount of mirroring can intercept — which is precisely how `docker://docker.io/library/debian:11` took a whole suite down with a 502 and ZERO individual test failures. Those refs must be built from a configurable prefix.

### §27. THE VAR MUST ARRIVE, NOT MERELY BE EXPORTED

THE VAR MUST ARRIVE, NOT MERELY BE EXPORTED — the gap that took both shards red
`ci-mirror.sh seed` wrote `SCP_TEST_SUBJECT_REGISTRY` into $GITHUB_ENV, the workflow log showed it set on every later step, and the two subject suites read it with a `docker.io/library` fallback — and the suites still went to Docker Hub, because the suites do not run in the job's shell. They run under `turbo run test:integration`, and turbo's env mode is STRICT: a task receives only the vars named in its `env`/`passThroughEnv` plus a small system set. An undeclared var is not passed through empty, it is ABSENT — so `?? "docker.io/library"` took the fallback and the blackhole, working exactly as designed, denied it.

The existing assertion above ("the subject suites read the same env var ci-mirror.sh exports") passed throughout. It checked the producer and it checked the consumer; nothing checked the pipe between them. That is the shape this block exists to make impossible for the NEXT var: the repo had already paid for this lesson once — `SCP_RUNNER_*_IMAGE_REF` are in `passThroughEnv` for the same reason — and paying twice is what a census is supposed to prevent.

### §28. The only seeded vars whose consumer runs outside turbo

The ONLY seeded vars whose consumer is a workflow step that runs directly, outside turbo:

```text
- `SCP_SKOPEO_IMAGE_REF` / `SCP_COSIGN_IMAGE_REF` — the two pinned-CLI installers, which are
  their own `run:` steps.
- `SKOPEO_IMAGE` / `COSIGN_IMAGE` / `NODE_IMAGE` — the root Dockerfile's own build ARGs,
  read by BUILDKIT during `docker compose build`. The first two were added 2026-08-18 with
  consumer form 4 (see `tools/ci-mirror/images.list`): a digest-pinned `FROM` resolves at
  the registry, so it can be served by neither a local re-tag nor an installer's env var,
  and until these were exported the image build pulled quay.io LIVE. NODE_IMAGE joined
  2026-08-31 when the base-image `FROM node:22-trixie-slim` turned out to be the same form,
  still pulling docker.io live. An image build is not a turbo task and never will be, so
  `passThroughEnv` is the wrong home for them — but they are still seeded vars, so they
  still have to be declared SOMEWHERE, which is what this list is for.
```

Every other seeded var is read inside the test process, which turbo starts. An entry here is a claim that gets checked below, not an exemption — and a NEW seeded var is required to pass by default.

## `deploy/airgap/src/compose-retarget.ts`

### §29. Derives the air-gap compose variant at bundle build time

Derives the air-gap variant of `deploy/compose/docker-compose.yml` at BUNDLE BUILD time.

The dev/eval compose file (DESIGN.md §16 "Dev / evaluation") builds the `scp` service from source (`build: {context: ../.., dockerfile: Dockerfile}`) — correct for a developer checkout, useless for an air-gapped bundle where there is no source tree, only a pre-built OCI-layout image. This module parses the real compose file with the `yaml` package (already a repo dependency pattern — see `tools/helm-verify`) and replaces `build:` with `image: __SCPD_IMAGE_REF__`, and pins `postgres`'s `image:` to `__POSTGRES_IMAGE_REF__` — both placeholder tokens install.sh substitutes with the real retargeted-registry, digest-pinned refs via a plain `sed`, so install.sh never needs a YAML parser.

Deriving this from the real compose file (rather than hand-maintaining a second static template) means the two can't silently drift — any change to service names, env vars, health checks, volumes, or ports in the source file flows through automatically, and this module's own test (`compose-retarget.test.ts`) asserts the specific transform (build->image, postgres->pinned image) rather than the whole file's content, so unrelated source-file edits don't spuriously fail it.

### §30. Deliberately does not spell the placeholders in its own text

Deliberately does NOT interpolate SCPD_IMAGE_PLACEHOLDER/POSTGRES_IMAGE_PLACEHOLDER into this comment's own text: install.sh's retarget step is a blanket `sed` substitution over the whole file (see install.sh's compose-mode block), so a literal occurrence of the placeholder token HERE would get rewritten too, garbling the comment with a live digest string spliced into what should stay static instructional text — caught by actually running install.sh --mode compose end to end and reading the output file, not by inspection alone.

### §31. Transform the source compose YAML text into the air-gap variant

Transform the source compose YAML text into the air-gap variant. Throws if the expected `services.scp`/`services.postgres` shape isn't present — a structural change to the source compose file that this function doesn't know how to retarget should fail loudly at bundle-build time, not silently ship a broken compose file into the tarball.

## `deploy/airgap/src/cosign-bin.test.ts`

### §32. Parse the pin file as KEY=VALUE, anchored and comment-proof

Parse `tools/cosign/pin.env` (the single source of truth) as KEY=VALUE pairs.

Already comment-proof, and deliberately left as-is: the key pattern is anchored to the start of the trimmed line and admits only `[A-Z_]`, so a `#`-prefixed line cannot become a pin. It is the shape `@scp/source-census`'s `atLineStart` generalises.

### §33. The cosign pin is a QUADRUPLE-string coupling

The cosign pin is a QUADRUPLE-string coupling — it appears in `tools/cosign/pin.env`, the Dockerfile's build ARG, this package's TypeScript constants, and `scripts/doctor.mjs`. Nothing at build or run time forces those to agree, so a stale copy would silently mean "the image ships binary A while the code asserts version B". These tests are that forcing function.

WHY THE READS BELOW GO THROUGH `@scp/source-census` AND NOT `readFileSync`
MEASURED 2026-08-17: commenting out `ARG COSIGN_IMAGE=…` at `Dockerfile:28` left this file green at 10 passed / 1 skipped. A `.toContain(…)` over raw text cannot tell a live pin from a commented-out one, so the gate whose entire purpose is "the runner image cannot ship an unvetted binary" was satisfied by a DESCRIPTION of the pin. Three files in three packages had it.

The fix is per-language, because the languages are: the Dockerfile comments with `#` (so a presence assertion is anchored to the start of a line, where a `#` cannot precede it), `doctor.mjs` comments with `//` (so it is read stripped), and the workflows are YAML whose token sits mid-line (so whole-line `#` comments are removed and the token matched inside what is left).

AND THE LIMIT, because an over-claiming census is what produced this: anchoring fixes the comment case and NO MORE. These assertions still cannot see a Dockerfile stage nothing `COPY --from`s, a workflow step disabled by an `if:` above it, or the pin appearing inside a quoted string. What the pin gate CANNOT be talked out of is elsewhere: the fail-closed `cosign version` assertion at the bottom of this file, which runs the resolved binary whenever a pinned one is present.

### §34. The real thing

The real thing: when a pinned cosign is actually present (inside the runtime image, or in CI where scripts/install-pinned-cosign.sh put one and pointed SCP_COSIGN_BIN at it), its reported version MUST equal the pin. Skips — never falsely fails — where no pinned binary exists.

## `deploy/airgap/src/cosign-bin.ts`

### §35. The cosign binary resolver

The cosign binary resolver (pin-vs-probe) now lives in the shared @scp/cosign package (M17.3 E2) so the same single keyful/offline cosign implementation can be reused by both the release/bundle path (this package) and — later, in E6 — the server. This file is a thin re-export that keeps every existing @scp/airgap call site (and the install-sh-tamper suite) importing from `./cosign-bin.js` exactly as before; the behavior is unchanged. See `packages/cosign/src/cosign-bin.ts` for the implementation and its full doc comment.

## `deploy/airgap/src/cosign.ts`

### §36. The cosign wrapper now lives in the shared package

The keyful/offline cosign signing/verification wrapper now lives in the shared @scp/cosign package (M17.3 E2) so the same single implementation — the air-gap-critical flag set and the E1 pinned-vs-probe resolver — can be reused by both the release/bundle path (this package) and, later in E6, the server. This file is a thin re-export that keeps every existing @scp/airgap call site (build-bundle.ts, verify-bundle.ts, the install-sh-tamper suite) importing from `./cosign.js` exactly as before; signing behavior is unchanged. See `packages/cosign/src/cosign.ts` for the implementation and the full flag rationale.

## `deploy/airgap/src/index.ts`

### §37. @scp/airgap — air-gap bundle builder/verifier

@scp/airgap — air-gap bundle builder/verifier (DESIGN.md §16, BUILD_AND_TEST.md §8 M8).

This module re-exports the package's pure-logic/wrapper surface for programmatic use; the actual CLI entrypoints are `build-bundle.ts`/`verify-bundle.ts` (run via the `bundle`/`verify` pnpm scripts — see README.md), not this file.

## `deploy/airgap/src/install-sh-tamper.test.ts`

### §38. The installer checks its tools before it verifies anything

install.sh checks for `skopeo`/`cosign`/(`helm`|`docker`) on PATH unconditionally, even under `--dry-run` — before it ever verifies a signature. Gating on all three (like `scripts/airgap-drill.sh`/`deploy-drills.yml` already do for the same reason) means this suite exercises the REAL script wherever these documented prerequisites (BUILD_AND_TEST.md §1) are installed, and skips cleanly — never a false failure — where they aren't.

`which("cosign")` is checked DIRECTLY and deliberately, not via the pinned resolution in cosign-bin.ts: install.sh's whole trust model is that the operator supplies cosign EXTERNALLY, on PATH. A cosign that exists only at the vendored in-image path would not satisfy install.sh, so it must not un-skip this suite either. (CI does put the pinned binary on PATH — scripts/install-pinned-cosign.sh — so these assertions really run there.)

### §39. A fresh, ephemeral cosign keypair

A fresh, ephemeral cosign keypair — deliberately NOT `resolveSigningKey` from `./cosign.js`, which honors an ambient `COSIGN_KEY` env var: if that happened to be set in the environment this suite runs in, two calls would resolve to the SAME real key, silently defeating the "legit key vs. attacker key are DIFFERENT keys" premise this suite depends on. This always generates a brand-new keypair, independent of any ambient cosign env var.

### §40. install.sh's trust-root regression suite

install.sh's trust-root regression suite (adversarial review of PR #15, CRITICAL #1): a previous version of `install.sh` cosign-verified everything against the `cosign.pub` file SHIPPED INSIDE the bundle it was verifying — self-referential, so an attacker who substitutes the whole bundle can simply re-sign everything with their own key and ship their own matching `cosign.pub` alongside it; `install.sh` would verify cleanly. `deploy/airgap/src/verify-bundle.ts` already required an external `--pubkey` with no in-bundle fallback (see its own module doc); this suite proves `install.sh` (the bash script, exercised as a real subprocess — not just the TypeScript verifier) now has the same property.

This is genuinely exercising the install.sh SCRIPT (spawned as `bash install.sh ...`), not a reimplementation of its logic — the exact class of gap a purely-TypeScript test suite could miss (README.md's own "Testing" section, before this fix, said the install.sh mechanics were "exercised manually end-to-end", never as a permanent automated regression test).

### §41. Runs the installer and returns its outcome instead of throwing

Runs install.sh and returns {ok, stdout, stderr, exitCode} instead of throwing, whichever way it exits. install.sh `cd`s to ITS OWN location before doing anything (`SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` — see its header comment: real usage always runs it FROM INSIDE an extracted bundle directory, e.g. `./scp-bundle-<version>/install.sh`), so this copies the real script INTO the fixture bundle dir first — running it from its source location in this repo would have it look for CHECKSUMS.txt etc. next to the SOURCE file, not the fixture.

### §42. THE ATTACK (adversarial review's exact scenario)

THE ATTACK (adversarial review's exact scenario): substitute the whole bundle — tamper with the payload, generate a BRAND NEW keypair the attacker controls, and re-sign the (now-tampered) CHECKSUMS.txt with it. Pre-fix, install.sh would have trusted whatever `cosign.pub` the attacker also shipped inside the bundle — this test never even writes an in-bundle cosign.pub, because the fix means it must never be read.

## `deploy/airgap/src/manifest.test.ts`

### §43. The name-to-variable mapping, exactly as the installer does it

"scpd" -> SCPD, "scp-runner-iac" -> SCP_RUNNER_IAC, "postgres-eval" -> POSTGRES_EVAL — exactly what install.sh's `printf '%s' "$name" | tr '[:lower:]' '[:upper:]' | tr -c 'A-Z0-9' '_'` pipeline produces (verified interactively against this repo's bash/tr; see install.sh's own comment on the printf-vs-echo trailing-underscore pitfall).

The two runners added in M21.7 are here for that derivation specifically: install.sh reads `SCP_RUNNER_SCAN_*` / `SCP_RUNNER_DEP_*` by name when it prints their pinned refs, so a name whose stem came out differently (a stray separator, a collision) would break the opt-in path silently. Both derive with a single underscore per hyphen and no trailing separator.

## `deploy/airgap/src/manifest.ts`

### §44. Two renderings of one manifest: JSON for Node, flat for shell

`manifest.json` (rich, for this package's own Node tooling) and `manifest.sh` (flat `KEY=value` shell-sourceable, for install.sh) — two renderings of the same BundleManifest so install.sh never needs a JSON parser (`jq` is not in this project's documented toolchain, BUILD_AND_TEST.md §1) while verify-bundle.ts/tests get a real structured format.

`manifest.sh` variable naming: `<UPPER_SNAKE_NAME>_DIGEST`, `_SOURCE_REF`, `_OCI_TAG` per image, plus `BUNDLE_VERSION`/`BUNDLE_BUILT_AT`, and a `BUNDLE_IMAGE_NAMES` space-separated list so install.sh can loop over images without knowing their names ahead of time.

## `deploy/airgap/src/oci-layout.test.ts`

### §45. Builds a minimal-but-real OCI-layout directory by hand

Builds a minimal-but-real OCI-layout directory by hand (no skopeo dependency for these unit tests — a real skopeo-produced layout is exercised separately in the package README's manual end-to-end run). The shape mirrors exactly what `skopeo copy ... oci:<dir>:<tag>` writes: `index.json` naming one manifest blob by digest, and that blob's bytes stored content- addressed at `blobs/sha256/<hex>`.

## `deploy/airgap/src/oci-layout.ts`

### §46. Pure logic for reading and self-verifying an OCI-layout directory

Pure logic for reading and self-verifying an OCI-layout directory (the format `skopeo copy ... oci:<dir>:<tag>` produces — see skopeo.ts for the invocation). No shelling out here: OCI layout is just files on disk (`index.json` + `blobs/<alg>/<hex>`), and its own filenames are content digests by construction, which gives us a strong, cheap, offline integrity check that doesn't need skopeo or cosign at all — re-hash every blob and confirm the filename matches.

Layered with cosign.ts's signature check (see verify-bundle.ts): this module proves the OCI layout directory is INTERNALLY CONSISTENT (no bit-flip, no swapped blob); the cosign signature proves WE produced the specific manifest digest it's internally consistent with. Either check alone is incomplete — a corrupted-but-unsigned-claim directory passes this check trivially by just being self-consistent garbage; a validly-signed digest string next to a tampered blob directory fails only THIS check. Both must pass.

### §47. Self-verify an OCI-layout directory

Self-verify an OCI-layout directory: (1) every blob under blobs/<alg>/<hex> re-hashes to its own filename, and (2) index.json's recorded manifest digest matches the manifest blob's ACTUAL content digest (catches an index.json that was hand-edited to point at a different, possibly-untampered-looking, blob than what's really there). Returns an empty array on success; never throws on a tampered layout — tampering is reported as findings, not exceptions, so callers (verify-bundle.ts, install.sh's Node-free bash equivalent) can print every problem found rather than stopping at the first one.

### §48. Structurally unreachable, kept as a named assertion

Structurally unreachable given the per-blob loop above already checks this file, but kept as an explicit, named assertion — this is the specific property ("index.json's claimed digest is the manifest's real digest") the milestone brief cares about, and a reader should be able to find it checked by name, not inferred from the generic blob loop above.

## `deploy/airgap/src/offline-install-doc.ts`

### §49. A purpose-written operator doc, not a copied design file

Purpose-written operator-facing doc, bundled as `docs/OFFLINE_INSTALL.md`.

Deliberate choice over just copying BUILD_AND_TEST.md/DESIGN.md verbatim (which this package ALSO copies in, unmodified, as background reference material — see build-bundle.ts): those two docs are written for CONTRIBUTORS building CommanderSCP from source, full of pnpm/turbo/CI detail an air-gapped OPERATOR installing a pre-built bundle neither has nor needs. This file is the thing an operator actually reads: what's in the tarball, how to verify it, how to run install.sh, what "the same bundle is the upgrade package" means in practice.

The `images/` listing is GENERATED from `bundle-images.ts` rather than written out here. It used to be prose, and prose drifted: it still named three images long after the bundle had grown to nine, and it never named `scp-runner-scan`/`scp-runner-dep` because the bundle never carried them (M21.7 item 1). An operator's inventory of what crossed the air gap is exactly the wrong thing to maintain by hand in a second place.

## `deploy/airgap/src/skopeo-bin.test.ts`

### §50. Parse a `tools/<pin>/pin.env`

Parse a `tools/<pin>/pin.env` (each a single source of truth) as KEY=VALUE pairs. One PARSER for every pin file — the file format is one format, and a parsing fix applied to a per-pin copy and not its twin is the comment-proof bug class this function exists to prevent — while every ASSERTION stays per-pin at the call sites, so separate pins keep separate verdicts (the budget census's rule).

Comment-proof, like cosign-bin.test.ts's twin: the key pattern is anchored to the start of the trimmed line and admits only `[A-Z_0-9]`, so a `#`-prefixed line cannot become a pin.

### §51. The skopeo pin is a TRIPLE-string coupling

The skopeo pin is a TRIPLE-string coupling — `tools/skopeo/pin.env`, the Dockerfile's build ARG + COPY block, and `packages/cosign/src/skopeo-bin.ts`'s constants. Nothing at build or run time forces those to agree, so a stale copy would silently mean "the image ships binary A while the code asserts version B". These tests are that forcing function — the same shape as cosign-bin.test.ts, which guards the cosign pin's quadruple coupling.

IT SHARED THAT FILE'S DEFECT TOO. MEASURED 2026-08-17: commenting out `ARG SKOPEO_IMAGE=` in the root Dockerfile and `d=/opt/scp/libexec/skopeo` in the wrapper left this file green at 10 passed / 1 skipped, because `.toContain(…)` over raw text cannot tell a live line from a described one. Every presence assertion below is therefore anchored with `@scp/source-census`'s `atLineStart` — each of these lines genuinely begins its line, so the anchor costs nothing and a `#` prefix can no longer satisfy it.

THE LIMIT: anchoring fixes the comment case and no more (see the package doc). It cannot see a `COPY` in a stage the final image never draws from, and it cannot tell that the vendored library closure is complete. The assertion that cannot be talked out of is the fail-closed `skopeo --version` check at the bottom of this file, which runs the resolved binary.

### §52. Added after the pinned digest vanished and took E2E red

ADDED 2026-08-18, after the pinned skopeo digest was DELETED from quay.io (404) and took every E2E job red at image build, five steps before a test ran. The second quay.io outage to do so.

`tools/ci-mirror/images.list` mirrors every third-party image to GHCR so CI never pulls live, and enumerated three consumer forms. A DIGEST-PINNED `FROM` is a fourth, and neither mechanism reaches it: a `FROM …@sha256:…` resolves AT THE REGISTRY, so a local re-tag is invisible to it, and the `SCP_*_IMAGE_REF` vars are read by the installer scripts rather than by BuildKit. The census that produced forms 1-3 was a census of TEST consumers, and an image build is not a test.

THIS ASSERTS THE THREE HALVES TOGETHER, because any one of them alone is silently inert: the Dockerfile must take the image from an ARG, compose must pass that ARG through, and the mirror must export it under that exact name.

### §53. A CENSUS, NOT A CASE

A CENSUS, NOT A CASE — and this is the correction that matters. The first version of this guard read `deploy/compose/docker-compose.yml` BY NAME, and a second compose file (`docker-compose.federation.yml`, which e2e-m6 builds the very same Dockerfile with) had no `build.args` at all. One file fixed, one file still pulling quay.io live, and a green guard over the top. The property is "every compose file that BUILDS the root Dockerfile", so the population is discovered from disk rather than typed here.

### §54. PASS-THROUGH FORM, and the shape is the assertion

PASS-THROUGH FORM, and the shape is the assertion. `- SKOPEO_IMAGE` with no value means "take it from the environment, and omit the arg entirely when unset", so a developer running `docker compose up` with no mirror still gets the Dockerfile's pinned default. Writing `SKOPEO_IMAGE=${SCP_SKOPEO_IMAGE_REF}` would pass an EMPTY string when unset and break `FROM` for everyone outside CI — which is why this pins the form and not merely the presence.

### §55. The real thing

The real thing: when a pinned skopeo is actually present (inside the runtime image, or wherever SCP_SKOPEO_BIN points at an extracted pin), its reported version MUST equal the pin. Skips — never falsely fails — where no pinned binary exists (dev machines and today's CI, whose PATH skopeo serves the release-path suites and is deliberately unpinned).

## `deploy/airgap/src/skopeo.ts`

### §56. `skopeo` invocations for the BUILD side of the air-gap bundle

`skopeo` invocations for the BUILD side of the air-gap bundle: docker-daemon:<image> (or docker://<image>) --> oci:<dir>:<tag>, used by build-bundle.ts. The INSTALL-time direction (oci:<dir>:<tag> --> docker://<customer-registry>/<name>:<tag>, plus the post-copy `skopeo inspect --format '{{.Digest}}'` re-verification) is deliberately NOT duplicated here as a Node wrapper — that logic lives directly in install.sh (bash), which is the artifact that actually runs on an operator's air-gapped install target and must not depend on this project's own Node/pnpm toolchain being present there. Keeping a second, untested, uncalled Node implementation of the same push+re-verify logic here would just be a second place for the two to silently drift; see install.sh's own header comment for that logic's real implementation.

`--src-daemon-host` matters on this dev machine specifically: Docker Desktop/Colima/Podman don't all live at the `unix:///var/run/docker.sock` skopeo defaults to, so this module resolves the daemon socket the same way `docker context inspect` would rather than hard-coding a path (verified empirically against this machine's Colima context — see the package README).

### §57. Best-effort resolution of the local Docker socket

Best-effort resolution of the local Docker daemon's socket, so `docker-daemon:` sources work regardless of whether the engine is Docker Desktop, Colima, or plain dockerd. Falls back to undefined (skopeo's own default, `/var/run/docker.sock`) if `docker context inspect` isn't available or doesn't report a unix socket (e.g. a remote/TCP context) — in that case skopeo's default or the operator's own `DOCKER_HOST` env var applies unmodified.

## `deploy/airgap/src/types.ts`

### §58. Shared types for the air-gap bundle builder/verifier

Shared types for the air-gap bundle builder/verifier (DESIGN.md §16 "Air-gapped bundle", BUILD_AND_TEST.md §8 M8). Kept dependency-free so it can be imported from both the CLI entrypoints and the pure-logic modules under test.

## `deploy/airgap/src/verify-bundle.ts`

### §59. The standalone counterpart to the installer's verify step

@scp/airgap verify-bundle — the standalone counterpart to install.sh's own built-in verify step. Cosign-verifies every image + the bundle's checksums (and, given a tarball, the tarball itself) against a SUPPLIED public key, and fails loudly — non-zero exit, every problem listed — on any signature mismatch or content tampering. Never trusts a `cosign.pub` found inside the thing it's verifying as its OWN root of trust for the outer tarball check (see --pubkey below); see deploy/airgap/README.md for the trust model this implements.

Run: `pnpm --filter @scp/airgap verify -- --pubkey cosign.pub --dir dist-bundle/scp-bundle-1.0.0-rc` or `... --pubkey cosign.pub --tarball dist-bundle/scp-bundle-1.0.0-rc.tar.gz`.

## `deploy/airgap/vitest.config.ts`

### §60. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §61. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
