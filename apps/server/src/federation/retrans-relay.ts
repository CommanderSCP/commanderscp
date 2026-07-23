/**
 * M15.5(c) — the RETRANS VALIDATE-THEN-RELAY (ADR-0019 §2), the ADR-0004 `retrans` role made real.
 *
 * ## What this is
 *
 * A retrans-role instance sits at a CDS boundary. It RECEIVES the metadata promotion bundle (the
 * ordinary `.scpbundle` walk — `promotion-repo.ts::importPromotionBundle`, which already runs the
 * M17.4(a) manifest verify) and must then relay the artifact BYTES onward. This module is that
 * byte leg, as a pipeline of proven pieces (ADR-0019 §2, steps 1–7):
 *
 *   1. RESOLVE the authorized artifact set — the imported change's M17.4(a)-verified
 *      `sourceRef.artifacts` (`crossBoundaryManifestOf`, the same scoping the pre-deploy gate
 *      uses). The signed promotion manifest is the ONLY source of what may cross.
 *   2. PULL each artifact's bytes from the SOURCE registry via the VENDORED skopeo
 *      (`resolveSkopeo` + fail-closed pin assertion, @scp/cosign) — BY DIGEST, refs constructed
 *      with `bindOciRefToAuthorizedDigest` (#108's binding, one shared implementation). Blob bytes
 *      ride the guarded blob fetch. BOTH operator allowlists are enforced on this pull path:
 *      `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` (every OCI ref, before any dial) and
 *      `SCP_ARTIFACT_BLOB_BASE_URLS` (every blob URL, before any request) — ADR-0019 §4.
 *   3. VALIDATE with the M17.4 machinery (`verifyAuthorizedArtifactSet`): per-artifact,
 *      digest-bound, origin-signature-verified against the EXPORTER's distributed cosign pubkey,
 *      keyful/offline. FAIL-CLOSED: a tampered/unauthorized/missing artifact refuses the WHOLE
 *      relay with a `retrans-relay-validate` block Decision + hash-chained audit event — it NEVER
 *      crosses the CDS. (Pulled OCI layouts are additionally digest-checked and
 *      layout-integrity-checked, so what is packaged is byte-for-byte what was verified —
 *      content addressing closes the pull/verify gap.)
 *   4. PACKAGE a SIGNED OCI-layout tarball — the `@scp/airgap` build-bundle machinery via its
 *      importable seam (`checksums`/`ociLayout`; not rewritten): per-artifact OCI layouts + blob
 *      files + `relay-manifest.json` + `CHECKSUMS.txt`, the checksums cosign-signed with THIS
 *      instance's cosign key (M17.3 E4, `ensureInstanceCosignKey`).
 *   5. RELAY the tarball across the CDS AS A FILE — out-of-band, exactly the `.scpbundle` walk's
 *      boundary: signed file out, signed file in. Federation bundles stay METADATA-ONLY
 *      (ADR-0009); this tarball is a separate channel artifact, never a bundle-format change.
 *   6. PUSH (destination side, `importRelayTarball`): verify the tarball signature + checksums +
 *      that every carried artifact is in the LOCAL change's own (a)-verified authorized set, then
 *      push each image into the destination local Gitea and RE-INSPECT the landed digest (the
 *      install.sh push + re-inspect pattern) — a registry push cannot silently alter what was
 *      verified. Blob bytes land in an operator-served directory. The change's
 *      `sourceRef.artifacts[].location` is then populated with where the bytes landed — the exact
 *      seam `artifact-verify.ts`'s `LocationRegistryReader` documents ("populated when the bytes
 *      land — M15.5").
 *   7. RECEIVER RE-VERIFIES — ZERO TRUST IN THE RELAY. The receiving outpost still runs M17.4(a)
 *      at import and M17.4(b) pre-deploy, unchanged and unweakened: the relay is an optimization
 *      of the sneakernet leg, not a verification authority.
 *
 * ## Credentials (ADR-0019 §3 — the artifact-store class)
 *
 * Source-registry READ + destination-Gitea PUSH credentials are ARTIFACT-STORE credentials —
 * registry creds, NOT credentials to infrastructure execution systems manage (charter principle
 * 1 holds). They live in the EXISTING AES-256-GCM `secrets` vault (`secrets/secrets-repo.ts` —
 * same vault, same envelope, same resolution seam as executor credentials), scoped PER-REGISTRY
 * under the keys {@link relaySourceReadSecretKey} / {@link relayDestPushSecretKey}. No
 * admin/delete grants are ever needed (read on source repos, push on destination repos). They are
 * handed to skopeo/cosign via a mode-0600 scratch docker auth file, NEVER via argv (argv is
 * logged) and never echoed into Decisions, audit events, or responses. The auth file reaches
 * skopeo via explicit `--src/dest-authfile` flags and cosign via a PER-INVOCATION subprocess
 * `DOCKER_CONFIG` env — never a `process.env` mutation, which on this multi-tenant server would
 * leak one org's registry auth into every concurrently spawned cosign/skopeo subprocess.
 *
 * ## Roles
 *
 * `buildRelayTarball` runs ONLY on a `role: 'retrans'` instance (`scp federation init --role
 * retrans`) — any other role refuses (409). This activates the ADR-0004 arm that was
 * declared-but-placeholder in `self-repo.ts`. The destination import runs on the receiving
 * outpost (any role) — it is the outpost's own registry-load operation.
 *
 * ## TLS / CA (the #111 recorded decision)
 *
 * The SCP runtime image carries NO CA bundle. For TLS registries the operator provides CAs via
 * `SCP_RELAY_CERT_DIR` (passed to skopeo as `--src-cert-dir`/`--dest-cert-dir`). Plain-HTTP /
 * self-signed in-cluster registries (the common outpost-local Gitea shape) are supported via the
 * explicit `SCP_RELAY_INSECURE_HOSTS` allowlist (`--src/dest-tls-verify=false` for exactly those
 * hosts) — safe here because the cosign SIGNATURE, not registry TLS, is the trust anchor (the
 * same argument as `VerifyImageOptions.allowInsecureRegistry`). See docs/runbooks/retrans-relay.md.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import type { ArtifactRef } from "@scp/schemas";
import {
  assertPinnedSkopeoVersion,
  makeScratchDir,
  resolveSkopeo,
  signBlobDetached,
  verifyBlobDetached
} from "@scp/cosign";
import { checksums as airgapChecksums, ociLayout as airgapOciLayout } from "@scp/airgap";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { badRequest, conflict } from "../errors.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { getChangeRow } from "../coordination/changes-repo.js";
import { crossBoundaryManifestOf } from "../coordination/pre-deploy-gate.js";
import { changes } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { getSecretValue } from "../secrets/secrets-repo.js";
import { ensureInstanceCosignKey } from "../governance/cosign-keys.js";
import { ensureFederationSelf } from "./self-repo.js";
import { currentPeerCosignPublicKey } from "./peers-repo.js";
import { recordBundleTransfer } from "./bundle-transfers-repo.js";
import { FEDERATION_IMPORT_ACTOR_ID } from "./import-repo.js";
import {
  LocationRegistryReader,
  bindOciRefToAuthorizedDigest,
  normalizeSha256Digest,
  ociRegistryHostOf,
  parseRegistryHostList,
  verifyAuthorizedArtifactSet,
  type ResolvedBlob
} from "./artifact-verify.js";

export const RETRANS_RELAY_VALIDATE_DECISION_KIND = "retrans-relay-validate";
export const RETRANS_RELAY_IMPORT_DECISION_KIND = "retrans-relay-import";
/** M13.1a — the retrans's push-less VALIDATE-AND-FORWARD verdicts (proposal §13.1). */
export const RETRANS_RELAY_FORWARD_DECISION_KIND = "retrans-relay-forward";

// -------------------------------------------------------------------------------------------------
// Config surface (documented in docs/runbooks/retrans-relay.md). All operator-configured env —
// bundle-supplied data NEVER steers relay egress (ADR-0019 §4): the pull side is guarded by the
// two artifact allowlists, and the push side needs no allowlist because the destination is the
// relay's OWN configured registry, never bundle data.
// -------------------------------------------------------------------------------------------------

export interface RelayConfig {
  /** Source-side drop directory built tarballs are written into (`SCP_RELAY_OUT_DIR`). */
  outDir?: string;
  /** Destination-side drop directory tarballs are read from (`SCP_RELAY_IN_DIR`). */
  inDir?: string;
  /** Fallback SOURCE repository (`host[:port]/path`) for OCI artifacts whose bundle carries no
   *  `location` (the export path records digests only) — pull ref = `<sourceRepo>@<digest>`
   *  (`SCP_RELAY_SOURCE_REPO`). Its host must ALSO be in `SCP_ARTIFACT_OCI_REGISTRY_HOSTS`. */
  sourceRepo?: string;
  /** The DESTINATION repository (`host[:port]/owner/repo`, the outpost-local Gitea) images are
   *  pushed into by digest (`SCP_RELAY_DEST_REPO`). One repo holds every relayed digest. */
  destRepo?: string;
  /** Destination-side directory blob artifact bytes + origin signatures land in
   *  (`SCP_RELAY_BLOB_OUT_DIR`) — the operator serves it at {@link blobBaseUrl}. */
  blobOutDir?: string;
  /** The base URL {@link blobOutDir} is served under (`SCP_RELAY_BLOB_BASE_URL`) — recorded as
   *  the landed blob `location`/`signatureRef`; must fall under the destination's
   *  `SCP_ARTIFACT_BLOB_BASE_URLS` for the M17.4(b) gate to fetch it. */
  blobBaseUrl?: string;
  /** Registry `host[:port]` entries skopeo may talk to WITHOUT TLS verification
   *  (`SCP_RELAY_INSECURE_HOSTS`, comma-separated) — plain-HTTP/self-signed in-cluster
   *  registries; the cosign signature, not transport TLS, is the trust anchor. */
  insecureHosts: string[];
  /** Operator-provided CA certificate directory for TLS registries (`SCP_RELAY_CERT_DIR`,
   *  skopeo `--src-cert-dir`/`--dest-cert-dir`) — the #111 CA decision: the runtime image ships
   *  no CA bundle, so TLS trust is explicit operator configuration. */
  certDir?: string;
}

export function relayConfigFromEnv(): RelayConfig {
  const env = process.env;
  return {
    outDir: env.SCP_RELAY_OUT_DIR || undefined,
    inDir: env.SCP_RELAY_IN_DIR || undefined,
    sourceRepo: env.SCP_RELAY_SOURCE_REPO || undefined,
    destRepo: env.SCP_RELAY_DEST_REPO || undefined,
    blobOutDir: env.SCP_RELAY_BLOB_OUT_DIR || undefined,
    blobBaseUrl: env.SCP_RELAY_BLOB_BASE_URL || undefined,
    // The ONE shared host-list parse (artifact-verify.ts) — same normalize as the gate's
    // SCP_ARTIFACT_INSECURE_HOSTS, so the two TLS allowlists can never diverge in parsing.
    insecureHosts: parseRegistryHostList(env.SCP_RELAY_INSECURE_HOSTS),
    certDir: env.SCP_RELAY_CERT_DIR || undefined
  };
}

/** Scoping (dated 2026-07-23, ADR-0019 §3 addendum): these keys are per-registry-host only, not
 *  literally per-peer. Per-peer scoping holds IMPLICITLY today because a retrans instance serves
 *  exactly one boundary/peer, so its per-host keys are per-peer in practice. A future multi-peer
 *  retrans would need the peer encoded in the key shape (e.g. `relay/source-read/<peerId>/<host>`)
 *  — a vault migration at that point, not a change needed now. */
/** Vault key (existing `secrets` table) holding the READ-only pull credential (`user:password`)
 *  for one SOURCE registry host — per-registry scoping, ADR-0019 §3. */
export function relaySourceReadSecretKey(host: string): string {
  return `relay/source-read/${host.toLowerCase()}`;
}
/** Vault key holding the PUSH-only credential (`user:password`) for one DESTINATION registry
 *  host — per-registry scoping, ADR-0019 §3. No admin/delete grant is ever required. */
export function relayDestPushSecretKey(host: string): string {
  return `relay/dest-push/${host.toLowerCase()}`;
}

// -------------------------------------------------------------------------------------------------
// The relay tarball format (`scp-relay-<sourceChangeObjectId>.tar.gz`) — the CDS channel artifact.
// -------------------------------------------------------------------------------------------------

export const RELAY_BUNDLE_VERSION = "scp-relay-bundle/v1";

const RelayBundleArtifactSchema = z.object({
  type: z.enum(["oci", "blob"]),
  digest: z.string(),
  signatureRef: z.string().optional(),
  /** OCI: layout dir (relative) of the image itself. */
  ociPath: z.string().optional(),
  ociTag: z.string().optional(),
  /** OCI: the registry-attached cosign signature artifact(s), each as an OCI layout + the tag it
   *  was stored under at the source. Cosign's storage scheme varies by version — the legacy
   *  `sha256-<hex>.sig` tag and/or the OCI-1.1 referrers-fallback `sha256-<hex>` tag — so the
   *  relay carries whichever exist(s) and re-creates the SAME tag(s) at the destination, keeping
   *  the receiving M17.4(b) `cosign verify` working regardless of the signing cosign's vintage. */
  ociSignatures: z.array(z.object({ tag: z.string(), path: z.string() })).optional(),
  /** blob: byte + origin detached-signature files (relative). */
  blobPath: z.string().optional(),
  blobSigPath: z.string().optional()
});
const RelayBundleManifestSchema = z.object({
  relayVersion: z.literal(RELAY_BUNDLE_VERSION),
  createdAt: z.string(),
  relayDomainId: z.string(),
  exporterDomainId: z.string().nullable(),
  sourceChangeObjectId: z.string(),
  artifacts: z.array(RelayBundleArtifactSchema)
});
type RelayBundleManifest = z.infer<typeof RelayBundleManifestSchema>;
type RelayBundleArtifact = z.infer<typeof RelayBundleArtifactSchema>;

// -------------------------------------------------------------------------------------------------
// Vendored-skopeo execution. Resolution + pin assertion live in @scp/cosign (M15.5 c1); this
// wrapper only adds fail-closed execution + argv-only logging (credentials ride an authfile,
// never argv — argv IS logged).
// -------------------------------------------------------------------------------------------------

function skopeoBin(): string {
  const resolved = resolveSkopeo();
  if (resolved.source === "missing") {
    throw new Error(
      "skopeo not available — the relay requires the vendored pinned skopeo " +
        "(/opt/scp/bin/skopeo in the SCP runtime image, or SCP_SKOPEO_BIN / PATH for dev)"
    );
  }
  // FAIL CLOSED on the pinned path: a binary that is not the vetted release moves no bytes.
  assertPinnedSkopeoVersion(resolved);
  return resolved.bin;
}

function runSkopeo(args: string[]): string {
  const bin = skopeoBin();
  // argv only — NEVER env, and credentials never appear in argv (authfile flags carry a path).
  process.stderr.write(`+ ${bin} ${args.join(" ")}\n`);
  try {
    return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    throw new Error(
      `skopeo ${args[0]} failed (exit ${e.status ?? "?"}): ${(e.stderr ?? "").trim() || (e.stdout ?? "").trim()}`
    );
  }
}

/** Per-direction TLS flags: explicit-insecure hosts get `--…-tls-verify=false`; an operator CA
 *  dir applies to everything else (the #111 CA decision — no image CA bundle, explicit trust). */
function skopeoTlsArgs(direction: "src" | "dest", host: string, config: RelayConfig): string[] {
  if (config.insecureHosts.includes(host.toLowerCase())) {
    return [`--${direction}-tls-verify=false`];
  }
  return config.certDir ? [`--${direction}-cert-dir`, config.certDir] : [];
}

/** Write a docker-config auth file (mode 0600, scratch-dir-scoped) for the given host creds.
 *  Returns `null` when there are no creds (anonymous registry). The ONLY way credentials reach
 *  skopeo/cosign — never argv, never logs. */
async function writeAuthFile(
  dir: string,
  host: string,
  userColonPass: string | undefined
): Promise<string | null> {
  if (!userColonPass) return null;
  const authFile = path.join(dir, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({ auths: { [host]: { auth: Buffer.from(userColonPass).toString("base64") } } }),
    { mode: 0o600 }
  );
  return authFile;
}

/** Strip a trailing `:tag` from an OCI repository reference (digest already removed) — the tag
 *  colon is the one after the last `/` (a colon before it is a registry port). */
function repoWithoutTag(repoRef: string): string {
  const lastSlash = repoRef.lastIndexOf("/");
  const colon = repoRef.indexOf(":", lastSlash + 1);
  return colon >= 0 ? repoRef.slice(0, colon) : repoRef;
}

const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Streaming sha256 (hex) of a file on disk — relay tarballs can be multi-GB, so never a whole-
 *  file Buffer. Used for the `bundle_transfers` checksum (M13.1a D4) and the inbox ledger. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

// -------------------------------------------------------------------------------------------------
// The relay's SOURCE reader — LocationRegistryReader (both allowlists) + the operator-configured
// source-repo fallback for OCI artifacts that carry no bundle `location`.
// -------------------------------------------------------------------------------------------------

class RelaySourceRegistryReader extends LocationRegistryReader {
  constructor(
    private readonly fallbackSourceRepo: string | undefined,
    /** When set, blob resolution serves these ALREADY-PULLED bytes (the validate pass runs over
     *  exactly what was pulled) instead of re-fetching. */
    private readonly pulledBlobs?: Map<string, ResolvedBlob>
  ) {
    super();
  }

  override async resolveOci(artifact: ArtifactRef): Promise<string | null> {
    const location = artifact.location?.trim();
    if (location && location.length > 0) return super.resolveOci(artifact);
    if (!this.fallbackSourceRepo) return null; // no location, no configured source → absent (fail-closed).
    const ref = `${this.fallbackSourceRepo}@${artifact.digest}`;
    // The SAME OCI-host egress guard as the verify path (ADR-0019 §4) — the fallback repo is
    // operator config, but the allowlist stays the single choke point for every dial.
    this.assertOciRegistryHostAllowed(ref);
    return ref;
  }

  override async resolveBlob(artifact: ArtifactRef): Promise<ResolvedBlob | null> {
    if (this.pulledBlobs) {
      const digest = normalizeSha256Digest(artifact.digest);
      return (digest && this.pulledBlobs.get(digest)) || null;
    }
    return super.resolveBlob(artifact);
  }
}

// -------------------------------------------------------------------------------------------------
// SOURCE SIDE — buildRelayTarball (pipeline steps 1–5).
// -------------------------------------------------------------------------------------------------

export interface BuildRelayTarballInput {
  orgId: string;
  changeIdOrUrn: string;
  /** The secrets-vault master key (ADR-0019 §3 credential resolution). */
  masterKey: Buffer;
  /** Where the signed tarball lands (the CDS drop directory) — `SCP_RELAY_OUT_DIR` at the route. */
  outDir: string;
  config?: RelayConfig;
}

export interface RelayArtifactSummary {
  type: ArtifactRef["type"];
  digest: string;
}

export type BuildRelayTarballResult =
  | { refused: false; tarballPath: string; artifacts: RelayArtifactSummary[]; decisionId: string }
  | { refused: true; decisionId: string; reason: string };

interface RelayFailure {
  type: string;
  digest: string;
  reason: string;
}

export async function buildRelayTarball(
  db: Db,
  input: BuildRelayTarballInput
): Promise<BuildRelayTarballResult> {
  const config = input.config ?? relayConfigFromEnv();

  // Phase 1 (tx): role guard + resolve the authorized set + trust anchor + per-registry read
  // credentials. Pure DB — no subprocess runs while a pooled connection is held (the codebase-wide
  // cosign/skopeo-subprocess invariant, see promotion-repo.ts).
  const ctx = await withTenantTx(db, input.orgId, async (tx) => {
    const self = await ensureFederationSelf(tx, input.orgId);
    // THE ROLE ARM (ADR-0004, activated here): only a retrans-role instance relays bytes.
    if (self.role !== "retrans") {
      throw conflict(
        `federation byte relay requires federation role 'retrans' (this domain's role is ` +
          `'${self.role}') — run \`scp federation init --role retrans\` on the CDS-boundary ` +
          `instance; commanders and outposts never relay (ADR-0019 §2)`
      );
    }
    const change = await getChangeRow(tx, input.orgId, input.changeIdOrUrn);
    // Step 1 — RESOLVE: only an imported change carrying the M17.4(a)-VERIFIED manifest set
    // qualifies; the manifest is the only source of what may cross (ADR-0019 §2 step 1).
    const manifestRef = crossBoundaryManifestOf(change);
    if (!manifestRef) {
      throw badRequest(
        "change carries no M17.4(a)-verified cross-boundary promotion manifest — only an " +
          "imported, manifest-verified promotion can be byte-relayed (import its .scpbundle first)"
      );
    }
    if (manifestRef.artifacts.length === 0) {
      throw badRequest(
        "metadata-only promotion: the authorized artifact set is empty — there are no bytes to relay"
      );
    }
    // The EXPORTER's distributed cosign public key — the SAME trust anchor M17.4(a)/(b) verify
    // against. `importedFromDomain` is the local peer row id for the promoting peer.
    const cosignPublicKeyPem = await currentPeerCosignPublicKey(
      tx,
      input.orgId,
      change.importedFromDomain as string
    );
    // Per-registry source READ creds from the vault (ADR-0019 §3) — resolved for every host this
    // relay could dial: each artifact's own location host plus the configured fallback repo host.
    const credsByHost: Record<string, string> = {};
    const candidateHosts = new Set<string>();
    for (const artifact of manifestRef.artifacts) {
      if (artifact.type !== "oci") continue;
      const ref =
        artifact.location?.trim() ||
        (config.sourceRepo ? `${config.sourceRepo}@${artifact.digest}` : "");
      const host = ref ? ociRegistryHostOf(ref) : null;
      if (host) candidateHosts.add(host);
    }
    for (const host of candidateHosts) {
      const value = await getSecretValue(
        tx,
        input.orgId,
        relaySourceReadSecretKey(host),
        input.masterKey
      );
      if (value !== undefined) credsByHost[host] = value;
    }
    const sourceRef = (change.sourceRef ?? {}) as Record<string, unknown>;
    return {
      relayDomainId: self.domainId,
      changeObjectId: change.objectId,
      artifacts: manifestRef.artifacts,
      exporterDomainId: manifestRef.exporterDomainId,
      sourceChangeObjectId:
        typeof sourceRef.sourceChangeObjectId === "string"
          ? sourceRef.sourceChangeObjectId
          : change.objectId,
      cosignPublicKeyPem,
      credsByHost
    };
  });

  // Phase 2 (no tx): PULL + VALIDATE + PACKAGE — subprocesses (skopeo/cosign) run here.
  const workDir = await makeScratchDir();
  const bundleDirName = `scp-relay-${ctx.sourceChangeObjectId}`;
  const bundleRoot = path.join(workDir, bundleDirName);
  const failures: RelayFailure[] = [];
  let tarballPath: string | null = null;
  try {
    await mkdir(path.join(bundleRoot, "images"), { recursive: true });
    await mkdir(path.join(bundleRoot, "blobs"), { recursive: true });

    // Credentialed source registries: cosign's registry reads honor DOCKER_CONFIG, skopeo takes an
    // explicit --src-authfile — BOTH point at the same 0600 scratch config so credentials never
    // touch argv or logs. DOCKER_CONFIG is handed to cosign as a PER-INVOCATION subprocess env
    // (`cosignEnv` below), NEVER by mutating process.env: this is a multi-tenant server, and a
    // process-global mutation would leak this org's registry auth into every cosign/skopeo
    // subprocess that happens to spawn during the window (another org's concurrent relay, an
    // M17.4(b) pre-deploy-gate verify) — and two concurrent relays would race each other's
    // save/restore.
    const dockerConfigDir = path.join(workDir, "docker-config");
    await mkdir(dockerConfigDir, { recursive: true, mode: 0o700 });
    const auths: Record<string, { auth: string }> = {};
    for (const [host, cred] of Object.entries(ctx.credsByHost)) {
      auths[host] = { auth: Buffer.from(cred).toString("base64") };
    }
    const srcAuthFile = path.join(dockerConfigDir, "config.json");
    await writeFile(srcAuthFile, JSON.stringify({ auths }), { mode: 0o600 });
    const hasCreds = Object.keys(ctx.credsByHost).length > 0;

    const pullReader = new RelaySourceRegistryReader(config.sourceRepo);
    const pulledBlobs = new Map<string, ResolvedBlob>();
    const bundleArtifacts: RelayBundleArtifact[] = [];

    // Step 2 — PULL, digest-bound, allowlist-guarded, via the vendored skopeo.
    for (const [index, artifact] of ctx.artifacts.entries()) {
      const digest = normalizeSha256Digest(artifact.digest);
      try {
        if (!digest) {
          throw new Error(
            `authorized digest '${artifact.digest}' is not a well-formed sha256 digest (fail-closed)`
          );
        }
        if (artifact.type === "oci") {
          const resolved = await pullReader.resolveOci(artifact); // OCI-host allowlist enforced here.
          if (!resolved) {
            throw new Error(
              "no source reference: artifact carries no `location` and no SCP_RELAY_SOURCE_REPO " +
                "fallback is configured (fail-closed)"
            );
          }
          // #108's digest binding, shared implementation: the pull ref IS the authorized digest.
          const bound = bindOciRefToAuthorizedDigest(resolved, artifact.digest);
          if (!bound.ok) throw new Error(bound.reason);
          const host = ociRegistryHostOf(bound.ref);
          if (!host)
            throw new Error(`source ref '${bound.ref}' names no registry host (fail-closed)`);
          const name = `artifact-${index}`;
          const ociDir = path.join(bundleRoot, "images", name);
          const authArgs = hasCreds ? ["--src-authfile", srcAuthFile] : [];
          // `--all` preserves the EXACT manifest (incl. multi-arch lists) so the landed layout's
          // digest can be asserted equal to the authorized digest below.
          runSkopeo([
            "copy",
            "--all",
            "--preserve-digests",
            ...skopeoTlsArgs("src", host, config),
            ...authArgs,
            `docker://${bound.ref}`,
            `oci:${ociDir}:relay`
          ]);
          // DIGEST BINDING of what actually landed + full layout self-integrity: what gets
          // packaged is byte-for-byte what the digest names (content-addressed, fail-closed).
          const landed = await airgapOciLayout.readOciManifestDigest(ociDir);
          if (landed !== digest) {
            throw new Error(
              `pulled OCI layout digest '${landed}' does not equal the authorized digest '${digest}' ` +
                `— refusing to package (fail-closed)`
            );
          }
          const integrity = await airgapOciLayout.verifyOciLayoutIntegrity(ociDir);
          if (integrity.length > 0) {
            throw new Error(
              `pulled OCI layout failed integrity self-check: ` +
                integrity.map((m) => `${m.relativePath}: ${m.reason}`).join("; ")
            );
          }
          // The registry-attached cosign signature artifact(s) travel too, so the receiving
          // M17.4(b) gate's `cosign verify` finds them where the bytes land. Cosign's storage
          // scheme varies by version — legacy `sha256-<hex>.sig` tag vs. the OCI-1.1
          // referrers-fallback `sha256-<hex>` tag — so the relay carries whichever exist.
          const hex = digest.slice("sha256:".length);
          const sigRepo = repoWithoutTag(bound.ref.slice(0, bound.ref.lastIndexOf("@")));
          const ociSignatures: { tag: string; path: string }[] = [];
          const sigProbeFailures: string[] = [];
          for (const sigTag of [`sha256-${hex}.sig`, `sha256-${hex}`]) {
            const sigRelPath = path.posix.join("images", `${name}-sig-${ociSignatures.length}`);
            try {
              runSkopeo([
                "copy",
                "--all",
                "--preserve-digests",
                ...skopeoTlsArgs("src", host, config),
                ...authArgs,
                `docker://${sigRepo}:${sigTag}`,
                `oci:${path.join(bundleRoot, sigRelPath)}:sig`
              ]);
              ociSignatures.push({ tag: sigTag, path: sigRelPath });
            } catch (err) {
              // This particular tag scheme isn't present (or its artifact couldn't be copied) —
              // fine as long as SOME signature artifact lands (asserted below); the VALIDATE step
              // still independently proves the signature verifies against the exporter's key.
              // Recorded so the fail-closed refusal names the REAL per-tag error: an absent tag
              // ("manifest unknown") reads very differently from a copy-tooling failure (e.g. a
              // pre-1.16 skopeo refusing the referrers-fallback OCI index under
              // --preserve-digests), and the refusal is all an operator gets.
              sigProbeFailures.push(
                `${sigTag}: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          if (ociSignatures.length === 0) {
            throw new Error(
              "no registry-attached cosign signature artifact found for the image (neither the " +
                "legacy `.sig` tag nor the referrers-fallback tag) — an unsigned artifact never " +
                `crosses (fail-closed). Signature tag probes: ${sigProbeFailures.join("; ")}`
            );
          }
          bundleArtifacts.push({
            type: "oci",
            digest,
            ...(artifact.signatureRef ? { signatureRef: artifact.signatureRef } : {}),
            ociPath: path.posix.join("images", name),
            ociSignatures,
            ociTag: "relay"
          });
        } else {
          // blob: the GUARDED fetch (SCP_ARTIFACT_BLOB_BASE_URLS SSRF allowlist enforced inside).
          const resolved = await pullReader.resolveBlob(artifact);
          if (!resolved) {
            throw new Error("blob bytes absent from the source byte channel (fail-closed)");
          }
          const fetched = `sha256:${sha256Hex(resolved.bytes)}`;
          if (fetched !== digest) {
            throw new Error(
              `fetched blob hashes to '${fetched}' but the authorized digest is '${digest}' — ` +
                `substitution via the unsigned location (fail-closed)`
            );
          }
          const hex = digest.slice("sha256:".length);
          const blobPath = path.posix.join("blobs", `${hex}.bin`);
          const blobSigPath = path.posix.join("blobs", `${hex}.sig`);
          await writeFile(path.join(bundleRoot, blobPath), resolved.bytes);
          await writeFile(path.join(bundleRoot, blobSigPath), resolved.signature, "utf8");
          pulledBlobs.set(digest, resolved);
          bundleArtifacts.push({
            type: "blob",
            digest,
            ...(artifact.signatureRef ? { signatureRef: artifact.signatureRef } : {}),
            blobPath,
            blobSigPath
          });
        }
      } catch (err) {
        failures.push({
          type: artifact.type,
          digest: artifact.digest,
          reason: err instanceof Error ? err.message : String(err)
        });
      }
    }

    // Step 3 — VALIDATE: the M17.4 machinery, digest-bound + origin-signature-verified against the
    // exporter's distributed pubkey. OCI verifies content-addressed AT the authorized digest (the
    // same bytes the pull landed); blobs verify over EXACTLY the pulled bytes.
    if (failures.length === 0) {
      if (!ctx.cosignPublicKeyPem) {
        failures.push({
          type: "*",
          digest: "*",
          reason:
            "no exporter cosign public key registered for the promoting peer — cannot verify " +
            "artifact signatures before relaying (fail-closed); re-pair the peer to exchange its E5 key"
        });
      } else {
        const validateReader = new RelaySourceRegistryReader(config.sourceRepo, pulledBlobs);
        const result = await verifyAuthorizedArtifactSet({
          artifacts: ctx.artifacts,
          cosignPublicKeyPem: ctx.cosignPublicKeyPem,
          reader: validateReader,
          // TLS-off is scoped to the SAME explicit operator allowlist the skopeo pull uses
          // (SCP_RELAY_INSECURE_HOSTS) — per host, never a blanket default: an allowlisted
          // source host that serves proper TLS keeps full verification on the validate pass.
          allowInsecureRegistry: (host) => config.insecureHosts.includes(host.toLowerCase()),
          // Per-invocation subprocess env for cosign's credentialed registry reads — never a
          // process.env mutation (see the dockerConfigDir comment above).
          cosignEnv: hasCreds ? { DOCKER_CONFIG: dockerConfigDir } : undefined
        });
        if (!result.ok) {
          for (const f of result.failing)
            failures.push({ type: f.type, digest: f.digest, reason: f.reason });
        }
      }
    }

    if (failures.length === 0) {
      // Step 4 — PACKAGE + SIGN (the @scp/airgap build-bundle machinery via its importable seam).
      const relayManifest: RelayBundleManifest = {
        relayVersion: RELAY_BUNDLE_VERSION,
        createdAt: new Date().toISOString(),
        relayDomainId: ctx.relayDomainId,
        exporterDomainId: ctx.exporterDomainId,
        sourceChangeObjectId: ctx.sourceChangeObjectId,
        artifacts: bundleArtifacts
      };
      await writeFile(
        path.join(bundleRoot, "relay-manifest.json"),
        JSON.stringify(relayManifest, null, 2),
        "utf8"
      );
      // Sign the checksum manifest with THIS instance's cosign key (M17.3 E4) — transport
      // integrity for the CDS crossing. The receiver verifies it against the retrans's
      // out-of-band-distributed public key, then STILL runs its own M17.4 gates (zero trust).
      const instanceKey = await ensureInstanceCosignKey(db, input.orgId);
      await writeFile(path.join(bundleRoot, "cosign.pub"), instanceKey.publicKey, "utf8");
      const checksumEntries = await airgapChecksums.computeChecksums(bundleRoot);
      const checksumsPath = path.join(bundleRoot, "CHECKSUMS.txt");
      await writeFile(checksumsPath, airgapChecksums.formatChecksums(checksumEntries), "utf8");
      const keyDir = path.join(workDir, "signing-key");
      await mkdir(keyDir, { recursive: true, mode: 0o700 });
      const keyPath = path.join(keyDir, "cosign.key");
      try {
        await writeFile(keyPath, instanceKey.privateKey, { mode: 0o600 });
        signBlobDetached(checksumsPath, `${checksumsPath}.sig`, {
          keyPath,
          pubKeyPath: "",
          password: "",
          isEphemeral: false
        });
      } finally {
        await rm(keyDir, { recursive: true, force: true }); // never leave key material on disk.
      }
      await mkdir(input.outDir, { recursive: true });
      tarballPath = path.join(input.outDir, `${bundleDirName}.tar.gz`);
      execFileSync("tar", ["czf", tarballPath, "-C", workDir, bundleDirName], { encoding: "utf8" });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (failures.length > 0 || tarballPath === null) {
    // FAIL-CLOSED REFUSAL: a failing/tampered/unauthorized/missing artifact NEVER crosses — block
    // Decision + hash-chained audit event, like every gate (charter principle 6).
    const reason =
      `retrans relay refused: ${failures.length} artifact(s) failed validate-then-relay — ` +
      failures.map((f) => `${f.type} ${f.digest}: ${f.reason}`).join("; ");
    const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
      const decision = await insertDecision(tx, {
        orgId: input.orgId,
        kind: RETRANS_RELAY_VALIDATE_DECISION_KIND,
        subjectId: ctx.changeObjectId,
        verdict: "block",
        inputContext: {
          exporterDomainId: ctx.exporterDomainId,
          sourceChangeObjectId: ctx.sourceChangeObjectId,
          authorizedArtifacts: ctx.artifacts.map((a) => ({ type: a.type, digest: a.digest })),
          failing: failures
        },
        reasonTree: { summary: reason }
      });
      await appendAuditEvent(tx, {
        orgId: input.orgId,
        actorId: FEDERATION_IMPORT_ACTOR_ID,
        action: "federation.relay.validate.blocked",
        subjectId: ctx.changeObjectId,
        reason,
        decisionId: decision.id,
        requestId: `federation-relay:${ctx.sourceChangeObjectId}`
      });
      return decision.id;
    });
    return { refused: true, decisionId, reason };
  }

  // Success: persist the allow verdict + audit (principle 6 — every engine verdict is a Decision).
  const artifacts = ctx.artifacts.map((a) => ({ type: a.type, digest: a.digest }));
  const finalTarballPath = tarballPath;
  const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: RETRANS_RELAY_VALIDATE_DECISION_KIND,
      subjectId: ctx.changeObjectId,
      verdict: "allow",
      inputContext: {
        exporterDomainId: ctx.exporterDomainId,
        sourceChangeObjectId: ctx.sourceChangeObjectId,
        authorizedArtifacts: artifacts,
        tarballPath: finalTarballPath
      },
      reasonTree: {
        summary: `every authorized artifact pulled digest-bound and origin-signature-verified; signed relay tarball built`
      }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.relay.built",
      subjectId: ctx.changeObjectId,
      reason: `relay tarball built: ${finalTarballPath}`,
      decisionId: decision.id,
      requestId: `federation-relay:${ctx.sourceChangeObjectId}`
    });
    return decision.id;
  });

  return { refused: false, tarballPath: finalTarballPath, artifacts, decisionId };
}

// -------------------------------------------------------------------------------------------------
// DESTINATION SIDE — importRelayTarball (pipeline step 6). Runs at the receiving outpost.
// -------------------------------------------------------------------------------------------------

export interface ImportRelayTarballInput {
  orgId: string;
  /** The LOCAL imported change (from the `.scpbundle` import — M17.4(a) already ran on it). */
  changeIdOrUrn: string;
  /** Absolute path of the relay tarball (route resolves it under `SCP_RELAY_IN_DIR`). */
  tarballPath: string;
  /** The RETRANS instance's cosign PUBLIC key PEM, distributed out-of-band (like the air-gap
   *  bundle's cosign.pub) — verifies the tarball's CHECKSUMS.txt signature. */
  relayCosignPublicKeyPem: string;
  masterKey: Buffer;
  config?: RelayConfig;
}

export interface RelayPushedArtifact extends RelayArtifactSummary {
  location?: string;
}

export type ImportRelayTarballResult =
  | {
      refused: false;
      localChangeObjectId: string;
      pushed: RelayPushedArtifact[];
      decisionId: string;
    }
  | { refused: true; decisionId: string; reason: string };

/** Internal refusal signal for phase 2 — every refusal path converges on one block Decision. */
class RelayImportRefusal extends Error {}

interface VerifiedRelayOci {
  artifact: RelayBundleArtifact;
  digest: string;
  ociDir: string;
  signatures: { tag: string; dir: string }[];
}
interface VerifiedRelayBlob {
  artifact: RelayBundleArtifact;
  digest: string;
  bytes: Buffer;
  sig: string;
}
interface VerifiedRelayTarball {
  bundleRoot: string;
  relayManifest: RelayBundleManifest;
  verifiedOci: VerifiedRelayOci[];
  verifiedBlobs: VerifiedRelayBlob[];
}

/**
 * M13.1a EXTRACTION (proposal §13.1 — "a refactor, not a new trust decision"): the verification
 * half of the destination import, byte-equivalent to what `importRelayTarball` always ran inline
 * with its registry-push flow, now callable WITHOUT the push half so a `role: retrans` staging
 * node can validate-and-forward a tarball it has no registry to push into. The checks, in order,
 * exactly as before:
 *
 *   1. tarball transport integrity — CHECKSUMS.txt.sig against the OPERATOR/PAIRING-provided
 *      relay cosign public key (never a key found inside the tarball), then every file against
 *      CHECKSUMS.txt;
 *   2. relay-manifest parse + binding to THIS change's imported source change;
 *   3. AUTHORIZATION CROSS-CHECK — every carried artifact must be in the LOCAL change's own
 *      M17.4(a)-verified authorized set (zero trust in the relay's own manifest);
 *   4. per-artifact pre-push verification — OCI layout digest + integrity self-check, blob
 *      byte-hash equality.
 *
 * `requireBlobLandingDir` is the ONE caller-mode difference: the destination import lands blob
 * bytes in `config.blobOutDir` and must therefore refuse when it is unconfigured (unchanged
 * behavior); the retrans forward never lands blobs — the tarball is forwarded whole — so the
 * landing-dir config check does not apply there. Throws {@link RelayImportRefusal} on any
 * failing check; the caller converges every refusal on one block Decision.
 */
async function extractAndVerifyRelayTarball(args: {
  workDir: string;
  tarballPath: string;
  relayCosignPublicKeyPem: string;
  /** The local change's `sourceRef.sourceChangeObjectId` (the binding target), or null when the
   *  change carries none — which refuses, exactly as before. */
  localSourceChangeObjectId: string | null;
  /** The LOCAL change's own M17.4(a)-verified authorized set — the AUTHORITY on what may cross. */
  authorized: ArtifactRef[];
  requireBlobLandingDir: boolean;
  config: RelayConfig;
}): Promise<VerifiedRelayTarball> {
  const { workDir, config } = args;
  execFileSync("tar", ["xzf", args.tarballPath, "-C", workDir], { encoding: "utf8" });
  const entries = (await readdir(workDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  const rootEntry = entries.length === 1 ? entries[0] : undefined;
  if (!rootEntry)
    throw new RelayImportRefusal("relay tarball does not contain exactly one bundle directory");
  const bundleRoot = path.join(workDir, rootEntry.name);

  // 1. Tarball transport integrity: CHECKSUMS.txt.sig against the OPERATOR-PROVIDED retrans
  //    public key (never a key found inside the tarball), then every file against CHECKSUMS.txt.
  const pubKeyPath = path.join(workDir, "relay-cosign.pub");
  await writeFile(pubKeyPath, args.relayCosignPublicKeyPem, "utf8");
  const checksumsPath = path.join(bundleRoot, "CHECKSUMS.txt");
  const sigResult = verifyBlobDetached(checksumsPath, `${checksumsPath}.sig`, pubKeyPath);
  if (!sigResult.ok) {
    throw new RelayImportRefusal(
      "relay tarball CHECKSUMS.txt signature does not verify against the provided retrans " +
        "cosign public key (rejected, fail-closed)"
    );
  }
  const checksumEntries = airgapChecksums.parseChecksums(await readFile(checksumsPath, "utf8"));
  const mismatches = await airgapChecksums.verifyChecksums(bundleRoot, checksumEntries);
  if (mismatches.length > 0) {
    throw new RelayImportRefusal(
      `relay tarball failed checksum verification: ` +
        mismatches.map((m) => `${m.relativePath}: ${m.reason}`).join("; ")
    );
  }

  // 2. Parse the relay manifest + bind it to THIS change.
  let relayManifest: RelayBundleManifest;
  try {
    relayManifest = RelayBundleManifestSchema.parse(
      JSON.parse(await readFile(path.join(bundleRoot, "relay-manifest.json"), "utf8"))
    );
  } catch (err) {
    throw new RelayImportRefusal(
      `relay tarball manifest is malformed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (
    !args.localSourceChangeObjectId ||
    relayManifest.sourceChangeObjectId !== args.localSourceChangeObjectId
  ) {
    throw new RelayImportRefusal(
      `relay tarball is for source change '${relayManifest.sourceChangeObjectId}' but the local ` +
        `change was imported from source change '${args.localSourceChangeObjectId ?? "<none>"}' — ` +
        `wrong tarball for this promotion (rejected, fail-closed)`
    );
  }

  // 3. AUTHORIZATION CROSS-CHECK (zero trust in the relay): every artifact the tarball carries
  //    must be in the LOCAL change's own M17.4(a)-verified authorized set. ONE unauthorized
  //    entry refuses the WHOLE import — nothing is pushed.
  const authorizedKeys = new Set(
    args.authorized.map((a) => `${a.type}:${normalizeSha256Digest(a.digest) ?? a.digest}`)
  );
  for (const artifact of relayManifest.artifacts) {
    const key = `${artifact.type}:${normalizeSha256Digest(artifact.digest) ?? artifact.digest}`;
    if (!authorizedKeys.has(key)) {
      throw new RelayImportRefusal(
        `relay tarball carries artifact ${key} which is NOT in this change's authorized ` +
          `(manifest-signed) set — unauthorized artifacts never cross (rejected, fail-closed; ` +
          `nothing was pushed)`
      );
    }
  }

  // 4. Pre-push verification of every carried artifact (still before ANY push).
  const verifiedOci: VerifiedRelayOci[] = [];
  const verifiedBlobs: VerifiedRelayBlob[] = [];
  for (const artifact of relayManifest.artifacts) {
    const digest = normalizeSha256Digest(artifact.digest);
    if (!digest) {
      throw new RelayImportRefusal(
        `relay tarball artifact digest '${artifact.digest}' is not a well-formed sha256 digest`
      );
    }
    if (artifact.type === "oci") {
      if (!artifact.ociPath || !artifact.ociTag || !artifact.ociSignatures?.length) {
        throw new RelayImportRefusal(
          `relay tarball oci artifact ${digest} is missing its layout paths`
        );
      }
      const ociDir = path.join(bundleRoot, artifact.ociPath);
      const landed = await airgapOciLayout.readOciManifestDigest(ociDir);
      if (landed !== digest) {
        throw new RelayImportRefusal(
          `relay tarball layout for ${digest} actually contains manifest ${landed} — ` +
            `substitution inside the tarball (rejected, fail-closed)`
        );
      }
      const integrity = await airgapOciLayout.verifyOciLayoutIntegrity(ociDir);
      if (integrity.length > 0) {
        throw new RelayImportRefusal(
          `relay tarball layout for ${digest} failed integrity check: ` +
            integrity.map((m) => `${m.relativePath}: ${m.reason}`).join("; ")
        );
      }
      verifiedOci.push({
        artifact,
        digest,
        ociDir,
        signatures: artifact.ociSignatures.map((s) => ({
          tag: s.tag,
          dir: path.join(bundleRoot, s.path)
        }))
      });
    } else {
      if (!artifact.blobPath || !artifact.blobSigPath) {
        throw new RelayImportRefusal(
          `relay tarball blob artifact ${digest} is missing its byte paths`
        );
      }
      if (args.requireBlobLandingDir && !config.blobOutDir) {
        throw new RelayImportRefusal(
          "relay tarball carries blob artifacts but SCP_RELAY_BLOB_OUT_DIR is not configured — " +
            "the destination blob byte channel directory must be operator-configured"
        );
      }
      const bytes = await readFile(path.join(bundleRoot, artifact.blobPath));
      const fetched = `sha256:${sha256Hex(bytes)}`;
      if (fetched !== digest) {
        throw new RelayImportRefusal(
          `relay tarball blob for ${digest} actually hashes to ${fetched} (rejected, fail-closed)`
        );
      }
      const sig = await readFile(path.join(bundleRoot, artifact.blobSigPath), "utf8");
      verifiedBlobs.push({ artifact, digest, bytes, sig });
    }
  }

  return { bundleRoot, relayManifest, verifiedOci, verifiedBlobs };
}

export async function importRelayTarball(
  db: Db,
  input: ImportRelayTarballInput
): Promise<ImportRelayTarballResult> {
  const config = input.config ?? relayConfigFromEnv();
  if (!config.destRepo) {
    throw badRequest(
      "SCP_RELAY_DEST_REPO is not configured — the destination local registry repository " +
        "(host[:port]/owner/repo) the relayed bytes are pushed into must be operator-configured"
    );
  }
  const destRepo = config.destRepo;
  const destHost = destRepo.split("/")[0] ?? destRepo;

  // Phase 1 (tx): resolve the LOCAL change + its own (a)-verified authorized set (the AUTHORITY on
  // what may be pushed — zero trust in the tarball's own manifest) + the dest push credential.
  const ctx = await withTenantTx(db, input.orgId, async (tx) => {
    const change = await getChangeRow(tx, input.orgId, input.changeIdOrUrn);
    const manifestRef = crossBoundaryManifestOf(change);
    if (!manifestRef) {
      throw badRequest(
        "local change carries no M17.4(a)-verified cross-boundary promotion manifest — import " +
          "the promotion .scpbundle (scp federation import) BEFORE importing its byte tarball"
      );
    }
    const destCred = await getSecretValue(
      tx,
      input.orgId,
      relayDestPushSecretKey(destHost),
      input.masterKey
    );
    const sourceRef = (change.sourceRef ?? {}) as Record<string, unknown>;
    return {
      change,
      authorized: manifestRef.artifacts,
      sourceChangeObjectId:
        typeof sourceRef.sourceChangeObjectId === "string" ? sourceRef.sourceChangeObjectId : null,
      destCred
    };
  });

  // Phase 2 (no tx): verify EVERYTHING about the tarball, then push. All verification (signature,
  // checksums, authorization cross-check, per-layout digest + integrity, blob digests) completes
  // BEFORE the first push — a tampered or unauthorized tarball pushes NOTHING. The verification
  // itself is `extractAndVerifyRelayTarball` — extracted (M13.1a, byte-equivalent) so the retrans
  // forward path runs the SAME checks without the push half below.
  const workDir = await makeScratchDir();
  const pushed: RelayPushedArtifact[] = [];
  let refusalReason: string | null = null;
  // TOCTOU close (copy-once-then-operate-on-the-private-copy): input.tarballPath sits in the
  // attacker-writable low-side inbox. Ingest its bytes into the server-controlled scratch dir
  // EXACTLY once, then hash + verify ALL from that private copy — so the D4 confirmed-transfer
  // checksum below describes the SAME bytes that were verified and imported, never a post-verify
  // swap of the inbox file. After this copy `input.tarballPath` is never read again. The copy+hash
  // live INSIDE the try so a missing/unreadable inbox path converges to the fail-closed block
  // Decision (route → 409), not a raw throw that leaks the scratch dir.
  let tarballSha256: string | null = null;
  try {
    const privateTarball = path.join(workDir, "ingress-relay.tar.gz");
    await copyFile(input.tarballPath, privateTarball);
    tarballSha256 = await sha256File(privateTarball);
    const { verifiedOci, verifiedBlobs } = await extractAndVerifyRelayTarball({
      workDir,
      tarballPath: privateTarball,
      relayCosignPublicKeyPem: input.relayCosignPublicKeyPem,
      localSourceChangeObjectId: ctx.sourceChangeObjectId,
      authorized: ctx.authorized,
      requireBlobLandingDir: true,
      config
    });

    // 5. PUSH — the install.sh pattern: push, then RE-INSPECT the landed digest from the registry
    //    (a push cannot silently substitute what was verified). Destination is the relay's OWN
    //    configured registry — never tarball-supplied (ADR-0019 §4: the push side needs no
    //    allowlist for exactly that reason). Push credential from the vault, via authfile only.
    const authFile = await writeAuthFile(workDir, destHost, ctx.destCred);
    const destAuthArgs = authFile ? ["--dest-authfile", authFile] : [];
    const inspectAuthArgs = authFile ? ["--authfile", authFile] : [];
    const destTls = skopeoTlsArgs("dest", destHost, config);
    const inspectTls = config.insecureHosts.includes(destHost.toLowerCase())
      ? ["--tls-verify=false"]
      : config.certDir
        ? ["--cert-dir", config.certDir]
        : [];
    for (const { digest, ociDir, signatures, artifact } of verifiedOci) {
      const hex = digest.slice("sha256:".length);
      const destTagRef = `${destRepo}:relay-${hex.slice(0, 12)}`;
      runSkopeo([
        "copy",
        "--all",
        "--preserve-digests",
        ...destTls,
        ...destAuthArgs,
        `oci:${ociDir}:${artifact.ociTag}`,
        `docker://${destTagRef}`
      ]);
      const inspected = runSkopeo([
        "inspect",
        ...inspectTls,
        ...inspectAuthArgs,
        "--format",
        "{{.Digest}}",
        `docker://${destTagRef}`
      ]).trim();
      if (inspected !== digest) {
        throw new RelayImportRefusal(
          `pushed ${destTagRef} re-inspected as ${inspected}, expected ${digest} — possible ` +
            `image substitution during push (rejected, fail-closed)`
        );
      }
      // The registry-attached cosign signature artifact(s) land beside it under the SAME tag(s)
      // they had at the source, so the receiving M17.4(b) gate's `cosign verify` finds them where
      // the bytes landed, whatever the signing cosign's storage scheme was.
      for (const signature of signatures) {
        runSkopeo([
          "copy",
          "--all",
          "--preserve-digests",
          ...destTls,
          ...destAuthArgs,
          `oci:${signature.dir}:sig`,
          `docker://${destRepo}:${signature.tag}`
        ]);
      }
      pushed.push({ type: "oci", digest, location: `${destRepo}@${digest}` });
    }
    for (const { digest, bytes, sig } of verifiedBlobs) {
      const hex = digest.slice("sha256:".length);
      const blobOutDir = config.blobOutDir as string;
      await mkdir(blobOutDir, { recursive: true });
      await writeFile(path.join(blobOutDir, hex), bytes);
      await writeFile(path.join(blobOutDir, `${hex}.sig`), sig, "utf8");
      pushed.push({
        type: "blob",
        digest,
        ...(config.blobBaseUrl ? { location: `${config.blobBaseUrl}/${hex}` } : {})
      });
    }
  } catch (err) {
    if (err instanceof RelayImportRefusal) refusalReason = err.message;
    else
      refusalReason = `relay import error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (refusalReason !== null) {
    const reason = refusalReason;
    const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
      const decision = await insertDecision(tx, {
        orgId: input.orgId,
        kind: RETRANS_RELAY_IMPORT_DECISION_KIND,
        subjectId: ctx.change.objectId,
        verdict: "block",
        inputContext: {
          tarballPath: input.tarballPath,
          sourceChangeObjectId: ctx.sourceChangeObjectId,
          authorizedArtifacts: ctx.authorized.map((a) => ({ type: a.type, digest: a.digest })),
          pushedBeforeRefusal: pushed
        },
        reasonTree: { summary: reason }
      });
      await appendAuditEvent(tx, {
        orgId: input.orgId,
        actorId: FEDERATION_IMPORT_ACTOR_ID,
        action: "federation.relay.import.blocked",
        subjectId: ctx.change.objectId,
        reason,
        decisionId: decision.id,
        requestId: `federation-relay-import:${ctx.change.objectId}`
      });
      return decision.id;
    });
    return { refused: true, decisionId, reason };
  }

  // Phase 3 (tx): record WHERE the bytes landed on the change's `sourceRef.artifacts[].location`
  // (+ blob signatureRef URLs) — the byte-landing seam artifact-verify.ts's LocationRegistryReader
  // documents. `location` is deliberately UNSIGNED bundle-side metadata: the M17.4(b) gate binds
  // every verification to the manifest-signed DIGEST regardless of what location says, so this
  // update cannot weaken the gate — it only tells it where to look.
  const pushedByKey = new Map(pushed.map((p) => [`${p.type}:${p.digest}`, p]));
  const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
    const sourceRef = (ctx.change.sourceRef ?? {}) as Record<string, unknown>;
    const artifacts = Array.isArray(sourceRef.artifacts)
      ? (sourceRef.artifacts as ArtifactRef[])
      : [];
    const updatedArtifacts = artifacts.map((a) => {
      const landed = pushedByKey.get(`${a.type}:${normalizeSha256Digest(a.digest) ?? a.digest}`);
      if (!landed?.location) return a;
      if (a.type === "blob") {
        // Point BOTH byte-channel URLs at the destination blob store (the origin's URLs are not
        // reachable across the CDS). The signature CONTENT is the origin's, carried verbatim.
        return { ...a, location: landed.location, signatureRef: `${landed.location}.sig` };
      }
      return { ...a, location: landed.location };
    });
    await tx
      .update(changes)
      .set({ sourceRef: { ...sourceRef, artifacts: updatedArtifacts }, updatedAt: new Date() })
      .where(and(eq(changes.orgId, input.orgId), eq(changes.objectId, ctx.change.objectId)));

    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: RETRANS_RELAY_IMPORT_DECISION_KIND,
      subjectId: ctx.change.objectId,
      verdict: "allow",
      inputContext: {
        tarballPath: input.tarballPath,
        sourceChangeObjectId: ctx.sourceChangeObjectId,
        pushed
      },
      reasonTree: {
        summary:
          "relay tarball signature + checksums verified; every carried artifact is in the local " +
          "authorized set; images pushed by digest and re-inspected — the M17.4(a)+(b) gates " +
          "still verify everything before deploy (zero trust in the relay)"
      }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.relay.import.applied",
      subjectId: ctx.change.objectId,
      reason: `relayed bytes landed: ${pushed.map((p) => `${p.type} ${p.digest}`).join(", ")}`,
      decisionId: decision.id,
      requestId: `federation-relay-import:${ctx.change.objectId}`
    });
    // M13.1a (D4, validate-gated by construction — this tx runs only after every verification
    // above passed and the bytes landed): the tarball hop's `bundle_transfers` row, CONFIRMED.
    // Purely observational bookkeeping (the repo header's invariant holds — never authority);
    // written for the CLI and the unattended inbox loop alike, so both paths stay identical.
    if (ctx.change.importedFromDomain) {
      await recordBundleTransfer(tx, {
        orgId: input.orgId,
        peerDomainId: ctx.change.importedFromDomain,
        direction: "import",
        kind: "promotion",
        status: "confirmed",
        checksum: tarballSha256
      });
    }
    return decision.id;
  });

  return { refused: false, localChangeObjectId: ctx.change.objectId, pushed, decisionId };
}

// -------------------------------------------------------------------------------------------------
// RETRANS SIDE, INBOUND — validateAndForwardRelayTarball (M13.1a, proposal §13.1): the push-less
// VALIDATE-AND-FORWARD for a relay tarball ARRIVING AT a `role: retrans` staging node (the
// high-side hop of a double-retrans CDS crossing). A retrans has NO registry to push into
// (deployment profile, §13.1) — its whole job on this hop is: run the SAME verification the
// destination import runs (`extractAndVerifyRelayTarball`, the byte-equivalent extraction — "a
// refactor, not a new trust decision"), then hand the UNTOUCHED original tarball bytes to the
// outbound DeliveryTarget drop. It imports nothing, pushes nothing, decides nothing about the
// promotion (ADR-0004: retrans never terminates a promotion).
// -------------------------------------------------------------------------------------------------

export interface ForwardRelayTarballInput {
  orgId: string;
  /** The LOCAL imported change at the retrans (its `.scpbundle` import — M17.4(a) already ran). */
  changeIdOrUrn: string;
  /** Absolute path of the arriving relay tarball (caller resolves it under the inbox). */
  tarballPath: string;
  /** The UPSTREAM relay instance's cosign PUBLIC key PEM (the low-side retrans that built and
   *  signed this tarball) — registered on its peer row at pairing, or operator-provided. */
  relayCosignPublicKeyPem: string;
  /** The resolved OUTBOUND drop directory (the onward DeliveryTarget — §13.2). */
  outDir: string;
  /** The DOWNSTREAM boundary peer this onward hop targets (its federation domain id) — the loop
   *  resolves it from `resolveOnwardOutDir`'s peer match. Used ONLY to attribute the onward
   *  `export`/`submitted` `bundle_transfers` row to the peer the drop actually goes to (M16.1
   *  per-peer surface); observational only (the ledger is never authority). Absent (env-fallback
   *  drop, no downstream peer resolvable) → falls back to the upstream import peer. */
  onwardPeerDomainId?: string;
  /** File name to drop under `outDir` (defaults to the tarball's own basename); rides the
   *  `resolveUnderDir` traversal guard. */
  fileName?: string;
  config?: RelayConfig;
}

export type ForwardRelayTarballResult =
  | {
      refused: false;
      localChangeObjectId: string;
      /** Where the (byte-identical) tarball was dropped for the onward hop. */
      forwardedPath: string;
      artifacts: RelayArtifactSummary[];
      decisionId: string;
    }
  | { refused: true; decisionId: string; reason: string };

export async function validateAndForwardRelayTarball(
  db: Db,
  input: ForwardRelayTarballInput
): Promise<ForwardRelayTarballResult> {
  const config = input.config ?? relayConfigFromEnv();

  // Phase 1 (tx): ROLE ARM + resolve the local change's own (a)-verified authorized set — the
  // AUTHORITY on what may pass through (zero trust in the tarball's own manifest). Pure DB.
  const ctx = await withTenantTx(db, input.orgId, async (tx) => {
    const self = await ensureFederationSelf(tx, input.orgId);
    // The SAME role arm as buildRelayTarball (ADR-0004): only a retrans-role instance runs the
    // push-less forward — an outpost that receives a tarball IMPORTS it (importRelayTarball).
    if (self.role !== "retrans") {
      throw conflict(
        `relay validate-and-forward requires federation role 'retrans' (this domain's role is ` +
          `'${self.role}') — outposts import relay tarballs (scp federation relay-import); only ` +
          `the CDS-boundary staging node forwards them (proposal §13.1)`
      );
    }
    const change = await getChangeRow(tx, input.orgId, input.changeIdOrUrn);
    const manifestRef = crossBoundaryManifestOf(change);
    if (!manifestRef) {
      throw badRequest(
        "local change carries no M17.4(a)-verified cross-boundary promotion manifest — import " +
          "the promotion .scpbundle (scp federation import) BEFORE forwarding its byte tarball"
      );
    }
    const sourceRef = (change.sourceRef ?? {}) as Record<string, unknown>;
    return {
      change,
      authorized: manifestRef.artifacts,
      sourceChangeObjectId:
        typeof sourceRef.sourceChangeObjectId === "string" ? sourceRef.sourceChangeObjectId : null
    };
  });

  // Phase 2 (no tx): the EXTRACTED verification — tarball signature, per-file checksums,
  // manifest binding, authorized-set cross-check, per-artifact layout/blob integrity — with the
  // push half absent and `requireBlobLandingDir: false` (the tarball is forwarded WHOLE; nothing
  // lands here). Then the onward drop of the ORIGINAL file bytes. NO skopeo ever runs on this
  // path — the retrans profile needs no registry for the forward hop.
  const workDir = await makeScratchDir();
  // TOCTOU close (copy-once-then-operate-on-the-private-copy): input.tarballPath sits in the
  // attacker-writable low-side inbox. A low-side writer who SWAPS it between our verify and our
  // forward-copy would push UNVALIDATED bytes across the boundary drop under an allow Decision —
  // the exact zero-trust invariant this feature protects. So we ingest its bytes into the
  // server-controlled scratch dir EXACTLY once, then hash + verify + forward-copy ALL from that
  // private copy. After this copy `input.tarballPath` is never read again: a mid-window swap
  // changes only the abandoned inbox file, never the bytes we verify/forward/hash. The copy+hash
  // live INSIDE the try so a missing/unreadable inbox path converges to the fail-closed block
  // Decision (D4), not a raw throw.
  let tarballSha256: string | null = null;
  let refusalReason: string | null = null;
  let artifacts: RelayArtifactSummary[] = [];
  let forwardedPath: string | null = null;
  try {
    const privateTarball = path.join(workDir, "ingress-relay.tar.gz");
    await copyFile(input.tarballPath, privateTarball);
    tarballSha256 = await sha256File(privateTarball);
    const verified = await extractAndVerifyRelayTarball({
      workDir,
      tarballPath: privateTarball,
      relayCosignPublicKeyPem: input.relayCosignPublicKeyPem,
      localSourceChangeObjectId: ctx.sourceChangeObjectId,
      authorized: ctx.authorized,
      requireBlobLandingDir: false,
      config
    });
    artifacts = verified.relayManifest.artifacts.map((a) => ({ type: a.type, digest: a.digest }));
    // The onward drop: the VERIFIED private-copy bytes, byte-identical to what was validated (the
    // low-side retrans's signature stays the receiving outpost's trust anchor — this node re-signs
    // NOTHING and adds no verification authority). Copied from the private copy, never re-read from
    // the inbox. The drop file name (naming only, not a byte read) rides the traversal guard.
    const dropName = input.fileName ?? path.basename(input.tarballPath);
    const dropPath = resolveUnderDir(input.outDir, dropName);
    await mkdir(input.outDir, { recursive: true });
    await copyFile(privateTarball, dropPath);
    forwardedPath = dropPath;
  } catch (err) {
    // Same convergence as the destination import: a failing check (or a failed drop — which must
    // equally never confirm, D4) becomes ONE block Decision, fail-closed.
    if (err instanceof RelayImportRefusal) refusalReason = err.message;
    else
      refusalReason = `relay forward error (fail-closed): ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  if (refusalReason !== null || forwardedPath === null) {
    const reason = refusalReason ?? "relay forward failed (fail-closed)";
    // D4 — VALIDATE-GATED, NEVER BLIND: a refusal writes the block Decision + hash-chained audit
    // event and NO `bundle_transfers` confirmation — the transfer visibly stalls at the boundary
    // rather than the ledger asserting a crossing that validation refused.
    const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
      const decision = await insertDecision(tx, {
        orgId: input.orgId,
        kind: RETRANS_RELAY_FORWARD_DECISION_KIND,
        subjectId: ctx.change.objectId,
        verdict: "block",
        inputContext: {
          tarballPath: input.tarballPath,
          tarballSha256,
          sourceChangeObjectId: ctx.sourceChangeObjectId,
          authorizedArtifacts: ctx.authorized.map((a) => ({ type: a.type, digest: a.digest }))
        },
        reasonTree: { summary: reason }
      });
      await appendAuditEvent(tx, {
        orgId: input.orgId,
        actorId: FEDERATION_IMPORT_ACTOR_ID,
        action: "federation.relay.forward.blocked",
        subjectId: ctx.change.objectId,
        reason,
        decisionId: decision.id,
        requestId: `federation-relay-forward:${ctx.change.objectId}`
      });
      return decision.id;
    });
    return { refused: true, decisionId, reason };
  }

  // Success (validate-gated, D4): allow Decision + audit + the CONFIRMED inbound-hop transfer row
  // and the SUBMITTED onward-drop row — the M16.1 boundary pipeline's per-hop state.
  const finalForwardedPath = forwardedPath;
  const decisionId = await withTenantTx(db, input.orgId, async (tx) => {
    const decision = await insertDecision(tx, {
      orgId: input.orgId,
      kind: RETRANS_RELAY_FORWARD_DECISION_KIND,
      subjectId: ctx.change.objectId,
      verdict: "allow",
      inputContext: {
        tarballPath: input.tarballPath,
        tarballSha256,
        sourceChangeObjectId: ctx.sourceChangeObjectId,
        authorizedArtifacts: ctx.authorized.map((a) => ({ type: a.type, digest: a.digest })),
        forwardedPath: finalForwardedPath
      },
      reasonTree: {
        summary:
          "relay tarball signature + checksums verified and every carried artifact is in the " +
          "local authorized set; tarball forwarded byte-identical to the onward delivery drop — " +
          "no registry push (retrans deployment profile), no verification authority added " +
          "(the receiving outpost's M17.4(a)+(b) gates run unweakened)"
      }
    });
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: FEDERATION_IMPORT_ACTOR_ID,
      action: "federation.relay.forwarded",
      subjectId: ctx.change.objectId,
      reason: `relay tarball validated and forwarded: ${finalForwardedPath}`,
      decisionId: decision.id,
      requestId: `federation-relay-forward:${ctx.change.objectId}`
    });
    // The inbound hop's CONFIRMED row is keyed on the UPSTREAM low-side peer we imported from.
    if (ctx.change.importedFromDomain) {
      await recordBundleTransfer(tx, {
        orgId: input.orgId,
        peerDomainId: ctx.change.importedFromDomain,
        direction: "import",
        kind: "promotion",
        status: "confirmed",
        checksum: tarballSha256
      });
    }
    // The onward hop's SUBMITTED row is keyed on the DOWNSTREAM boundary peer the drop TARGETS —
    // not the upstream peer (minor fix: this used to mis-attribute the onward hop to the source).
    // Env-fallback drop (no downstream peer resolvable) → attribute to the upstream peer as before.
    const onwardPeerDomainId = input.onwardPeerDomainId ?? ctx.change.importedFromDomain;
    if (onwardPeerDomainId) {
      await recordBundleTransfer(tx, {
        orgId: input.orgId,
        peerDomainId: onwardPeerDomainId,
        direction: "export",
        kind: "promotion",
        status: "submitted",
        checksum: tarballSha256
      });
    }
    return decision.id;
  });

  return {
    refused: false,
    localChangeObjectId: ctx.change.objectId,
    forwardedPath: finalForwardedPath,
    artifacts,
    decisionId
  };
}

/** Re-exported for the route/test layer: is `candidate` (a file name, possibly nested) safely
 *  inside `baseDir` after resolution? Refuses absolute paths and `..` traversal. */
export function resolveUnderDir(baseDir: string, candidate: string): string {
  const resolved = path.resolve(baseDir, candidate);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw badRequest(`file '${candidate}' does not resolve inside the configured relay directory`);
  }
  return resolved;
}
