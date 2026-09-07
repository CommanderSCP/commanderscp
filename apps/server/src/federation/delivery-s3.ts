/** 13.2b — the `s3-compatible` DeliveryTarget client. See docs/federation.md §73. */
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

/** The region an S3-compatible put/list/get signs under. See docs/federation.md §74. */
export function deliveryS3Region(): string {
  return process.env.SCP_DELIVERY_S3_REGION || "us-east-1";
}

/** Build a per-operation `S3Client` for one resolved location. See docs/federation.md §75. */
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

/** PUT a channel artifact via managed multipart. See docs/federation.md §76. */
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

/** LIST the object BASENAMES under a location's prefix. See docs/federation.md §77. */
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
