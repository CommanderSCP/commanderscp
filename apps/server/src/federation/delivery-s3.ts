/**
 * 13.2b — the `s3-compatible` DeliveryTarget client (proposal §13.2, owner decision D3: AWS SDK v3).
 *
 * The put/list/get half of the provider dispatch in `delivery-target.ts`. Isolated here so the AWS
 * SDK import lives behind one seam (delivery-target.ts stays db-free and provider-agnostic), and so
 * the S3 path is exercised as a unit against MinIO.
 *
 * WHY the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`) and not a hand-rolled PutObject
 * (owner decision D3): relay tarballs are multi-GB, and `lib-storage`'s managed MULTIPART upload is
 * the difference between a working drop and a hand-rolled one that fails on large bodies; first-party
 * SigV4 correctness (chunked/streaming signing edge cases) and built-in retry/backoff are exactly the
 * surface an unattended boundary loop must not get subtly wrong. The vendoring cost is real, but the
 * air-gap principle constrains RUNTIME NETWORK CALLS, not dependency size — the SDK is vendored at
 * build time like everything else (charter principle 5), and S3 stays OPTIONAL (Postgres is the only
 * required stateful dependency, principle 4). MinIO/S3-compatibles are reached via the `endpoint`
 * override + `forcePathStyle`.
 *
 * CREDENTIALS are resolved from the vault by the caller (ADR-0019 §3 artifact-store class,
 * `deliveryTargetSecretKey`) and passed in — never read from `process.env`/argv/config, never logged.
 */
import { Readable } from "node:stream";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  type ListObjectsV2CommandOutput
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { ResolvedS3Location } from "./delivery-target.js";

/** The write-scoped (out) / read-scoped (in) S3 credential pair, resolved from the vault at use. */
export interface S3DeliveryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * The region an S3-compatible put/list/get signs under. Real AWS S3 needs the bucket's true region;
 * MinIO and most S3-compatibles ignore it but still require a value for SigV4. Operator-overridable
 * via `SCP_DELIVERY_S3_REGION` (default `us-east-1`). This is signing metadata, not an egress target
 * — it never widens which endpoint/bucket is reachable (that is the `SCP_DELIVERY_S3_ENDPOINTS`
 * allowlist's job), so it needs no allowlist.
 */
export function deliveryS3Region(): string {
  return process.env.SCP_DELIVERY_S3_REGION || "us-east-1";
}

/**
 * Build a per-operation `S3Client` for one resolved location. `forcePathStyle: true` so a MinIO/
 * S3-compatible endpoint addresses `<endpoint>/<bucket>/<key>` (virtual-hosted-style would require
 * per-bucket DNS the operator's CDS S3 rarely has). The client is disposable — callers `destroy()`
 * it after the single operation (an unattended loop opens no long-lived connection pool).
 */
function makeS3Client(loc: ResolvedS3Location, creds: S3DeliveryCredentials): S3Client {
  return new S3Client({
    endpoint: loc.endpoint,
    forcePathStyle: true,
    region: deliveryS3Region(),
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey
    }
  });
}

/**
 * PUT a channel artifact via managed multipart (`lib-storage` `Upload`). `body` may be a Buffer,
 * string, or a stream — `Upload` chunks a large body into parts automatically, so a multi-GB relay
 * tarball drops without a hand-rolled PutObject. `partSize` is overridable for tests that force the
 * multipart path with a small threshold; production uses the SDK default (5 MiB minimum part).
 */
export async function s3Put(
  loc: ResolvedS3Location,
  creds: S3DeliveryCredentials,
  key: string,
  body: Buffer | string | Readable,
  opts?: { partSize?: number; queueSize?: number }
): Promise<void> {
  const client = makeS3Client(loc, creds);
  try {
    const upload = new Upload({
      client,
      params: { Bucket: loc.bucket, Key: key, Body: body },
      // Default 5 MiB minimum part / 4-way concurrency; overridable so a test can force >1 part
      // (and thus a real CreateMultipartUpload → UploadPart → CompleteMultipartUpload) cheaply.
      partSize: opts?.partSize,
      queueSize: opts?.queueSize
    });
    await upload.done();
  } finally {
    client.destroy();
  }
}

/**
 * LIST the object BASENAMES under a location's prefix — names only, never full keys or paths, so the
 * §13.1a inbox surface (and its `resolveUnderDir` traversal guard) survives across providers. Keys
 * are paginated fully; each key has the prefix stripped, and any key naming a nested "subdirectory"
 * (a `/` after the prefix) is skipped — the two channel artifacts are always flat objects, exactly
 * as `listInbox`'s filesystem path lists only regular files, never subdirectories.
 */
export async function s3List(
  loc: ResolvedS3Location,
  creds: S3DeliveryCredentials
): Promise<string[]> {
  const client = makeS3Client(loc, creds);
  const names: string[] = [];
  try {
    let continuationToken: string | undefined;
    do {
      const out: ListObjectsV2CommandOutput = await client.send(
        new ListObjectsV2Command({
          Bucket: loc.bucket,
          Prefix: loc.prefix || undefined,
          ContinuationToken: continuationToken
        })
      );
      for (const obj of out.Contents ?? []) {
        const key = obj.Key;
        if (!key) continue;
        if (loc.prefix && !key.startsWith(loc.prefix)) continue;
        const name = loc.prefix ? key.slice(loc.prefix.length) : key;
        // Flat objects only — a name with a residual `/` is a nested key, not a channel artifact.
        if (name === "" || name.includes("/")) continue;
        names.push(name);
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);
  } finally {
    client.destroy();
  }
  return names.sort();
}

/** GET one object's bytes (prefix + basename). The read seam an inbox consumer materializes a
 *  channel artifact through before handing it to the existing import paths. */
export async function s3Get(
  loc: ResolvedS3Location,
  creds: S3DeliveryCredentials,
  key: string
): Promise<Buffer> {
  const client = makeS3Client(loc, creds);
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: loc.bucket, Key: key }));
    const body = out.Body;
    if (!body) return Buffer.alloc(0);
    const stream = body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    client.destroy();
  }
}
