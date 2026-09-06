# cosign

Reference for `packages/cosign/src/cosign.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. cosign signing/verification for the air-gap bundle

cosign signing/verification for the air-gap bundle.

## Why sign-blob, not `cosign sign`

`cosign sign` attaches a signature to an image IN A REGISTRY (it pushes a `.sig` artifact next to the manifest). At bundle-BUILD time our images only exist as local OCI-layout directories — there is no registry yet to attach anything to (the registry is the CUSTOMER's, chosen at install time, per-deployment). So this package signs a small **digest file** per image (`sha256:<manifest digest>`, produced by oci-layout.ts) with `cosign sign-blob`, plus the bundle's `CHECKSUMS.txt` for whole-bundle integrity. `cosign sign`/`cosign verify` against the registry image itself becomes available to the OPERATOR after install.sh's retarget-push, as a documented optional extra (see install.sh's own comments) — it's not this package's job to do that on the operator's behalf, since it doesn't control the customer registry's credentials.

## The air-gap-critical flag combination (portable across a range of cosign versions)

`cosign sign-blob` defaults to uploading every signature to the **public** Rekor transparency log (`https://rekor.sigstore.dev`) even for pure local-keypair signing — confirmed by pointing HTTP(S)_PROXY at a closed port and watching `sign-blob` fail with `Post "https://rekor.sigstore.dev/api/v1/log/entries": ... connection refused`. That is a hard violation of CLAUDE.md principle #5 ("no runtime network calls to the outside world") and of this milestone's own "NO runtime network calls" requirement — bundle building must never depend on reaching the public internet, let alone leak a customer's private image digests to a public transparency log.

The essential, long-stable fix is **`--tlog-upload=false`** — the flag that disables the Rekor upload. It is present (deprecated but honored) across cosign 2.x and 3.x and is the ONE flag that actually prevents the egress. Alongside it we pass `--new-bundle-format=false --output-signature <file> --yes` to get the legacy detached-signature file this package stores in the bundle (the format `verifyBlobDetached` and install.sh's `cosign verify-blob --signature` both consume).

`--use-signing-config=false` is handled DIFFERENTLY on the two cosign paths this package now has (resolution lives in cosign-bin.ts, M17.3 E1): - PINNED cosign (the digest-pinned binary vendored into the runtime image, or an explicit `SCP_COSIGN_BIN`): the release is known — v3.1.2, a build that HAS the flag — so the flag set is a static constant and `cosign()` fail-closed asserts the reported version matches the pin before any call. No `--help` subprocess runs on the signing path. - UNPINNED cosign (an operator's own build on PATH — air-gap operators legitimately bring their own, BUILD_AND_TEST.md §1): the original version-ADAPTIVE probing is kept verbatim, because the flag's handling differs sharply across versions: - NEWER cosign (advertises `--use-signing-config`, ~2.5+/3.x): `--use-signing-config` DEFAULTS to `true`, and cosign then REJECTS `--tlog-upload=false` with "`--tlog-upload=false is not supported with --signing-config or --use-signing-config`". So on these builds we MUST also pass `--use-signing-config=false`. - OLDER cosign (does NOT have the flag — e.g. cosign 2.x): passing `--use-signing-config=false` fails with "`unknown flag: --use-signing-config`" (exactly the CI red this replaced), and it isn't needed anyway — `--tlog-upload=false` alone prevents the upload. So we OMIT it there. We detect the flag from `cosign sign-blob --help` (it's listed on versions that have it) and add `--use-signing-config=false` only when present. Either way NOTHING is uploaded.

`verifyBlobDetached` mirrors the sign side with `--insecure-ignore-tlog=true` (a stable flag present across versions) — we deliberately never wrote a tlog entry, so asking cosign to check for one would always — correctly, but uselessly — fail.

Egress verified against a closed proxy on the PINNED v3.1.2 binary (and previously on v3.1.1): with the full flag set, `sign-blob` succeeds behind `HTTPS_PROXY=http://127.0.0.1:1` and the sig verifies — zero outbound connection attempts. If cosign's flags change again, re-run exactly that: set `HTTPS_PROXY=http://127.0.0.1:1` (a closed local port) and confirm sign/verify still succeed; if either ever tries the network it fails fast with `connection refused` instead of silently working. CI no longer installs cosign over the network at all — it extracts the SAME digest-pinned binary that ships in the image (scripts/install-pinned-cosign.sh, `.github/workflows/ci.yml`), so CI validates the binary production actually uses.

## §2. Resolve which signing key to use

Resolve which signing key to use.

- CI/production: set `COSIGN_KEY` (path to a cosign-format private key file) and `COSIGN_PASSWORD` (its password — cosign's own conventional env var name; empty string is a valid password for an unencrypted key). `COSIGN_PUBLIC_KEY` should also be set to the matching public key path; if omitted, it's derived on the fly via `cosign public-key`. - Local dev/testing (no `COSIGN_KEY` set): generates a brand-new ephemeral key pair under `scratchDir` with an empty password, loudly logged as a TEST KEY. This keypair is never written anywhere under the repo or the bundle output except the public half, which is by design bundled as `cosign.pub` (a public key is not a secret) — the private half lives only in `scratchDir`, which callers are responsible for treating as ephemeral (e.g. an os.tmpdir() subdirectory, as build-bundle.ts does).

## §3. Allow HTTP / self-signed-TLS registries

Allow HTTP / self-signed-TLS registries. The outpost-local Gitea/Harbor registry an air-gap operator side-loads bytes into is commonly plain HTTP or self-signed — and it is SAFE to allow here because the artifact's authenticity is proven by the cosign SIGNATURE (verified against the exporter's distributed public key), NOT by registry transport security: a registry MITM cannot forge a signature that verifies against that key. Off by default (a TLS commander registry).
