# Runbook — the retrans byte relay (M15.5(c), ADR-0019 §2)

The retrans relay is the automated byte leg of a cross-CDS promotion: a `role: retrans` SCP
instance at the boundary **validates then relays** the artifact bytes an imported promotion
authorizes. Metadata (the `.scpbundle`) and bytes (the relay tarball) remain **two separate
channel artifacts** — federation bundles never carry bytes ([ADR-0009](../adr/0009-optional-poke-mode-federation.md)),
and the tarball never carries authority (the receiving outpost's M17.4(a)+(b) gates re-verify
everything — the relay is granted **zero trust**).

## The flow, end to end

```
commander ──.scpbundle──▶ retrans ──scp-relay-<id>.tar.gz──▶ outpost
   │        (metadata)       │        (bytes, signed, walked      │
   └────.scpbundle (metadata, addressed to the outpost)───────────┘
```

1. **Commander:** `scp federation promote --peer <retrans> --change <id> --out a.scpbundle`
   (and the same promotion addressed to the destination outpost). The M17.3 E6 export gate signs
   the promotion manifest; artifact bytes stay in the source registry.
2. **Retrans:** `scp federation import a.scpbundle` — M17.4(a) verifies the manifest — then
   `scp federation relay --change <local-change-id>`. The relay:
   - resolves the M17.4(a)-verified authorized artifact set (the ONLY source of what may cross);
   - **pulls by digest** via the vendored, pinned skopeo (`/opt/scp/bin/skopeo`), refs
     digest-bound exactly like the pre-deploy verify (`bindOciRefToAuthorizedDigest`), with BOTH
     operator allowlists enforced on the pull path (`SCP_ARTIFACT_OCI_REGISTRY_HOSTS`,
     `SCP_ARTIFACT_BLOB_BASE_URLS` — unset = fail-closed);
   - **validates** with the M17.4 machinery (`verifyAuthorizedArtifactSet`): digest-bound,
     origin-signature-verified against the exporter's distributed cosign key, keyful/offline.
     **A failing/tampered/unauthorized/missing artifact refuses the whole relay** with a
     `retrans-relay-validate` block Decision + hash-chained audit event — it never crosses;
   - **packages** `SCP_RELAY_OUT_DIR/scp-relay-<sourceChangeId>.tar.gz`: per-artifact OCI layouts
     (+ the registry-attached cosign signature artifacts), blob bytes + origin signatures,
     `relay-manifest.json`, `CHECKSUMS.txt`, and `CHECKSUMS.txt.sig` signed with the retrans
     instance's cosign key (M17.3 E4).
3. **The CDS crossing is out-of-band** — drop directory, diode, sneakernet: the relay's contract
   ends at "signed tarball out / signed tarball in", the same boundary the `.scpbundle` walk draws.
   Distribute the retrans instance's cosign **public** key (`scp federation self`) out-of-band,
   like the air-gap bundle's `cosign.pub`.
4. **Outpost:** import the promotion `.scpbundle` first (M17.4(a) runs), then
   `scp federation relay-import --file scp-relay-<id>.tar.gz --change <local-change-id> --pubkey retrans-cosign.pub`.
   The import verifies the tarball signature + every checksum, refuses ANY artifact not in the
   local change's own (a)-verified authorized set, then pushes each image into the local Gitea and
   **re-inspects the landed digest** (the install.sh pattern), lands blob bytes in
   `SCP_RELAY_BLOB_OUT_DIR`, and records where the bytes landed on the change's
   `sourceRef.artifacts[].location`.
5. **Nothing downstream is weakened:** the outpost's M17.4(b) pre-deploy byte gate still verifies
   every artifact digest-bound against the **exporter's** key before any deploy fires. A pushed
   artifact outside a commander-signed manifest deploys nothing (ADR-0019 §3 blast radius).

## Configuration

| Variable | Side | Meaning |
|---|---|---|
| `SCP_RELAY_OUT_DIR` | retrans | Drop directory built tarballs are written into (required for `POST /federation/relay`). |
| `SCP_RELAY_IN_DIR` | outpost | Intake directory tarballs are read from (required for `POST /federation/relay/import`; the API accepts file names inside it only — no traversal). |
| `SCP_RELAY_SOURCE_REPO` | retrans | Fallback source repository (`host[:port]/path`) for OCI artifacts whose bundle carries no `location` (exports record digests only). Pull ref = `<repo>@<digest>`. The host must ALSO be allowlisted in `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`. |
| `SCP_RELAY_DEST_REPO` | outpost | The destination local Gitea repository (`host[:port]/owner/repo`) images are pushed into by digest. Needs no allowlist — it is the relay's own configuration, never bundle data (ADR-0019 §4). |
| `SCP_RELAY_BLOB_OUT_DIR` | outpost | Directory blob artifact bytes + origin signatures land in. |
| `SCP_RELAY_BLOB_BASE_URL` | outpost | The URL that directory is served under — recorded as the landed blob `location`/`signatureRef`; must fall under the outpost's `SCP_ARTIFACT_BLOB_BASE_URLS` so the M17.4(b) gate can fetch it. |
| `SCP_RELAY_INSECURE_HOSTS` | both | Comma-separated registry `host[:port]` entries the relay may talk to without TLS verification — applied **per host** to both the skopeo pull/push (`--src/dest-tls-verify=false`) and the validate pass's cosign reads (`--allow-insecure-registry`); hosts not listed always get full TLS verification on both. Safe for listed hosts because the cosign signature, not transport TLS, is the trust anchor. |
| `SCP_RELAY_CERT_DIR` | both | Operator-provided CA certificate directory for TLS registries (skopeo `--src-cert-dir`/`--dest-cert-dir`). See "TLS / CA" below. |

Also load-bearing (shipped earlier, shared with the pre-deploy verify — ADR-0019 §4):
`SCP_ARTIFACT_OCI_REGISTRY_HOSTS` and `SCP_ARTIFACT_BLOB_BASE_URLS`. **Unset = fail-closed** —
every OCI dial / blob fetch is refused until the operator opts the byte channel in explicitly.
And `SCP_ARTIFACT_INSECURE_HOSTS` (outpost side) — the pre-deploy gate's sibling of
`SCP_RELAY_INSECURE_HOSTS`: comma-separated registry `host[:port]` entries the M17.4(b)
per-artifact `cosign verify` may dial without TLS verification (`--allow-insecure-registry`),
per host. A plain-HTTP/self-signed outpost-local registry (the bundled Gitea, a `registry:2`)
must be listed here **in addition to** `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` — the egress allowlist
answers "may we dial it at all?", this one "may TLS verification be skipped?". Hosts not listed
always get full TLS verification. **Unset = TLS verification everywhere** (safe: the cosign
signature, not transport TLS, is the trust anchor — a MITM can only cause fail-closed denial).

## Credentials (ADR-0019 §3 — the artifact-store class)

Registry credentials only — **never** credentials to infrastructure execution systems manage
(charter principle 1). Stored in the existing encrypted secrets vault (`scp secret put`), scoped
**per registry host**, resolved at relay time, injected via a mode-0600 scratch auth file — skopeo
gets it as an explicit `--src/dest-authfile`, cosign as a per-invocation subprocess `DOCKER_CONFIG`
env (never a process-global mutation, never argv, never logs, never Decisions/audit):

```
scp secret put "relay/source-read/<source-host[:port]>"  --value "user:password"   # READ-only pull
scp secret put "relay/dest-push/<dest-host[:port]>"      --value "user:password"   # PUSH-only
```

Grant the source credential **read** on the artifact repositories only, and the destination
credential **push** on the relay repository only — no admin, no delete. Rotation = `scp secret put`
again; the next relay run resolves the new value. Anonymous registries need no secret.

## TLS / CA — the recorded decision

The SCP runtime image ships **no CA bundle** (recorded during the #111 skopeo vendoring). For a
TLS registry the relay therefore needs explicit operator trust configuration:

- **Operator-provided CA directory:** set `SCP_RELAY_CERT_DIR` to a directory containing the
  registry CA certificate(s); the relay passes it to skopeo as `--src-cert-dir`/`--dest-cert-dir`.
  (Mounting a CA bundle and setting `SSL_CERT_FILE` also works for tools that honor it, but the
  cert-dir flags are the supported, tested path.)
- **Plain HTTP / self-signed in-cluster registries** (the common outpost-local Gitea shape): list
  the exact `host[:port]` in `SCP_RELAY_INSECURE_HOSTS`. This is acceptable per the existing
  pattern (`VerifyImageOptions.allowInsecureRegistry`): artifact authenticity is proven by the
  cosign signature against the exporter's distributed key — registry transport is not the trust
  anchor. Hosts not listed use TLS with the operator CA (or the refusal is skopeo's TLS failure —
  fail-closed either way).

## Troubleshooting

- **409 `requires federation role 'retrans'`** — run `scp federation init --role retrans` on the
  boundary instance; commanders and outposts never relay.
- **Refused with a `retrans-relay-validate` block Decision** — `scp decision get <id>`: the
  Decision names each failing digest and check (wrong-key signature, missing bytes, digest
  mismatch, non-allowlisted host). This is the relay doing its job: the artifact never crosses.
  Fix at the source (re-sign/re-scan/re-promote) — never by weakening an allowlist to "make it pass".
- **`oci registry host not allowlisted`** — add the intended source registry `host[:port]` to
  `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` (operator decision; bundle data can never steer egress).
- **Destination import refuses `wrong tarball for this promotion`** — the tarball's source change
  does not match the local change; import the matching `.scpbundle` first and pass its local
  change id.
- **`pinned skopeo version mismatch`** — the runtime image's vendored skopeo does not match
  `tools/skopeo/pin.env`; refuse to work around it — see `tools/skopeo/README.md` "Updating the pin".

## What the relay is NOT

- Not a verification authority: the receiving outpost's M17.4(a)+(b) gates run unchanged.
- Not a bundle-format change: `.scpbundle` stays metadata-only; the tarball is a separate file.
- Not a promotion actor: the retrans never terminates a promotion and holds no authoritative
  objects (ADR-0004, unamended).
- Not required: operator-loaded media (M15.5(b)) remains the sneakernet fallback forever.
