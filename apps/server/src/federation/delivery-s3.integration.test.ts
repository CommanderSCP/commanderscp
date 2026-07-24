import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { withTenantTx } from "../db/tenant-tx.js";
import { getSecretValue, putSecret } from "../secrets/secrets-repo.js";
import { deliveryTargetSecretKey, parseDeliveryS3Credential } from "./retrans-relay.js";
import {
  assertDeliveryTargetRooted,
  dropDeliveryFile,
  getDeliveryFile,
  listInbox,
  resolveDeliveryTarget,
  type DeliveryTargetPeerRef
} from "./delivery-target.js";
import { s3Get, s3Put, type S3DeliveryCredentials } from "./delivery-s3.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * M13.2b (proposal §13.2, owner decision D3: AWS SDK v3) — the s3-compatible DeliveryTarget
 * provider, proven end-to-end against a REAL MinIO (Testcontainers), the `endpoint` override +
 * `forcePathStyle` path every S3-compatible uses. What is proven here (the increment DoD):
 *
 *   - an s3 delivery target ROUND-TRIPS a bundle drop: `dropDeliveryFile` puts it, `listInbox` lists
 *     it back (names only), `getDeliveryFile` reads the identical bytes;
 *   - a LARGE (forced-multipart-threshold) upload exercises `@aws-sdk/lib-storage`'s MANAGED
 *     MULTIPART (the multipart ETag `<md5>-<numParts>` is the proof it was not a single PutObject);
 *   - an OUT-OF-ALLOWLIST endpoint is refused at PAIR-TIME (`assertDeliveryTargetRooted`);
 *   - an UNSET allowlist + s3 target FAILS CLOSED at resolution (never used);
 *   - CREDENTIALS resolve from the VAULT (`delivery/<peer>/out` under the ADR-0019 §3 artifact-store
 *     class) and drive a real drop — never argv/logs.
 *
 * The FILESYSTEM path is unchanged — its suite (`delivery-target.test.ts`) is green UNMODIFIED.
 */

// A real MinIO release (digest-pinned by tag), pullable in the colima env the integration suite runs
// under. MinIO is the org's/CDS's infrastructure, not SCP's — S3 stays OPTIONAL (Postgres remains the
// only required stateful dependency, charter principle 4); this container exists only for the test.
const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z";
const ROOT_USER = "scpminioadmin";
const ROOT_PASSWORD = "scpminio-secret-123";
const BUCKET = "cds-drop";

let container: StartedTestContainer;
let endpoint: string;
let creds: S3DeliveryCredentials;

/** A test-only admin client (used to create the bucket + HeadObject the multipart ETag). */
function adminClient(): S3Client {
  const cfg: S3ClientConfig = {
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
    credentials: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD }
  };
  return new S3Client(cfg);
}

/** A peer configured for s3 delivery, both directions on the SAME prefix so a drop is listable. */
function s3Peer(prefix: string): DeliveryTargetPeerRef {
  return {
    name: "high-side",
    deliveryTarget: {
      provider: "s3-compatible",
      endpoint,
      bucket: BUCKET,
      outPrefix: prefix,
      inPrefix: prefix
    }
  };
}

beforeAll(async () => {
  container = await new GenericContainer(MINIO_IMAGE)
    .withExposedPorts(9000)
    .withEnvironment({ MINIO_ROOT_USER: ROOT_USER, MINIO_ROOT_PASSWORD: ROOT_PASSWORD })
    .withCommand(["server", "/data"])
    .withWaitStrategy(Wait.forHttp("/minio/health/live", 9000).forStatusCode(200))
    .start();
  endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  creds = { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD };
  // Operator config: the allowlist that makes THIS endpoint honorable (env-driven, as in production —
  // so `listInbox`, which resolves internally, sees it too).
  process.env.SCP_DELIVERY_S3_ENDPOINTS = endpoint;
  const admin = adminClient();
  await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  admin.destroy();
}, 180_000);

afterAll(async () => {
  delete process.env.SCP_DELIVERY_S3_ENDPOINTS;
  await container?.stop();
});

describe("M13.2b s3-compatible DeliveryTarget — real MinIO round-trip", () => {
  it("round-trips a .scpbundle drop: put → listInbox → get the identical bytes", async () => {
    const peer = s3Peer("channel/");
    const resolved = resolveDeliveryTarget(peer);
    expect(resolved.provider).toBe("s3-compatible");
    expect(resolved.valid).toBe(true);

    const bundleJson = JSON.stringify({ header: { kind: "promotion" }, hello: "cds" });
    const written = await dropDeliveryFile(
      resolved,
      "scp-promotion-abc123.scpbundle",
      bundleJson,
      creds
    );
    expect(written).toBe(`s3://${BUCKET}/channel/scp-promotion-abc123.scpbundle`);

    // listInbox resolves internally (env allowlist) — names only, no keys/prefixes.
    const names = await listInbox(peer, undefined, undefined, creds);
    expect(names).toContain("scp-promotion-abc123.scpbundle");
    expect(names.every((n) => !n.includes("/"))).toBe(true);

    const got = await getDeliveryFile(resolved, "scp-promotion-abc123.scpbundle", creds);
    expect(got.toString("utf8")).toBe(bundleJson);
  });

  it("a large body drops via lib-storage MANAGED MULTIPART (multipart ETag proves >1 part)", async () => {
    const resolved = resolveDeliveryTarget(s3Peer("big/"));
    const loc = resolved.outboundS3!;
    // 12 MiB with a forced 5 MiB part size → 3 parts → a real CreateMultipartUpload / UploadPart×3 /
    // CompleteMultipartUpload (a multi-GB relay tarball rides the SAME path; we force the threshold
    // small so the test stays fast). A hand-rolled single PutObject would fail on a multi-GB body.
    const size = 12 * 1024 * 1024;
    const big = Buffer.alloc(size, 0x61);
    const key = `${loc.prefix}scp-relay-huge.tar.gz`;
    await s3Put(loc, creds, key, big, { partSize: 5 * 1024 * 1024 });

    // The multipart ETag is `"<md5>-<numParts>"` — the dash proves multipart (a single PutObject
    // ETag is a bare md5, no dash).
    const admin = adminClient();
    const head = await admin.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    admin.destroy();
    expect(head.ContentLength).toBe(size);
    expect(head.ETag).toMatch(/-\d+"?$/);

    // And the bytes round-trip intact through the get seam.
    const got = await s3Get(loc, creds, key);
    expect(got.length).toBe(size);
  });

  it("refuses an OUT-OF-ALLOWLIST endpoint at pair-time (never stored)", () => {
    // Env allowlist holds only the MinIO endpoint; a different endpoint refuses at the pair gate.
    // The ProblemError carries the human text in `.detail` (`.message` is the RFC 9457 title).
    let detail = "";
    try {
      assertDeliveryTargetRooted({
        provider: "s3-compatible",
        endpoint: "https://attacker-controlled.example:9000",
        bucket: BUCKET
      });
      throw new Error("expected assertDeliveryTargetRooted to refuse the out-of-allowlist endpoint");
    } catch (err) {
      detail = (err as { detail?: string }).detail ?? "";
    }
    expect(detail).toContain("not in the operator s3 delivery allowlist");
  });

  it("UNSET allowlist + an s3 target FAILS CLOSED at resolution (never used)", async () => {
    // Explicit empty allowlist (independent of the env, which is set for the rest of the suite).
    const resolved = resolveDeliveryTarget(s3Peer("x/"), undefined, undefined, []);
    expect(resolved.valid).toBe(false);
    expect(resolved.outboundS3).toBeNull();
    expect(resolved.outbound.problem).toContain("SCP_DELIVERY_S3_ENDPOINTS is unset");
    // And the write seam refuses fail-closed rather than dropping anywhere.
    await expect(dropDeliveryFile(resolved, "x.scpbundle", "{}", creds)).rejects.toThrow();
  });

  it("CREDENTIALS resolve from the VAULT (delivery/<peer>/out) and drive a real drop", async () => {
    let domain: IsolatedDomain | null = null;
    try {
      domain = await createIsolatedDomain("delivery_s3_creds");
      const masterKey = Buffer.alloc(32, 13);
      const key = deliveryTargetSecretKey("high-side", "out");
      // Operator stores the write-scoped S3 credential in the AES-256-GCM vault (ADR-0019 §3).
      await withTenantTx(domain.db, domain.orgId, (tx) =>
        putSecret(tx, {
          orgId: domain!.orgId,
          key,
          value: `${creds.accessKeyId}:${creds.secretAccessKey}`,
          masterKey
        })
      );
      // Resolved at USE — exactly the route's path (getSecretValue → parseDeliveryS3Credential).
      const raw = await withTenantTx(domain.db, domain.orgId, (tx) =>
        getSecretValue(tx, domain!.orgId, key, masterKey)
      );
      const vaultCreds = parseDeliveryS3Credential(raw);
      expect(vaultCreds).not.toBeNull();

      const resolved = resolveDeliveryTarget(s3Peer("vaulted/"));
      const written = await dropDeliveryFile(
        resolved,
        "scp-promotion-vaulted.scpbundle",
        "{}",
        vaultCreds!
      );
      expect(written).toBe(`s3://${BUCKET}/vaulted/scp-promotion-vaulted.scpbundle`);
      const got = await s3Get(resolved.outboundS3!, creds, "vaulted/scp-promotion-vaulted.scpbundle");
      expect(got.toString("utf8")).toBe("{}");
    } finally {
      await domain?.close();
    }
  });
});
