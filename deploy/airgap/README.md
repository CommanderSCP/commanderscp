# `@scp/airgap` — air-gap bundle builder/verifier

Builds `scp-bundle-<version>.tar.gz` (DESIGN.md §16 "Air-gapped bundle", BUILD_AND_TEST.md §8
M8): every image CommanderSCP needs (as OCI layout), the Helm chart, the compose files, checksums,
cosign signatures, offline docs, and an `install.sh` that retargets image references to the
customer's registry. **The same bundle is the upgrade package** — there is no separate upgrade
artifact.

## Bundle contents

```
scp-bundle-<version>/
  images/
    scpd/                       OCI layout (skopeo-copyable) of the scpd image
    scpd.digest                 its pinned manifest digest, sha256:<hex>
    scpd.digest.sig             cosign signature over scpd.digest
    scp-runner-iac/  + .digest / .digest.sig
    postgres-eval/   + .digest / .digest.sig     (unmodified postgres:16, eval/compose use only)
  helm/                         The full Helm chart (copy of deploy/helm)
  compose/
    docker-compose.yml            original dev/eval file (builds from source — reference only)
    docker-compose.airgap.yml     derived variant: image: placeholders instead of build:
  docs/
    OFFLINE_INSTALL.md            operator-facing install/upgrade doc (the one to actually read)
    BUILD_AND_TEST.md, DESIGN.md  copied in verbatim, background reference only
  manifest.json                 rich bundle manifest (version, per-image digests)
  manifest.sh                   same manifest, flat shell vars — sourced by install.sh (no jq)
  install.sh                    install/upgrade script — see "Installing" below
  cosign.pub                    public key to verify every signature in the bundle
  CHECKSUMS.txt / .sig          sha256 of every file in the bundle + cosign signature over it
```

Alongside the tarball (not inside it): `scp-bundle-<version>.tar.gz.sig` and a copy of
`cosign.pub`, for verifying the tarball itself before extracting anything.

## Building a bundle

```bash
pnpm --filter @scp/airgap bundle --version 1.0.0-rc \
  [--scpd-ref scp:dev] [--scpd-source docker-daemon] \
  [--runner-iac-ref scp-runner-iac:dev] [--runner-iac-source docker-daemon] \
  [--postgres-ref postgres:16] [--postgres-source docker-daemon] \
  [--out-dir dist-bundle]
```

(No extra `--` before the flags — this pnpm version forwards `pnpm --filter <pkg> <script> <args>`
straight through to the script's own argv. Adding an extra `--` gets forwarded LITERALLY as an
argv token, which commander then treats as its own "end of options" marker and silently stops
parsing flags — confirmed by testing both forms directly.)

Requires `skopeo` (1.16+), `cosign` (2.x), and `tar` on `PATH` (BUILD_AND_TEST.md §1) plus the
three source images already present in — or pullable by — the local Docker daemon. `--*-source
docker` pulls from a registry instead of reading the local daemon (an explicit, operator-chosen
network action, never automatic).

Output: `<out-dir>/scp-bundle-<version>.tar.gz` (+ `.sig` + `cosign.pub` alongside it).

### Signing key

- **CI/production**: set `COSIGN_KEY` (path to a cosign-format private key file) and
  `COSIGN_PASSWORD` (its password) before running `bundle`. Optionally `COSIGN_PUBLIC_KEY` (path
  to the matching public key — derived automatically via `cosign public-key` if omitted).
- **Local dev/testing** (no `COSIGN_KEY` set): an ephemeral keypair is generated on the fly,
  loudly logged as a **TEST KEY**, and used for that run only. Never commit a private key to this
  repo; the ephemeral key lives only in a temp directory for the duration of one `build-bundle`
  invocation.

## Verifying a bundle

```bash
pnpm --filter @scp/airgap verify --pubkey cosign.pub --tarball scp-bundle-1.0.0-rc.tar.gz
# or, against an already-extracted directory:
pnpm --filter @scp/airgap verify --pubkey cosign.pub --dir scp-bundle-1.0.0-rc
```

Cosign-verifies every image's digest file, `CHECKSUMS.txt`, and (given `--tarball`) the tarball
itself, plus independently re-hashes every OCI-layout blob against its own content-addressed
filename. Exits non-zero and lists every problem found on ANY mismatch — never silently passes a
tampered bundle. See "Trust model" below for what each layer actually proves.

## Installing / upgrading (operator-facing — see `docs/OFFLINE_INSTALL.md` inside the bundle)

```bash
tar xzf scp-bundle-1.0.0-rc.tar.gz
cd scp-bundle-1.0.0-rc
./install.sh --registry myregistry.example.com/scp --pubkey /path/to/independently-obtained/cosign.pub --mode helm
```

`--pubkey` (or `SCP_COSIGN_PUBKEY`) is REQUIRED and must point at a cosign public key you obtained
OUT-OF-BAND from this bundle — e.g. the copy `pnpm --filter @scp/airgap bundle` wrote ALONGSIDE
the tarball (not the `cosign.pub` shipped INSIDE it) if you built it yourself, or the project's
published key for an official release. `install.sh` refuses to run (fails closed with a clear
message) if no external key is supplied — see "Trust model" below for why the in-bundle
`cosign.pub` can never be used as this script's own verification key.

`install.sh` is a standalone bash script (no Node/pnpm dependency) that: (1) cosign-verifies
everything against that external key, fail-closed, before touching anything; (2) pushes each
image into your registry; (3) re-resolves each pushed image's digest from your registry and
confirms it matches what was just verified; (4) runs `helm upgrade --install` (or rewrites+runs
the compose file in `--mode compose`), pinned by digest, never by a mutable tag alone. Add
`--dry-run` to exercise (1)–(3) without the final deploy step; add `--insecure-registry` for a
registry with a self-signed cert/plain HTTP (internal air-gapped registries commonly aren't behind
a public CA — never use this for anything reachable over an untrusted network).

## Trust model

Three signature layers, each proving something different:

1. **Per-image** (`images/<name>.digest` + `.sig`): proves a specific image manifest digest was
   produced by whoever holds the signing key. Combined with re-hashing the OCI-layout blobs
   themselves (content-addressed filenames — `oci-layout.ts`'s `verifyOciLayoutIntegrity`), this
   catches an image body swapped underneath an untouched, validly-signed digest file.
2. **Whole extracted bundle** (`CHECKSUMS.txt` + `.sig`): proves every file in the bundle —
   Helm chart, compose files, docs, `install.sh` itself — matches what was signed, not just the
   images.
3. **Whole packaged tarball** (`scp-bundle-<version>.tar.gz.sig`, alongside the tarball): lets an
   operator verify before extracting anything at all.

**Obtain `cosign.pub` from a channel independent of the tarball's own download** before trusting
the tarball's signature — a copy of the public key bundled next to (or inside) a tampered tarball
proves nothing about that tarball, only about itself. This is not merely advice: `verify-bundle`'s
`--pubkey` is a required flag with no in-bundle fallback, and `install.sh` (adversarial review
CRITICAL #1 — a previous version of this script fell back to the IN-BUNDLE `cosign.pub` as its own
trust root, which an attacker who substitutes the whole bundle can defeat trivially by re-signing
everything with their own key and shipping their own matching `cosign.pub`) now REQUIRES
`--pubkey`/`SCP_COSIGN_PUBKEY` and refuses to run without it — the in-bundle copy is convenience
only (e.g. eyeballing it against a known-good value), never a substitute for out-of-band key
distribution, and neither tool ever reads it as a verification key.

## The empirically-discovered air-gap footgun (read this if you touch `cosign.ts`)

`cosign sign-blob` on the cosign build this was developed against (`cosign version` reports a
v2-line build, `GitVersion: v3.1.1`) defaults to uploading every signature to the **public**
`rekor.sigstore.dev` transparency log — even for pure local-keypair signing, even with
`--use-signing-config=false`. Confirmed by pointing `HTTPS_PROXY`/`HTTP_PROXY` at a closed local
port and watching `sign-blob` fail with `Post "https://rekor.sigstore.dev/...": connection
refused`. That's a hard violation of CLAUDE.md principle #5 (no runtime network calls) and this
milestone's own "NO runtime network calls" requirement.

The fix, applied throughout `cosign.ts`: `--tlog-upload=false --new-bundle-format=false
--use-signing-config=false` (the first is deprecated-but-still-honored; cosign prints a notice and
does the right thing anyway). Re-verified with the same closed-port-proxy test that this
combination makes zero outbound connection attempts. If cosign's flags change again, re-run that
exact test — a silent regression here would mean bundle builds start phoning home.

## Testing

`src/*.test.ts` (vitest) covers checksum generation/verification, OCI-layout self-consistency,
manifest render/parse, and the compose-file retarget transform — all pure logic, no
skopeo/cosign/Docker required (`pnpm --filter @scp/airgap test`).

`src/install-sh-tamper.test.ts` is the one exception: it spawns the REAL `install.sh` (the actual
bash script, copied into a fixture bundle dir — not a reimplementation of its logic) to prove the
CRITICAL #1 fix (adversarial review of PR #15) holds — a bundle whose `CHECKSUMS.txt` is re-signed
with a DIFFERENT (attacker) keypair is REJECTED when verified against the real, external
`--pubkey`, and `install.sh` refuses to run at all without one. Requires `cosign`/`skopeo`/`helm`
on PATH (`describe.skipIf`s cleanly, never a false failure, where they aren't — same posture as
`scripts/airgap-drill.sh`).

The skopeo/cosign/install.sh mechanics themselves were ALSO exercised manually end-to-end against real
images already built on this dev machine (the real `scpd`/`scp-runner-iac` images from prior M7/M8
work, tagged to match this package's default refs, plus the real `postgres:16`) — build a real
~370MB bundle, verify it clean, verify tamper-rejection (content tamper, signature tamper, OCI-blob
substitution under an untouched digest file, and a "recompute-matching-but-unsigned-CHECKSUMS.txt"
attack), push to a real local `registry:2` container, and run a full `docker compose` install from
the retargeted, digest-pinned images — including hitting the deployed app's `/healthz` over HTTP.
Not exercised: a live Kubernetes cluster (`helm upgrade --install` was proven correct up to the
point of actually needing a reachable cluster — see the top-level task report for exactly what
that means). This is manual verification, not yet wired into CI as a permanent gate — the M8
milestone's "Air-gap drill in CI" (BUILD_AND_TEST.md §8) is follow-up work, not part of this
package's own test suite.
