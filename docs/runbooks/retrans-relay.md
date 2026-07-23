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
| `SCP_RELAY_OUT_DIR` | retrans | Drop directory built tarballs are written into (required for `POST /federation/relay`). The instance-level fallback when a peer configures no per-peer `deliveryTarget.outDir`; operator-owned, so it needs no `SCP_DELIVERY_ROOTS` entry. |
| `SCP_RELAY_IN_DIR` | outpost | Intake directory tarballs are read from (required for `POST /federation/relay/import`; the API accepts file names inside it only — no traversal). The instance-level fallback for per-peer `deliveryTarget.inDir`; operator-owned, exempt from `SCP_DELIVERY_ROOTS`. |
| `SCP_DELIVERY_ROOTS` | both | Comma/colon-separated **absolute** roots that bound every **per-peer** `deliveryTarget` directory (the M13.2a residual — same operator-allowlist shape as `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`). A per-peer `outDir`/`inDir` is honored **only** when it sits at or under one of these roots — the check is on resolved path *segments*, so a sibling like `/root-evil` never satisfies the root `/root`. Enforced in both places: refused at pair time (`POST /federation/peers`, never stored) and re-checked fail-closed at resolution (a stored out-of-root dir becomes a named per-gap problem, never a silent env fallback). **UNSET = fail-closed**: on a multi-tenant instance any per-peer delivery dir is refused until the operator declares the roots. The `SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` env fallback (no per-peer dir) is **exempt** — single-org deploys need no new config. |
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

## Unattended inbox ingest — the staging-node loop (M13.1a, proposal §13.1)

The six-step walk above stays fully supported — but steps "import what arrived" can now run
unattended. A pg-boss tick loop (`federation/inbox-loop.ts`, cloned from the observe-loop's
self-rescheduling singleton shape) lists each resolved delivery inbox and routes every **new**
file to the **existing** verify path for its kind. The loop automates only *who names the file*;
every verification, Decision, and audit event is byte-identical to the CLI-invoked path (proven
by `inbox-loop.integration.test.ts`).

| Variable | Meaning |
|---|---|
| `SCP_INBOX_LOOP` | **`1` = enable** (default off — an unconfigured instance never schedules a tick). The explicit operator opt-in; deliberately an env var, not replicated config, so unattended ingest can only be switched on by this instance's own operator. |
| `SCP_INBOX_TICK_INTERVAL_SECONDS` | Tick cadence (default `60`, floor `5`). The tick is the reliable floor; the ADR-0009 poke chain (M14) later *optimizes* latency but never replaces it. |

What one tick does, per org (a multi-tenant instance ticks every org):

1. Resolve inbox sources — every peer-configured `deliveryTarget.inDir` plus the instance
   `SCP_RELAY_IN_DIR` fallback (13.2a resolution). Nothing resolvable → the tick is a cheap no-op.
2. List file **names** (traversal-guarded, names only) and process `.scpbundle` files **before**
   `scp-relay-*.tar.gz` files, so a bundle+tarball dropped together completes in one tick.
3. Route role-aware: `.scpbundle` → the federation import (sync or promotion — the same repos the
   API route calls). Relay tarball at an **outpost** → `importRelayTarball` (verify + push +
   re-inspect, unchanged). Relay tarball at a **retrans** → the push-less **validate-and-forward**
   (`validateAndForwardRelayTarball`): the *same* extracted verification (tarball signature,
   per-file checksums, authorized-set cross-check, per-artifact layout/blob integrity — a
   refactor, not a new trust decision) with no registry half, then the byte-identical tarball is
   dropped to the onward DeliveryTarget (single peer-configured outbound dir, else
   `SCP_RELAY_OUT_DIR`).
4. **Validate-gated confirm (owner decision D4, never blind):** only a **passing** validation
   records/confirms the `bundle_transfers` row (the verify paths write it themselves, in the same
   tx as their allow Decision). Any failure → block Decision + hash-chained audit event, **no**
   confirmation — the transfer visibly stalls at the boundary.
5. Dedupe against the `federation_inbox_files` ledger (content identity: inbox dir + name +
   sha256). Re-processing an already-handled file is a no-op; a *replaced* file (same name, new
   bytes) is new work. Refused files are **quarantined in place** — the loop never deletes or
   moves inbox files; the ledger row (+ Decision) is what stops re-processing. Foreign/unknown
   files are skipped-with-log, never a crash; a bundle addressed to another org's domain and a
   tarball whose `.scpbundle` has not landed yet are left for a later tick.

**Tarball verification key, unattended:** the manual walk's out-of-band `--pubkey` becomes the
pairing registry — the loop verifies arriving tarballs against the cosign public key registered
for this org's (single) `role: retrans` peer (`scp federation pair --role retrans
--cosign-public-key …`), the same E5 exchange that distributes every other federation key. No key
material is ever read from the inbox. No (or ambiguous) retrans peer → tarballs stay unprocessed
with a logged config gap.

Out of scope in M13.1a (deliberately): the poke-chain trigger (M14) and the retrans auto-relay
build after a promotion import (13.1b) — a retrans still runs `scp federation relay` to *build*
tarballs; the loop automates the receiving/forwarding ends.

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

### Scoping (added 2026-07-23)

The vault keys above are scoped **per-registry-host only**, not literally per-peer. ADR-0019 §3
describes the credential class as "per-peer AND per-registry" — that per-peer property holds
**implicitly** today: a retrans instance serves exactly one CDS boundary/peer, so its per-host
keys are per-peer in practice by deployment shape, not by key encoding. A future multi-peer
retrans (one instance relaying for more than one boundary) would need the peer encoded in the key
shape itself (e.g. `relay/source-read/<peerId>/<host>`) — a vault key migration at that point, not
a gap today.

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
