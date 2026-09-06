import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { ScpClient } from "@scp/sdk";
import type { ArtifactRef } from "@scp/schemas";
import { generateKeyPair, resolveCosign, signBlobDetached } from "@scp/cosign";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, changes, changeWaveTargets, decisions } from "../db/schema.js";
import { proposeChange } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import { reconcileOrgTick } from "./reconcile.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { pairPeer } from "../federation/peers-repo.js";
import {
  PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND,
  PRE_DEPLOY_ARTIFACT_VERIFY_PASSED_AUDIT_ACTION,
  runPreDeployArtifactGate
} from "./pre-deploy-gate.js";
import { asTrustDomainId } from "@scp/schemas";
import { TrustDomainId } from "@scp/schemas";

/**
 * M17.4(b) — PER-ARTIFACT BYTE VERIFICATION, the operator-loaded pre-deploy VERIFY
 * (coordination/pre-deploy-gate.ts + federation/artifact-verify.ts), end to end against a REAL
 * local OCI registry (`registry:2` via Testcontainers) and the REAL cosign binary (the same
 * pinned/PATH resolution every other cosign call uses — @scp/cosign).
 *
 * The scenario modeled is exactly the production shape: a cross-boundary promotion was imported
 * METADATA-ONLY (M17.4(a), #106 — the change's `sourceRef` carries the verified
 * `promotionManifest` + typed `artifacts[]` authorized set, `importedFromDomain` names the
 * exporting peer), then the operator side-loaded the artifact BYTES into the outpost's reachable
 * registry. Before reconcile's `coordinated -> executing` edge triggers the deploy executor, the
 * gate must prove — for EVERY artifact in the authorized set — that the bytes are present and
 * their signature verifies against the EXPORTER's distributed cosign public key
 * (`currentPeerCosignPublicKey`, E5): `cosign verify` (registry-attached sig) for `oci`,
 * `cosign verify-blob` (origin detached sig, `signatureRef`) for `blob`. Keyful/offline.
 *
 * Fail-closed axes proven here: MISSING bytes, a wrong-key/tampered image signature, a bad blob
 * signature, SUBSTITUTION via the unsigned `location` (a different validly-signed image/blob than
 * the manifest-authorized digest — digest binding), SSRF (a bundle-supplied blob URL outside
 * the operator-configured `SCP_ARTIFACT_BLOB_BASE_URLS` is rejected WITHOUT being fetched), and
 * the symmetric OCI-HOST guard (ADR-0019 §4 / M15.5(c): a bundle-supplied OCI location whose
 * registry host is outside the operator-configured `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` is rejected
 * WITHOUT cosign ever dialing it, and an UNSET allowlist refuses every OCI verify) — each
 * BLOCKS the deploy with a `block` Decision + hash-chained audit event, PARKS the change, and
 * never fires `trigger()`. Scope axes: a domain-local change (no manifest — ADR-0013 exemption)
 * and a pre-manifest imported change deploy UNGATED, exactly as before.
 *
 * Coordinate-not-execute: the suite's registry reads happen inside cosign/the gate — SCP never
 * pushes, copies, or transports bytes (byte TRANSPORT is M15.5; the operator side-load here is
 * the TEST harness playing the operator, not SCP).
 */

const sha256 = (buf: Buffer): string => "sha256:" + createHash("sha256").update(buf).digest("hex");

describe("M17.4(b) per-artifact byte verification — the pre-deploy gate (Testcontainers + registry:2 + cosign)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let registry: StartedTestContainer;
  let registryHost: string; // host:port of the local registry the "operator side-loaded" bytes into
  let blobServer: Server;
  let blobBaseUrl: string;
  const blobStore = new Map<string, Buffer>();
  /** A second, NOT-allowlisted HTTP endpoint modeling an internal in-cluster service a hostile
   *  bundle tries to steer the outpost's blob fetch at (SSRF axis h) — and, doubling as a decoy
   *  OCI registry host, the target of a non-allowlisted oci `location` (OCI-host axis i). Counts
   *  every request it receives — both guards must block BEFORE any request, so this must stay 0. */
  let forbiddenServer: Server;
  let forbiddenUrl: string;
  let forbiddenHits = 0;

  let scratch: string; // key material for the test's "exporter" and an attacker
  let exporterKey: { keyPath: string; pubKeyPath: string; publicKeyPem: string };
  let attackerKey: { keyPath: string; pubKeyPath: string };
  let cosignBin: string;
  let imageSignFlags: string[];

  /** The exporting peer (as paired locally, E5-complete: its cosign VERIFICATION key registered). */
  const exporterDomainId = asTrustDomainId(uuidv7());
  /** A second peer paired PRE-E5 (no cosign key) — the key-vanished fail-closed axis. */
  const keylessDomainId = asTrustDomainId(uuidv7());

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "predeploy-gate");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // The outpost-local registry the operator side-loads bytes into (plain HTTP — the cosign
    // SIGNATURE is the trust anchor, not registry TLS; see VerifyImageOptions.allowInsecureRegistry).
    registry = await new GenericContainer("registry:2").withExposedPorts(5000).start();
    registryHost = `${registry.getHost()}:${registry.getMappedPort(5000)}`;
    // OCI-host egress guard config (ADR-0019 §4): the OPERATOR allowlists the registry host(s) the
    // per-artifact `cosign verify` may dial — this IS the operator-configures-it story: the byte
    // channel's registry is named explicitly, every other bundle-supplied host is refused before
    // any dial, and UNSET refuses every OCI verify (fail-closed; proven in axis j).
    process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = registryHost;
    // Per-host TLS scoping: the gate grants cosign `--allow-insecure-registry` ONLY to hosts in
    // SCP_ARTIFACT_INSECURE_HOSTS (a separate list from the egress allowlist above — this IS the
    // operator story for a plain-HTTP registry: list it here or it gets full TLS verification).
    process.env.SCP_ARTIFACT_INSECURE_HOSTS = registryHost;

    // Where blob artifacts (SBOM et al.) land: an HTTP store serving `location`/`signatureRef` URLs.
    blobServer = createServer((req, res) => {
      const bytes = req.url ? blobStore.get(req.url) : undefined;
      if (!bytes) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.end(bytes);
    });
    await new Promise<void>((resolve) => blobServer.listen(0, "127.0.0.1", resolve));
    blobBaseUrl = `http://127.0.0.1:${(blobServer.address() as AddressInfo).port}`;
    // SSRF guard config: the OPERATOR allowlists the blob byte channel's base URL. Only this base
    // is fetchable by the gate — every other bundle-supplied URL must be rejected before any request.
    process.env.SCP_ARTIFACT_BLOB_BASE_URLS = blobBaseUrl;

    // The internal service a hostile bundle points at (a different origin — not allowlisted).
    forbiddenServer = createServer((_req, res) => {
      forbiddenHits += 1;
      res.statusCode = 200;
      res.end("internal service response");
    });
    await new Promise<void>((resolve) => forbiddenServer.listen(0, "127.0.0.1", resolve));
    forbiddenUrl = `http://127.0.0.1:${(forbiddenServer.address() as AddressInfo).port}`;

    // Key material. The EXPORTER's cosign keypair models the E5-distributed key: its PUBLIC half is
    // registered on the peer pairing (below) — the ONLY trust anchor the gate verifies against. The
    // attacker's keypair signs the "tampered" artifacts: real signatures, wrong key.
    scratch = await mkdtemp(path.join(tmpdir(), "scp-m174b-"));
    const exporter = await generateKeyPair();
    const attacker = await generateKeyPair();
    exporterKey = {
      keyPath: path.join(scratch, "exporter.key"),
      pubKeyPath: path.join(scratch, "exporter.pub"),
      publicKeyPem: exporter.publicKeyPem
    };
    attackerKey = {
      keyPath: path.join(scratch, "attacker.key"),
      pubKeyPath: path.join(scratch, "attacker.pub")
    };
    await writeFile(exporterKey.keyPath, exporter.privateKeyPem, "utf8");
    await writeFile(exporterKey.pubKeyPath, exporter.publicKeyPem, "utf8");
    await writeFile(attackerKey.keyPath, attacker.privateKeyPem, "utf8");
    await writeFile(attackerKey.pubKeyPath, attacker.publicKeyPem, "utf8");

    // The test signs IMAGES with the cosign CLI directly (production SCP never image-signs — the
    // exporter's build executor does; this harness IS that exporter). Same offline flag posture as
    // @scp/cosign's sign-blob: no Rekor upload, and `--use-signing-config=false` only on builds that
    // have the flag (version-adaptive, mirroring signBlobFlags' probe).
    const resolved = resolveCosign();
    if (resolved.source === "missing")
      throw new Error("cosign binary not found for the M17.4(b) suite");
    cosignBin = resolved.bin;
    const signHelp = execFileSync(cosignBin, ["sign", "--help"], { encoding: "utf8" });
    imageSignFlags = [
      "--tlog-upload=false",
      ...(signHelp.includes("--use-signing-config") ? ["--use-signing-config=false"] : []),
      "--allow-insecure-registry",
      "--yes"
    ];

    // Pair the exporting peer E5-COMPLETE: its cosign verification public key registered — the key
    // `currentPeerCosignPublicKey` resolves and the gate trusts. Plus a PRE-E5 peer with none.
    const ed25519 = () =>
      generateKeyPairSync("ed25519")
        .publicKey.export({ format: "der", type: "spki" })
        .toString("base64");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await pairPeer(tx, {
        orgId: org.orgId,
        domainId: exporterDomainId,
        name: `exporter-${exporterDomainId.slice(0, 8)}`,
        role: "commander",
        publicKey: ed25519(),
        cosignPublicKey: exporterKey.publicKeyPem
      });
      await pairPeer(tx, {
        orgId: org.orgId,
        domainId: keylessDomainId,
        name: `keyless-${keylessDomainId.slice(0, 8)}`,
        role: "commander",
        publicKey: ed25519()
      });
    });
  }, 180_000);

  afterAll(async () => {
    delete process.env.SCP_ARTIFACT_BLOB_BASE_URLS;
    delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
    delete process.env.SCP_ARTIFACT_INSECURE_HOSTS;
    await server?.close();
    await registry?.stop();
    await new Promise<void>((resolve) =>
      blobServer ? blobServer.close(() => resolve()) : resolve()
    );
    await new Promise<void>((resolve) =>
      forbiddenServer ? forbiddenServer.close(() => resolve()) : resolve()
    );
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------------------------
  // Harness = the operator/exporter side: push bytes into the registry, attach cosign signatures.
  // (SCP itself only ever READS these — the gate runs cosign verify, never a push.)
  // ---------------------------------------------------------------------------------------------

  /** Minimal OCI image push over the distribution API (no docker client). Returns the
   *  digest-pinned reference `host:port/repo@sha256:...`. */
  async function pushImage(repo: string, seed: string): Promise<{ ref: string; digest: string }> {
    async function pushBlob(bytes: Buffer): Promise<{ digest: string; size: number }> {
      const digest = sha256(bytes);
      const start = await fetch(`http://${registryHost}/v2/${repo}/blobs/uploads/`, {
        method: "POST"
      });
      if (start.status !== 202) throw new Error(`blob upload start: HTTP ${start.status}`);
      const loc = start.headers.get("location") ?? "";
      const url = new URL(loc.startsWith("http") ? loc : `http://${registryHost}${loc}`);
      url.searchParams.set("digest", digest);
      const put = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(bytes)
      });
      if (put.status !== 201) throw new Error(`blob upload put: HTTP ${put.status}`);
      return { digest, size: bytes.length };
    }
    const layerBytes = Buffer.from(`layer-bytes-${seed}`);
    const layer = await pushBlob(layerBytes);
    const config = await pushBlob(
      Buffer.from(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          config: {},
          rootfs: { type: "layers", diff_ids: [sha256(layerBytes)] }
        })
      )
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: config.digest,
          size: config.size
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar",
            digest: layer.digest,
            size: layer.size
          }
        ]
      })
    );
    const digest = sha256(manifest);
    const put = await fetch(`http://${registryHost}/v2/${repo}/manifests/${digest}`, {
      method: "PUT",
      headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
      body: new Uint8Array(manifest)
    });
    if (put.status !== 201) throw new Error(`manifest put: HTTP ${put.status}`);
    return { ref: `${registryHost}/${repo}@${digest}`, digest };
  }

  /** `cosign sign` the digest-pinned image ref (registry-attached signature), keyful/offline. */
  function signImage(ref: string, keyPath: string): void {
    execFileSync(cosignBin, ["sign", "--key", keyPath, ...imageSignFlags, ref], {
      encoding: "utf8",
      env: { ...process.env, COSIGN_PASSWORD: "" }
    });
  }

  /** Serve `bytes` (+ a detached cosign signature over them, made with `keyPath`) from the blob
   *  store; returns the artifact's `location`/`signatureRef` URLs and content digest. */
  async function serveSignedBlob(
    name: string,
    bytes: Buffer,
    keyPath: string,
    pubKeyPath: string
  ): Promise<{ location: string; signatureRef: string; digest: string }> {
    const blobPath = path.join(scratch, `${name}.bin`);
    const sigPath = path.join(scratch, `${name}.sig`);
    await writeFile(blobPath, bytes);
    signBlobDetached(blobPath, sigPath, { keyPath, pubKeyPath, password: "", isEphemeral: true });
    const signature = await readFile(sigPath);
    blobStore.set(`/${name}`, bytes);
    blobStore.set(`/${name}.sig`, signature);
    return {
      location: `${blobBaseUrl}/${name}`,
      signatureRef: `${blobBaseUrl}/${name}.sig`,
      digest: sha256(bytes)
    };
  }

  // ---------------------------------------------------------------------------------------------
  // SCP-side helpers: the post-import change shape + the reconcile tick + assertion queries.
  // ---------------------------------------------------------------------------------------------

  /** A change exactly as M17.4(a)'s `applyPromotionImport` leaves one: `sourceRef` carrying the
   *  verified `promotionManifest` + typed `artifacts[]` authorized set, `importedFromDomain` set. */
  async function proposeImportedChange(
    artifacts: ArtifactRef[],
    opts: {
      fromDomain?: TrustDomainId;
      withManifest?: boolean;
      /** Cross-change prerequisite KEYS (M12 P4B), pinned at this change's own component so they
       *  are resolvable but unprovided — i.e. permanently unsatisfied, which parks the change in
       *  `waiting`. Used only by the per-tick-flood test. */
      requiresKeys?: string[];
    } = {}
  ): Promise<{ changeId: string; componentId: string }> {
    const component = await createTestComponent(admin, {
      name: `m174b-${randomUUID().slice(0, 8)}`
    });
    const fromDomain = opts.fromDomain ?? exporterDomainId;
    const withManifest = opts.withManifest ?? true;
    const { change } = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      proposeChange(tx, {
        orgId: org.orgId,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: `m174b-${randomUUID()}`,
        name: `promoted release ${randomUUID().slice(0, 8)}`,
        targets: [component.id],
        sourceKind: "federation",
        sourceRef: {
          promotedFromDomain: fromDomain,
          artifactDigests: artifacts.map((a) => a.digest),
          artifacts,
          // Presence of the (a)-verified manifest is what scopes the gate; its inner shape was
          // already cosign-verified at import and is not re-parsed by (b).
          ...(withManifest
            ? {
                promotionManifest: {
                  artifacts: artifacts.map((a) => ({ type: a.type, digest: a.digest }))
                }
              }
            : {})
        },
        ...(opts.requiresKeys
          ? { requires: opts.requiresKeys.map((key) => ({ key, at: component.id })) }
          : {}),
        importedFromDomain: fromDomain
      })
    );
    return { changeId: change.id, componentId: component.id };
  }

  /** One full reconcile tick (proposed -> ... -> executing -> trigger), long fake auto-succeed so
   *  a triggered target is still observable as triggered when asserted. */
  const tick = () =>
    reconcileOrgTick(
      server.deps.db,
      org.orgId,
      createInMemoryFakeHost({ autoSucceedAfterMs: 60_000 }),
      getSharedCelSandbox(),
      server.deps.config.secretsMasterKey
    );

  const changeRow = async (changeId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeId))
    );
    return row!;
  };
  const waveTargetsFor = (componentId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(changeWaveTargets).where(eq(changeWaveTargets.targetObjectId, componentId))
    );
  const gateDecisionsFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.subjectId, changeId))
    ).then((rows) => rows.filter((d) => d.kind === PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND));
  const gateAuditFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeId))
    ).then((rows) => rows.filter((e) => e.action === "change.pre_deploy.artifact_verify.blocked"));
  /** M16.1 (I2) — the PASSING verify's audit action, the `.blocked` action's sibling. */
  const passAuditFor = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.subjectId, changeId))
    ).then((rows) =>
      rows.filter((e) => e.action === PRE_DEPLOY_ARTIFACT_VERIFY_PASSED_AUDIT_ACTION)
    );

  /** The three fail-closed invariants every BLOCK case must satisfy. */
  async function expectBlocked(
    changeId: string,
    componentId: string
  ): Promise<{ decisionId: string; reason: string }> {
    // 1. The deploy never fired: the change never left `coordinated`, its wave target was never
    //    handed to any executor.
    const row = await changeRow(changeId);
    expect(row.state).toBe("coordinated");
    expect(row.reconcileBlockedAt).not.toBeNull(); // parked out of the sweep (fail-closed, once)
    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.status).toBe("pending");
    expect(targets[0]!.executorRef).toBeNull();

    // 2. A `block` Decision persists the verdict + inputs (explainability, charter #6).
    const blockDecisions = await gateDecisionsFor(changeId);
    expect(blockDecisions).toHaveLength(1);
    const decision = blockDecisions[0]!;
    expect(decision.verdict).toBe("block");
    expect(decision.id).toEqual(expect.any(String));

    // 3. A hash-chained audit event in the same tx carries that decision_id.
    const audit = await gateAuditFor(changeId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.decisionId).toBe(decision.id);
    expect(audit[0]!.rowHash).toEqual(expect.any(String));

    return {
      decisionId: decision.id,
      reason: (decision.reasonTree as { summary?: string }).summary ?? ""
    };
  }

  // ---------------------------------------------------------------------------------------------
  // (a) PASS — bytes present, image + blob signatures verify against the exporter key -> deploy.
  // Doubles as the OCI-host allowlist POSITIVE axis: the image's registry host IS the
  // operator-allowlisted SCP_ARTIFACT_OCI_REGISTRY_HOSTS entry (beforeAll), so the verify dials it
  // exactly as before the allowlist existed.
  // ---------------------------------------------------------------------------------------------
  it("(a) PASS: present + exporter-signed oci image AND blob => the deploy proceeds", async () => {
    const image = await pushImage("scp/pass-img", "pass");
    signImage(image.ref, exporterKey.keyPath);
    const blob = await serveSignedBlob(
      "pass-sbom",
      Buffer.from(`{"sbom":"pass-${randomUUID()}"}`),
      exporterKey.keyPath,
      exporterKey.pubKeyPath
    );

    const { changeId, componentId } = await proposeImportedChange([
      { type: "oci", digest: image.digest, location: image.ref, signatureRef: "registry-attached" },
      {
        type: "blob",
        digest: blob.digest,
        location: blob.location,
        signatureRef: blob.signatureRef,
        format: "cyclonedx"
      }
    ]);

    await tick();

    // Both artifacts verified -> the gate let the `coordinated -> executing` transition through and
    // reconcile triggered the deploy executor.
    const row = await changeRow(changeId);
    expect(row.state).toBe("executing");
    expect(row.reconcileBlockedAt).toBeNull();
    const targets = await waveTargetsFor(componentId);
    expect(targets).toHaveLength(1);
    expect(["triggered", "observing", "succeeded"]).toContain(targets[0]!.status);
    expect(targets[0]!.executorPluginId).toBe("fake-executor");

    // M16.1 (I2) — a PASSING verify now PERSISTS its verdict (it wrote nothing at all before, so
    // "verified" was indistinguishable from "never gated"). Exactly one Decision, verdict `allow`,
    // never a block, with the verified artifact set pinned in its inputs (charter principle 6)...
    const gateDecisions = await gateDecisionsFor(changeId);
    expect(gateDecisions).toHaveLength(1);
    expect(gateDecisions[0]!.verdict).toBe("allow");
    expect(
      (
        gateDecisions[0]!.inputContext as { authorizedArtifacts?: { digest: string }[] }
      ).authorizedArtifacts
        ?.map((a) => a.digest)
        .sort()
    ).toEqual([image.digest, blob.digest].sort());
    expect(await gateAuditFor(changeId)).toHaveLength(0); // ...and NOT the `.blocked` action.

    // ...and a hash-chained `.passed` audit event in the same tx carries that decision_id.
    const passAudit = await passAuditFor(changeId);
    expect(passAudit).toHaveLength(1);
    expect(passAudit[0]!.decisionId).toBe(gateDecisions[0]!.id);
    expect(passAudit[0]!.rowHash).toEqual(expect.any(String));
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (b) TAMPERED image — bytes present, signature from the WRONG key -> BLOCK, deploy never fires.
  // ---------------------------------------------------------------------------------------------
  it("(b) TAMPERED: an image signed by the wrong key is BLOCKED with a Decision; re-ticks append nothing", async () => {
    // A real registry-attached signature exists — made with the ATTACKER's key, not the exporter's
    // E5-distributed one. (The wrong-digest variant is equivalent: a substituted digest has no
    // signature that verifies against the exporter key either.)
    const image = await pushImage("scp/tampered-img", "tampered");
    signImage(image.ref, attackerKey.keyPath);

    const { changeId, componentId } = await proposeImportedChange([
      { type: "oci", digest: image.digest, location: image.ref, signatureRef: "registry-attached" }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/oci .*verification failed|byte verification failed/i);

    // Parked means parked: further sweeps must not re-verify, re-block, or double-write.
    await tick();
    expect(await gateDecisionsFor(changeId)).toHaveLength(1);
    expect(await gateAuditFor(changeId)).toHaveLength(1);
    expect((await changeRow(changeId)).state).toBe("coordinated");
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (c) BAD blob signatureRef — blob present, origin signature does not verify -> BLOCK.
  // ---------------------------------------------------------------------------------------------
  it("(c) BAD BLOB SIGNATURE: a blob whose signatureRef fails cosign verify-blob is BLOCKED", async () => {
    const blob = await serveSignedBlob(
      "bad-sig-sbom",
      Buffer.from(`{"sbom":"bad-${randomUUID()}"}`),
      attackerKey.keyPath, // wrong key: the signature is real but not the exporter's
      attackerKey.pubKeyPath
    );

    const { changeId, componentId } = await proposeImportedChange([
      {
        type: "blob",
        digest: blob.digest,
        location: blob.location,
        signatureRef: blob.signatureRef,
        format: "cyclonedx"
      }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/blob .*verification failed|byte verification failed/i);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (d) MISSING bytes — the operator never side-loaded them -> BLOCK (fail-closed), both kinds.
  // ---------------------------------------------------------------------------------------------
  it("(d) MISSING: authorized artifacts whose bytes are absent from the reachable registry are BLOCKED fail-closed", async () => {
    // An authorized digest the registry has never seen (metadata imported, bytes never loaded)...
    const absentImageRef = `${registryHost}/scp/never-loaded@sha256:${"0".repeat(64)}`;
    // ...and a blob whose location 404s. BOTH must fail closed — nothing deploys on a partial load.
    const { changeId, componentId } = await proposeImportedChange([
      {
        type: "oci",
        digest: `sha256:${"0".repeat(64)}`,
        location: absentImageRef,
        signatureRef: "registry-attached"
      },
      {
        type: "blob",
        digest: `sha256:${"1".repeat(64)}`,
        location: `${blobBaseUrl}/never-loaded`,
        signatureRef: `${blobBaseUrl}/never-loaded.sig`,
        format: "cyclonedx"
      }
    ]);

    await tick();
    const { decisionId, reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/absent|failed/i);

    // The Decision's inputContext names BOTH failing artifacts — the operator's remediation list.
    const [decision] = await gateDecisionsFor(changeId);
    const failing = (decision!.inputContext as { failing: Array<{ type: string; reason: string }> })
      .failing;
    expect(failing).toHaveLength(2);
    expect(failing.map((f) => f.type).sort()).toEqual(["blob", "oci"]);
    expect(failing.find((f) => f.type === "blob")!.reason).toMatch(/absent/i);
    expect(decisionId).toEqual(expect.any(String));
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (f) SUBSTITUTION (oci) — `location` is UNSIGNED bundle-side metadata; pointing it at a
  // DIFFERENT validly-signed image (same exporter key!) must NOT pass. The gate binds verification
  // to the manifest-signed `artifact.digest`, so the mismatch fails closed before cosign runs.
  // ---------------------------------------------------------------------------------------------
  it("(f) SUBSTITUTION-OCI: a location pinning a different validly-exporter-signed image than the authorized digest is BLOCKED on digest mismatch", async () => {
    // BOTH images genuinely signed by the exporter — the substitution's whole point is that the
    // decoy's registry-attached signature IS valid; only the digest binding can catch it.
    const victim = await pushImage("scp/substitution-victim", "victim");
    signImage(victim.ref, exporterKey.keyPath);
    const decoy = await pushImage("scp/substitution-decoy", "decoy");
    signImage(decoy.ref, exporterKey.keyPath);
    expect(decoy.digest).not.toBe(victim.digest);

    // Authorized (manifest-signed) digest = the victim's; hostile unsigned `location` = the decoy.
    const { changeId, componentId } = await proposeImportedChange([
      { type: "oci", digest: victim.digest, location: decoy.ref, signatureRef: "registry-attached" }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/oci digest mismatch/i);
    expect(reason).toContain(victim.digest); // names the authorized digest the location tried to dodge
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (g) SUBSTITUTION (blob) — validly-signed bytes whose sha256 != the authorized digest. The
  // detached signature verifies (exporter key, real bytes) — only hashing the FETCHED bytes and
  // requiring equality with `artifact.digest` catches the swap.
  // ---------------------------------------------------------------------------------------------
  it("(g) SUBSTITUTION-BLOB: exporter-signed blob bytes whose sha256 differs from the authorized digest are BLOCKED on digest mismatch", async () => {
    // The exporter validly signs the DECOY bytes; the manifest authorized a DIFFERENT document.
    const decoy = await serveSignedBlob(
      "substituted-sbom",
      Buffer.from(`{"sbom":"decoy-${randomUUID()}"}`),
      exporterKey.keyPath,
      exporterKey.pubKeyPath
    );
    const authorizedDigest = sha256(Buffer.from(`{"sbom":"authorized-but-never-served"}`));
    expect(decoy.digest).not.toBe(authorizedDigest);

    const { changeId, componentId } = await proposeImportedChange([
      {
        type: "blob",
        digest: authorizedDigest,
        location: decoy.location,
        signatureRef: decoy.signatureRef,
        format: "cyclonedx"
      }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/blob digest mismatch/i);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (h) SSRF — a hostile bundle-supplied blob `location` steering the outpost at an internal
  // service it can reach. The guard must reject BEFORE any request leaves the process: only
  // operator-configured base URLs (SCP_ARTIFACT_BLOB_BASE_URLS) are fetchable.
  // ---------------------------------------------------------------------------------------------
  it("(h) SSRF: a blob location targeting a non-allowlisted internal endpoint is BLOCKED fail-closed WITHOUT being fetched", async () => {
    const hitsBefore = forbiddenHits;
    const bytes = Buffer.from(`{"sbom":"ssrf-${randomUUID()}"}`);
    const { changeId, componentId } = await proposeImportedChange([
      {
        type: "blob",
        digest: sha256(bytes),
        location: `${forbiddenUrl}/latest/internal-service`, // reachable, internal, NOT allowlisted
        signatureRef: `${forbiddenUrl}/latest/internal-service.sig`,
        format: "cyclonedx"
      }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/SSRF|not under any operator-configured blob base URL/i);
    // The forbidden endpoint was NEVER contacted — the guard fires before the fetch, not after.
    expect(forbiddenHits).toBe(hitsBefore);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (i) OCI-HOST EGRESS (ADR-0019 §4, the #108 residual closed) — a hostile bundle-supplied OCI
  // `location` naming a NON-allowlisted registry host. Digest binding already prevents
  // substitution, but cosign would still DIAL that host (blind registry-API GETs — the egress
  // channel symmetric to the blob fetch). The guard must reject BEFORE cosign is invoked: the
  // decoy endpoint (hit-counting, reachable) must see ZERO requests.
  // ---------------------------------------------------------------------------------------------
  it("(i) OCI-HOST: an oci location naming a non-allowlisted registry host is BLOCKED fail-closed WITHOUT cosign ever dialing it", async () => {
    const hitsBefore = forbiddenHits;
    // A well-formed, digest-pinned ref at the decoy host — the digest MATCHES the authorized one,
    // so nothing but the host guard would stop this verify from dialing.
    const decoyHost = new URL(forbiddenUrl).host; // host:port — reachable, NOT allowlisted
    const digest = sha256(Buffer.from(`oci-host-axis-${randomUUID()}`));
    const { changeId, componentId } = await proposeImportedChange([
      {
        type: "oci",
        digest,
        location: `${decoyHost}/scp/exfil@${digest}`,
        signatureRef: "registry-attached"
      }
    ]);

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/oci registry host not allowlisted/i);
    expect(reason).toContain(decoyHost);
    // The decoy registry was NEVER contacted — the guard fires before cosign, not after.
    expect(forbiddenHits).toBe(hitsBefore);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // (j) OCI-HOST UNSET — SCP_ARTIFACT_OCI_REGISTRY_HOSTS unset refuses EVERY OCI verify
  // (fail-closed, symmetric with the blob allowlist; the DELIBERATE M15.5(c) behavior change —
  // operators must set the variable on upgrade). Even a present, correctly-exporter-signed image
  // in the local registry is refused: the operator has not opted the OCI egress in.
  // ---------------------------------------------------------------------------------------------
  it("(j) OCI-HOST UNSET: with no configured allowlist, every OCI verify is refused fail-closed — even a valid artifact", async () => {
    const image = await pushImage("scp/unset-env-img", "unset-env");
    signImage(image.ref, exporterKey.keyPath); // genuinely valid — would pass axis (a) if configured

    const { changeId, componentId } = await proposeImportedChange([
      { type: "oci", digest: image.digest, location: image.ref, signatureRef: "registry-attached" }
    ]);

    const saved = process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
    delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
    try {
      await tick();
    } finally {
      if (saved === undefined) delete process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS;
      else process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS = saved;
    }

    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/oci registry host not allowlisted/i);
    expect(reason).toMatch(/SCP_ARTIFACT_OCI_REGISTRY_HOSTS unset/i);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // Fail-closed key anomaly: manifest-carrying change, but the peer has NO registered cosign key.
  // ---------------------------------------------------------------------------------------------
  it("FAIL-CLOSED KEY ANOMALY: a manifest-carrying change whose peer has no cosign key is BLOCKED, not waved through", async () => {
    const image = await pushImage("scp/keyless-img", "keyless");
    signImage(image.ref, exporterKey.keyPath); // even a GOOD signature can't be verified without the key

    const { changeId, componentId } = await proposeImportedChange(
      [
        {
          type: "oci",
          digest: image.digest,
          location: image.ref,
          signatureRef: "registry-attached"
        }
      ],
      { fromDomain: keylessDomainId }
    );

    await tick();
    const { reason } = await expectBlocked(changeId, componentId);
    expect(reason).toMatch(/no exporter cosign public key/i);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // SCOPE — only manifest-carrying changes are gated (ADR-0013 domain-local exemption).
  // ---------------------------------------------------------------------------------------------
  it("SCOPE (e1): a domain-local change with no manifest deploys normally, completely ungated", async () => {
    // An ordinary local change — no import, no manifest. Nothing in its registry/bytes world exists
    // (the artifact digest below is pure fiction), and the gate must never even look.
    const component = await createTestComponent(admin, {
      name: `m174b-local-${randomUUID().slice(0, 8)}`
    });
    const change = await admin.changes.propose({
      name: "ordinary domain-local release",
      targets: [component.id]
    });

    await tick();

    const row = await changeRow(change.id);
    expect(row.state).toBe("executing");
    expect(row.reconcileBlockedAt).toBeNull();
    const targets = await waveTargetsFor(component.id);
    expect(targets).toHaveLength(1);
    expect(["triggered", "observing", "succeeded"]).toContain(targets[0]!.status);
    expect(await gateDecisionsFor(change.id)).toHaveLength(0);
    expect(await gateAuditFor(change.id)).toHaveLength(0);
    // M16.1 (I2) — THE VACUOUS EXIT MUST STAY SILENT. No verification ran here (the gate returned
    // before looking at anything), so an `allow` Decision or a `.passed` audit event would assert a
    // verification that never happened — the worst failure mode of the I2 change.
    expect(await passAuditFor(change.id)).toHaveLength(0);
  }, 60_000);

  it("SCOPE (e2): a PRE-MANIFEST imported change (no promotionManifest on sourceRef) deploys ungated — back-compat", async () => {
    // Imported from a genuine pre-E6 peer: `importedFromDomain` set, artifacts even present, but NO
    // verified manifest. M17.4(a) accepted it (no downgrade — the peer has no cosign key), and (b)
    // must leave it exactly as before: unverifiable-but-honest legacy, NOT a block.
    const { changeId, componentId } = await proposeImportedChange(
      [
        {
          type: "oci",
          digest: `sha256:${"7".repeat(64)}`,
          location: `${registryHost}/scp/legacy@sha256:${"7".repeat(64)}`
        }
      ],
      { fromDomain: keylessDomainId, withManifest: false }
    );

    await tick();

    const row = await changeRow(changeId);
    expect(row.state).toBe("executing");
    expect(row.reconcileBlockedAt).toBeNull();
    const targets = await waveTargetsFor(componentId);
    expect(["triggered", "observing", "succeeded"]).toContain(targets[0]!.status);
    expect(await gateDecisionsFor(changeId)).toHaveLength(0);
    expect(await passAuditFor(changeId)).toHaveLength(0); // M16.1 (I2) — vacuous exit stays silent.
  }, 60_000);

  it("SCOPE (e3): a METADATA-ONLY promotion (manifest, ZERO artifacts) deploys ungated and records NOTHING", async () => {
    // M16.1 (I2)'s second vacuous exit, and the sharper of the two: this change IS a verified
    // cross-boundary promotion — it carries `promotionManifest` and came from a peer WITH a
    // registered cosign key — it simply has no substantive bytes to verify (config/policy-only).
    // `runPreDeployArtifactGate` returns on `artifacts.length === 0` before any cosign runs.
    // An `allow` Decision here would read, in the boundary segment and in the audit log, exactly
    // like a change whose artifacts were fetched and cryptographically verified. Nothing was.
    const { changeId, componentId } = await proposeImportedChange([]);

    await tick();

    const row = await changeRow(changeId);
    expect(row.state).toBe("executing");
    expect(row.reconcileBlockedAt).toBeNull();
    const targets = await waveTargetsFor(componentId);
    expect(["triggered", "observing", "succeeded"]).toContain(targets[0]!.status);
    expect(await gateDecisionsFor(changeId)).toHaveLength(0);
    expect(await gateAuditFor(changeId)).toHaveLength(0);
    expect(await passAuditFor(changeId)).toHaveLength(0);
  }, 60_000);

  // ---------------------------------------------------------------------------------------------
  // THE PER-TICK FLOOD (M16.1 review B5). A change parked in `waiting` on an outstanding
  // cross-change prerequisite is re-swept EVERY tick, and `advanceWaitingChanges` runs this gate on
  // each one (defence-in-depth: `waiting -> executing` is a second edge into execution). Before I2
  // a passing verify wrote nothing, so that was free. Persisting the pass made every tick a new
  // `allow` Decision + a new hash-chained `.passed` audit event, for as long as the wait lasts —
  // the very "Decision per tick" flood `advanceWaitingChanges`'s own doc comment forbids, arriving
  // through a different door, and an audit chain asserting fresh events where nothing happened.
  //
  // (Unreachable in production today ONLY because `applyPromotionImport` strips `requires`, which
  // is a coincidence and precisely why that call site is labelled defence-in-depth. This test
  // constructs the shape directly rather than relying on that coincidence to stay true.)
  // ---------------------------------------------------------------------------------------------
  it("re-ticking a WAITING manifest-carrying change records the pass ONCE, not once per tick", async () => {
    const image = await pushImage("scp/waiting-img", "waiting");
    signImage(image.ref, exporterKey.keyPath);

    // Gated shape (verified manifest + one real artifact) AND an unsatisfiable prerequisite, so it
    // parks in `waiting` and is re-swept indefinitely instead of leaving for `executing`.
    const { changeId } = await proposeImportedChange(
      [
        {
          type: "oci",
          digest: image.digest,
          location: image.ref,
          signatureRef: "registry-attached"
        }
      ],
      { requiresKeys: [`never-provided-${randomUUID().slice(0, 8)}`] }
    );

    // Tick 1: the gate runs on the `coordinated` edge (allow recorded), then the change parks.
    await tick();
    expect((await changeRow(changeId)).state).toBe("waiting");
    const afterFirst = await gateDecisionsFor(changeId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]!.verdict).toBe("allow");
    expect(await passAuditFor(changeId)).toHaveLength(1);

    // Ticks 2 and 3: the WAITING sweep re-runs the gate. The verify itself still runs (the gate
    // stays fail-closed against bytes that vanish mid-wait) — but the verdict is unchanged over an
    // unchanged authorized set, so nothing new is recorded.
    await tick();
    await tick();

    expect((await changeRow(changeId)).state).toBe("waiting");
    const afterThird = await gateDecisionsFor(changeId);
    expect(afterThird).toHaveLength(1);
    expect(afterThird[0]!.id).toBe(afterFirst[0]!.id); // the SAME row, not a fresh identical one
    expect(await passAuditFor(changeId)).toHaveLength(1);
    expect(await gateAuditFor(changeId)).toHaveLength(0); // and never a block

    // The verdict the gate REPORTS is still the real one — suppressing the duplicate write must not
    // suppress the decision_id callers (and the boundary segment) rely on.
    const row = await changeRow(changeId);
    const gate = await runPreDeployArtifactGate(server.deps.db, org.orgId, row);
    expect(gate.blocked).toBe(false);
    expect(gate.decisionId).toBe(afterFirst[0]!.id);
    expect(await gateDecisionsFor(changeId)).toHaveLength(1);
  }, 120_000);

  // ---------------------------------------------------------------------------------------------
  // THE OTHER HALF OF THE B5 IDEMPOTENCE GUARD (M16.1 review D1). The suppression above is keyed on
  // BOTH `previous?.verdict === "allow"` AND the authorized-artifact-SET-KEY comparing equal
  // (`decisionArtifactSetKey(previous.inputContext) === artifactSetKey(verifiedArtifacts)`) —
  // never on the verdict alone. A change whose authorized artifact set CHANGES between two gate
  // runs over the SAME change row (e.g. a re-promotion landing before the change leaves
  // `coordinated`) is a DIFFERENT statement from the first allow, over a set that was never
  // verified before, and must be recorded as its own Decision + `.passed` audit event — not
  // shadowed by the earlier allow's decision_id. If it were shadowed, `boundary-segment.ts`'s
  // latest-verdict read would report `verified` for image B's artifact set on the strength of a
  // verify that only ever looked at image A: the fabricated-pass class M16.1 (I2) exists to rule
  // out, reached through the fix for B5.
  // ---------------------------------------------------------------------------------------------
  it("a REWRITTEN authorized artifact set on the same change row gets its OWN Decision, not the stale allow's id", async () => {
    const imageA = await pushImage("scp/rewrite-a-img", "rewrite-a");
    signImage(imageA.ref, exporterKey.keyPath);
    const imageB = await pushImage("scp/rewrite-b-img", "rewrite-b");
    signImage(imageB.ref, exporterKey.keyPath);
    expect(imageB.digest).not.toBe(imageA.digest);

    const { changeId } = await proposeImportedChange([
      {
        type: "oci",
        digest: imageA.digest,
        location: imageA.ref,
        signatureRef: "registry-attached"
      }
    ]);

    // First gate run: authorized set = { imageA }. Persists allow #1.
    const first = await runPreDeployArtifactGate(
      server.deps.db,
      org.orgId,
      await changeRow(changeId)
    );
    expect(first.blocked).toBe(false);
    expect(first.decisionId).toEqual(expect.any(String));

    // The authorized set CHANGES on the SAME change row — model a re-promotion directly by
    // rewriting `sourceRef.artifacts` + `promotionManifest` to a DIFFERENT, still-authentic image.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changes)
        .set({
          sourceRef: {
            promotedFromDomain: exporterDomainId,
            artifactDigests: [imageB.digest],
            artifacts: [
              {
                type: "oci",
                digest: imageB.digest,
                location: imageB.ref,
                signatureRef: "registry-attached"
              }
            ],
            promotionManifest: { artifacts: [{ type: "oci", digest: imageB.digest }] }
          }
        })
        .where(eq(changes.objectId, changeId))
    );

    // Second gate run: authorized set = { imageB } now. Must NOT return the first allow's id.
    const second = await runPreDeployArtifactGate(
      server.deps.db,
      org.orgId,
      await changeRow(changeId)
    );
    expect(second.blocked).toBe(false);
    expect(second.decisionId).toEqual(expect.any(String));
    expect(second.decisionId).not.toBe(first.decisionId); // a NEW verdict — the stale allow must not shadow it.

    // Exactly two gate Decisions exist for this change, both `allow`, never a `block`.
    const gateDecisions = await gateDecisionsFor(changeId);
    expect(gateDecisions).toHaveLength(2);
    expect(gateDecisions.every((d) => d.verdict === "allow")).toBe(true);
    expect(await gateAuditFor(changeId)).toHaveLength(0);

    // The second Decision's inputs are pinned to imageB's authorized set (charter principle 6) —
    // proof the second verify actually ran over the new set rather than replaying the first's.
    const secondDecision = gateDecisions.find((d) => d.id === second.decisionId);
    expect(secondDecision).toBeDefined();
    expect(
      (
        secondDecision!.inputContext as { authorizedArtifacts?: { digest: string }[] }
      ).authorizedArtifacts?.map((a) => a.digest)
    ).toEqual([imageB.digest]);

    // And exactly two `.passed` audit events — a fresh one for the second, genuinely-new verdict,
    // not a re-use of the first's.
    expect(await passAuditFor(changeId)).toHaveLength(2);
  }, 120_000);
});
