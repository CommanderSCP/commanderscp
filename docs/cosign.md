# cosign

Long-form reference for the **cosign** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 28 of 28 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`packages/cosign/src/cosign-bin.ts`](#packages-cosign-src-cosign-bin-ts) — §1–§4
- [`packages/cosign/src/cosign.test.ts`](#packages-cosign-src-cosign-test-ts) — §5–§5
- [`packages/cosign/src/cosign.ts`](#packages-cosign-src-cosign-ts) — §6–§17
- [`packages/cosign/src/exec.ts`](#packages-cosign-src-exec-ts) — §18–§18
- [`packages/cosign/src/index.ts`](#packages-cosign-src-index-ts) — §19–§19
- [`packages/cosign/src/keygen.ts`](#packages-cosign-src-keygen-ts) — §20–§20
- [`packages/cosign/src/skopeo-bin.ts`](#packages-cosign-src-skopeo-bin-ts) — §21–§26
- [`packages/cosign/vitest.config.ts`](#packages-cosign-vitest-config-ts) — §27–§28

## `packages/cosign/src/cosign-bin.ts`

### §1. Which cosign binary runs, and is it the one we pinned

THE single place that answers "which cosign binary do we run, and is it the one we pinned?".

M17.3 E1 vendors a digest-pinned cosign into the SCP runtime image (Dockerfile's `cosign` stage; provenance in `tools/cosign/README.md`; pin values in `tools/cosign/pin.env`). That creates two genuinely different situations, and conflating them is how you either (a) probe a binary you already know everything about on a signing hot path, or (b) silently assume an operator's cosign behaves like ours:

```text
PINNED   — the vendored binary at `VENDORED_COSIGN_PATH` (or an explicit
           `SCP_COSIGN_BIN` override). We built the image, we know the exact release, so we
           use a STATIC known-good flag set and FAIL CLOSED if `cosign version` doesn't
           report the pinned version. A cosign that isn't the cosign we vetted is not a
           cosign we sign with.
UNPINNED — `cosign` resolved from PATH, i.e. an operator-supplied build. Air-gap operators
           legitimately bring their own (BUILD_AND_TEST.md §1), so the version-ADAPTIVE
           `--help` probing in cosign.ts stays exactly as it was and remains the only
           behavior on this path.
```

`--tlog-upload=false` (sign) and `--insecure-ignore-tlog=true` (verify) are UNCONDITIONAL on both paths — they are the flags that keep signing from touching the public Rekor log, i.e. charter principle 5, not a version-portability detail. See cosign.ts's module comment.

This module deliberately holds NO product behavior: nothing here signs, verifies, or decides policy. It is resolution + provenance assertion only.

### §2. The upstream image digest, so a system can report provenance

The exact upstream image the binary is taken from: the sigstore cosign image's **linux/amd64 platform manifest** digest. Recorded here so a running system can report its own provenance (scripts/doctor.mjs) without shelling out to a registry.

### §3. Resolve the cosign to use, preferring the pinned binary. Order

Resolve the cosign to use, preferring the pinned binary.

Order: `SCP_COSIGN_BIN` → the vendored image path → PATH. Note the vendored path is `/opt/scp/bin/cosign` precisely so this check can never accidentally pick up a Homebrew/apt cosign at `/usr/local/bin/cosign` and mislabel someone else's build as "pinned".

### §4. FAIL CLOSED: throw unless `bin` really is the pinned release

FAIL CLOSED: throw unless `bin` really is the pinned release.

Called before every signing/verification run on the pinned path. The failure mode this exists for is a supply-chain one — an image rebuilt against a moved tag, an `SCP_COSIGN_BIN` pointed at some other build — and the only safe response to "the binary isn't the one we vetted" is to refuse, never to shrug and probe it like an operator binary.

## `packages/cosign/src/cosign.test.ts`

### §5. Offline unit tests: never the real binary, never the network

These are the OFFLINE unit tests for the lifted @scp/cosign wrapper (M17.3 E2). They must never touch the real cosign binary or the network — the real-binary sign/verify path stays covered by deploy/airgap's install-sh-tamper suite (the zero-behavior-change proof). Here we assert the two things that CAN be proven without a genuine cosign: 1. the sign-blob FLAG BUILDER — its keyful/offline invariants and the pinned-vs-probe split; 2. the E1 binary RESOLUTION (pin-vs-probe) branch — exercised against a FAKE cosign shim on PATH rather than a real install.

The `--use-signing-config` probe caches its result at module scope, so every probe-branch case re-imports the module fresh via `vi.resetModules()` to get a clean cache.

## `packages/cosign/src/cosign.ts`

### §6. cosign signing/verification for the air-gap bundle

cosign signing/verification for the air-gap bundle.

## Why sign-blob, not `cosign sign`

`cosign sign` attaches a signature to an image IN A REGISTRY (it pushes a `.sig` artifact next to the manifest). At bundle-BUILD time our images only exist as local OCI-layout directories — there is no registry yet to attach anything to (the registry is the CUSTOMER's, chosen at install time, per-deployment). So this package signs a small **digest file** per image (`sha256:<manifest digest>`, produced by oci-layout.ts) with `cosign sign-blob`, plus the bundle's `CHECKSUMS.txt` for whole-bundle integrity. `cosign sign`/`cosign verify` against the registry image itself becomes available to the OPERATOR after install.sh's retarget-push, as a documented optional extra (see install.sh's own comments) — it's not this package's job to do that on the operator's behalf, since it doesn't control the customer registry's credentials.

## The air-gap-critical flag combination (portable across a range of cosign versions)

`cosign sign-blob` defaults to uploading every signature to the **public** Rekor transparency log (`https://rekor.sigstore.dev`) even for pure local-keypair signing — confirmed by pointing HTTP(S)_PROXY at a closed port and watching `sign-blob` fail with `Post "https://rekor.sigstore.dev/api/v1/log/entries": ... connection refused`. That is a hard violation of CLAUDE.md principle #5 ("no runtime network calls to the outside world") and of this milestone's own "NO runtime network calls" requirement — bundle building must never depend on reaching the public internet, let alone leak a customer's private image digests to a public transparency log.

The essential, long-stable fix is **`--tlog-upload=false`** — the flag that disables the Rekor upload. It is present (deprecated but honored) across cosign 2.x and 3.x and is the ONE flag that actually prevents the egress. Alongside it we pass `--new-bundle-format=false --output-signature <file> --yes` to get the legacy detached-signature file this package stores in the bundle (the format `verifyBlobDetached` and install.sh's `cosign verify-blob --signature` both consume).

`--use-signing-config=false` is handled DIFFERENTLY on the two cosign paths this package now has (resolution lives in cosign-bin.ts, M17.3 E1): - PINNED cosign (the digest-pinned binary vendored into the runtime image, or an explicit `SCP_COSIGN_BIN`): the release is known — v3.1.2, a build that HAS the flag — so the flag set is a static constant and `cosign()` fail-closed asserts the reported version matches the pin before any call. No `--help` subprocess runs on the signing path. - UNPINNED cosign (an operator's own build on PATH — air-gap operators legitimately bring their own, BUILD_AND_TEST.md §1): the original version-ADAPTIVE probing is kept verbatim, because the flag's handling differs sharply across versions: - NEWER cosign (advertises `--use-signing-config`, ~2.5+/3.x): `--use-signing-config` DEFAULTS to `true`, and cosign then REJECTS `--tlog-upload=false` with "`--tlog-upload=false is not supported with --signing-config or --use-signing-config`". So on these builds we MUST also pass `--use-signing-config=false`. - OLDER cosign (does NOT have the flag — e.g. cosign 2.x): passing `--use-signing-config=false` fails with "`unknown flag: --use-signing-config`" (exactly the CI red this replaced), and it isn't needed anyway — `--tlog-upload=false` alone prevents the upload. So we OMIT it there. We detect the flag from `cosign sign-blob --help` (it's listed on versions that have it) and add `--use-signing-config=false` only when present. Either way NOTHING is uploaded.

`verifyBlobDetached` mirrors the sign side with `--insecure-ignore-tlog=true` (a stable flag present across versions) — we deliberately never wrote a tlog entry, so asking cosign to check for one would always — correctly, but uselessly — fail.

Egress verified against a closed proxy on the PINNED v3.1.2 binary (and previously on v3.1.1): with the full flag set, `sign-blob` succeeds behind `HTTPS_PROXY=http://127.0.0.1:1` and the sig verifies — zero outbound connection attempts. If cosign's flags change again, re-run exactly that: set `HTTPS_PROXY=http://127.0.0.1:1` (a closed local port) and confirm sign/verify still succeed; if either ever tries the network it fails fast with `connection refused` instead of silently working. CI no longer installs cosign over the network at all — it extracts the SAME digest-pinned binary that ships in the image (scripts/install-pinned-cosign.sh, `.github/workflows/ci.yml`), so CI validates the binary production actually uses.

### §7. Resolve cosign and assert the pin before any invocation

Resolve cosign and, on the pinned path, assert it really is the pinned release before any call. Every cosign invocation in this module goes through here, so a wrong binary fails closed at the first use rather than producing signatures from an unvetted build.

### §8. Resolve which signing key to use. - CI/production

Resolve which signing key to use.

- CI/production: set `COSIGN_KEY` (path to a cosign-format private key file) and `COSIGN_PASSWORD` (its password — cosign's own conventional env var name; empty string is a valid password for an unencrypted key). `COSIGN_PUBLIC_KEY` should also be set to the matching public key path; if omitted, it's derived on the fly via `cosign public-key`. - Local dev/testing (no `COSIGN_KEY` set): generates a brand-new ephemeral key pair under `scratchDir` with an empty password, loudly logged as a TEST KEY. This keypair is never written anywhere under the repo or the bundle output except the public half, which is by design bundled as `cosign.pub` (a public key is not a secret) — the private half lives only in `scratchDir`, which callers are responsible for treating as ephemeral (e.g. an os.tmpdir() subdirectory, as build-bundle.ts does).

### §9. Whether the installed cosign advertises `--use-signing-config`

Whether the installed cosign advertises `--use-signing-config` (a newer flag, ~cosign 2.5+/3.x). Probed once from `cosign sign-blob --help` (the flag is listed there on versions that have it) and cached for the rest of the process. See the module doc comment for why this matters and signBlobFlags() for how it's used.

### §10. The portable sign-blob flags that upload nothing to Rekor

The portable `cosign sign-blob` flag set that produces a legacy detached signature and uploads NOTHING to the Rekor transparency log — see the module doc comment for the full rationale and the per-version behavior. `--tlog-upload=false` is the essential, long-stable egress-prevention flag; `--use-signing-config=false` is added ONLY when the installed cosign has it (newer builds make `--tlog-upload=false` conflict with its default `true`; older builds reject the flag as unknown and don't need it).

### §11. Pinned path: a static flag set, no `--help` probe when signing

PINNED path: we know exactly which release this is (asserted fail-closed by cosign() above), so the flag set is a STATIC known-good constant — no `--help` subprocess on a signing hot path to learn something the pin already tells us. Verified against the pinned v3.1.2 binary behind a closed proxy (HTTPS_PROXY=http://127.0.0.1:1): sign-blob + verify-blob both succeed with zero egress.

### §12. Sign an in-memory blob with in-memory key material

Sign an IN-MEMORY blob with IN-MEMORY cosign private-key material, returning the detached signature as a base64 string. The seam the SERVER (M17.3 E6) uses to cosign-sign a promotion MANIFEST with the org's `instance_cosign_keys` private key: it materializes the key + blob to a fresh, private scratch dir, runs the offline/air-gap `sign-blob` (the same `--tlog-upload=false` flag set as every other call here — NOTHING is uploaded to Rekor), reads the detached signature back, and SCRUBS the scratch dir (KEY FILE INCLUDED) before returning. No key material survives the call on disk, in success OR failure — the `finally` runs on both paths.

`privateKeyPem` is cosign's empty-password encrypted PEM (`COSIGN_PASSWORD=''`), exactly what `generateKeyPair`/`instance_cosign_keys` produce and store.

### §13. Verify a detached signature; a bad one is a false, not a throw

Verify a detached base64 `signature` over an IN-MEMORY blob against an IN-MEMORY cosign PUBLIC key PEM. Materializes all three to a scratch dir, runs `verify-blob` (`--insecure-ignore-tlog=true`, offline), scrubs, and returns a boolean. NEVER throws — a bad signature is a normal, expected outcome (a swapped/forged manifest), reported as `false`.

### §14. Allow HTTP / self-signed-TLS registries

Allow HTTP / self-signed-TLS registries. The outpost-local Gitea/Harbor registry an air-gap operator side-loads bytes into is commonly plain HTTP or self-signed — and it is SAFE to allow here because the artifact's authenticity is proven by the cosign SIGNATURE (verified against the exporter's distributed public key), NOT by registry transport security: a registry MITM cannot forge a signature that verifies against that key. Off by default (a TLS commander registry).

### §15. Per-invocation environment: never mutate `process.env`

Extra environment variables overlaid onto `process.env` for THIS cosign subprocess only — e.g. `DOCKER_CONFIG` pointing at a per-invocation scratch auth dir for a credentialed registry read. Per-invocation by design: callers must NEVER mutate `process.env` to feed cosign credentials — a process-global mutation leaks this caller's registry auth into every CONCURRENT cosign/skopeo subprocess in a multi-tenant server (another org's relay, a pre-deploy-gate verify), and two concurrent mutators race each other's save/restore.

### §16. Verify an image's registry signature, keyful and offline

`cosign verify` a container image / OCI artifact against the REGISTRY-ATTACHED signature, keyful and offline (`--insecure-ignore-tlog=true` — the origin never wrote a Rekor entry we could or would check; `--key` pins the exact public key, so no Fulcio identity is consulted). `imageRef` MUST be digest-pinned (`registry/repo@sha256:…`) so verification binds to exact bytes. cosign READS the registry to fetch the manifest + its `.sig`; it never pushes or pulls image bytes anywhere else.

Never throws — a failed verification (tampered/unsigned/absent image, wrong key) is a normal, expected, fail-closed outcome reported as `{ ok: false }`. A MISSING image (bytes not present in the reachable registry) makes cosign's own fetch fail, which surfaces here as `{ ok: false }` too — exactly the fail-closed "absent artifact FAILS" the per-artifact pre-deploy gate requires.

### §17. Verify a pinned image against an in-memory public key

Verify a digest-pinned OCI `imageRef`'s registry-attached signature against an IN-MEMORY cosign PUBLIC key PEM (the ergonomic seam the SERVER uses — the exporter's distributed cosign key lives in Postgres as a PEM string, not a file). Materializes the key to a private scratch dir, runs `verifyImage`, scrubs the dir, and returns a boolean. NEVER throws — a bad/absent signature is a normal, expected, fail-closed outcome reported as `false`.

## `packages/cosign/src/exec.ts`

### §18. One place that logs every argv and raises on a non-zero exit

Thin `node:child_process` wrapper used by the cosign wrapper in this package. Every external-binary invocation goes through here so there is exactly one place that logs the literal argv being run (useful for the "prove there's no hidden network call" audits this package's own README/tests do) and turns a non-zero exit into a thrown Error carrying stdout + stderr, instead of swallowing the failure the way a bare `execFileSync` in a try/catch does.

Deliberately uses `execFileSync` (argv array, no shell) rather than `exec`/a shell string — this is the same choice `scripts/doctor.mjs` and `tools/helm-verify/src/verify.ts` make elsewhere in this repo, and it matters here specifically: image references, registry hosts, and file paths can contain characters (`:`, `/`, `@`) that would be shell-metacharacter-adjacent if this ever went through a shell.

## `packages/cosign/src/index.ts`

### §19. The one keyful, offline cosign wrapper, shared by both paths

@scp/cosign — the single keyful/offline cosign wrapper for CommanderSCP.

Lifted verbatim from `deploy/airgap` (M17.3 E2) so one implementation of the air-gap-critical flag set and the E1 pinned-vs-probe binary resolver can be shared by BOTH the release/bundle path (`@scp/airgap`, which re-exports this) and — later, in E6 — the server. This increment is a pure lift: no signing behavior changed. See cosign.ts's module doc for the flag rationale and cosign-bin.ts's for the pinned-vs-operator resolution.

Air-gap invariants preserved here verbatim: `--tlog-upload=false` / `--new-bundle-format=false` (sign) and `--insecure-ignore-tlog=true` (verify) are the flags that keep signing off the public Rekor log; Fulcio/Rekor are NEVER contacted.

## `packages/cosign/src/keygen.ts`

### §20. Non-interactive cosign keypair GENERATION

Non-interactive cosign keypair GENERATION (M17.3 E4).

`deploy/airgap` only ever needed an EPHEMERAL keypair written under a scratch dir it manages (resolveSigningKey). E4 introduces a second consumer — the server's `instance_cosign_keys` table — that needs the key material as STRINGS to persist, not as files. This function is that seam: it runs the pinned/offline `cosign generate-key-pair` in a throwaway temp dir with an empty password (`COSIGN_PASSWORD=''`, the same non-interactive posture cosign.ts documents), reads the two file outputs back as strings, removes the temp dir, and returns the pair. No key file is ever left on disk.

Offline/air-gap: this uses the SAME pinned binary resolution + provenance assertion (`cosign()` fail-closes on a non-pinned build) as every other call in this package. `generate-key-pair` with an empty password makes ZERO network calls (it is pure local key generation — no Fulcio/Rekor), consistent with CLAUDE.md principle #5.

SECURITY POSTURE (documented honestly): the returned `privateKeyPem` is cosign's encrypted-PEM envelope with an EMPTY passphrase. The passphrase is not the protection; the caller (`instance_cosign_keys`) protects it with RLS + dedicated-table isolation, exactly the narrow plaintext-with-RLS exception `instance_keys` already documents.

## `packages/cosign/src/skopeo-bin.ts`

### §21. Which skopeo binary runs, and is it the one we pinned

THE single place that answers "which skopeo binary do we run, and is it the one we pinned?".

M15.5 c1 vendors a digest-pinned skopeo into the SCP runtime image (Dockerfile's `skopeo` stage; provenance in `tools/skopeo/README.md`; pin values in `tools/skopeo/pin.env`), the exact shape M17.3 E1 established for cosign — see `cosign-bin.ts`, whose module comment explains the pinned-vs-operator split this mirrors:

```text
PINNED   — the vendored wrapper at `VENDORED_SKOPEO_PATH` (or an explicit
           `SCP_SKOPEO_BIN` override). We built the image, we know the exact release, so we
           FAIL CLOSED if `skopeo --version` doesn't report the pinned version. A skopeo that
           isn't the skopeo we vetted is not a skopeo the relay moves bytes with.
UNPINNED — `skopeo` resolved from PATH, i.e. an operator-supplied build. The release/bundle
           path (deploy/airgap's build-bundle.ts and install.sh) legitimately uses the
           operator's own skopeo and stays exactly as it was: probing, never
           version-asserted. Nothing on that path calls this module.
```

This module lives in @scp/cosign beside resolveCosign() deliberately (shared exec helpers, one pin-vs-probe pattern in one package); the M15.5 c2 relay — the first real consumer — imports both from here. Like cosign-bin.ts, this module holds NO product behavior: nothing here copies images or decides policy. It is resolution + provenance assertion only.

### §22. The pinned skopeo release

The pinned skopeo release. MUST match `SKOPEO_PINNED_VERSION` in `tools/skopeo/pin.env` (and therefore the digest below) — `skopeo-bin.test.ts` fails if they drift. Note upstream reports the version WITHOUT a leading `v` (`skopeo version 1.22.2 commit: …`).

### §23. The exact upstream image the binary

The exact upstream image the binary (and its library closure — see the Dockerfile's skopeo COPY block) is taken from: the official skopeo image's **linux/amd64 platform manifest** digest. Recorded here so a running system can report its own provenance without shelling out to a registry.

### §24. The vendored entry point, deliberately not in /usr/local/bin

Where the Dockerfile puts the vendored entry point inside the SCP runtime image — a wrapper script that runs the real binary against its vendored loader + libraries (the upstream binary is dynamically linked, unlike cosign's). Deliberately NOT /usr/local/bin, so this check can never pick up an operator-installed skopeo and mislabel it as "pinned".

### §25. Resolve the skopeo to use, preferring the pinned binary. Order

Resolve the skopeo to use, preferring the pinned binary.

Order: `SCP_SKOPEO_BIN` → the vendored image path → PATH. Identical shape to `resolveCosign` in cosign-bin.ts, and for the same reason: `pinned` must be true ONLY for a binary this repo vetted, never for whatever a Homebrew/apt install put on PATH.

### §26. FAIL CLOSED: throw unless `bin` really is the pinned release

FAIL CLOSED: throw unless `bin` really is the pinned release.

Same supply-chain failure mode as `assertPinnedCosignVersion`: an image rebuilt against a moved tag, an `SCP_SKOPEO_BIN` pointed at some other build. The only safe response to "the binary isn't the one we vetted" is to refuse, never to shrug and use it anyway.

## `packages/cosign/vitest.config.ts`

### §27. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §28. The hook budget: a second deadline nobody chose by default

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
