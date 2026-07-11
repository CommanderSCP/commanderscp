import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyGithubWebhookSignature } from "@scp/plugin-github";
import type { TenantTx } from "../db/tenant-tx.js";
import { and, eq } from "drizzle-orm";
import { changeSourceWebhookSecrets } from "../db/schema.js";
import { getSecretValue } from "../secrets/secrets-repo.js";

/**
 * Per-source-kind webhook signature verification (BUILD_AND_TEST.md §8 M7 DoD: "webhook SIGNATURE
 * verification (reject bad HMAC)... for every webhook source"; SECURITY-SENSITIVE list: "a bad/
 * missing HMAC signature is rejected, never processed — for every webhook source"). Closes the gap
 * `routes/change-sources.ts`'s M3 doc comment explicitly flagged: "M3 ships no per-source-kind
 * secret storage/configuration surface to verify against (that arrives with the real executor
 * plugins in M7)".
 *
 * Verification always runs against the RAW request body bytes (`request.rawBody`, app.ts's custom
 * content-type parser) — never a re-serialized `JSON.stringify(request.body)`, which is not
 * guaranteed byte-identical to what the sender actually signed (whitespace, key order).
 */

export interface WebhookSignatureVerifier {
  /** The header this source kind carries its signature in. */
  headerName: string;
  verify(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean;
}

/** `sha256=<hex hmac>` over the raw body — the same scheme GitHub uses (and the de facto standard
 *  a number of other webhook senders, including generic/custom integrations, also emit) — used as
 *  the fallback for any source kind without its own dedicated verifier below. Constant-time
 *  compare via `timingSafeEqual`, same fail-closed posture as `@scp/plugin-github`'s own verifier. */
function verifyGenericHmacSha256(
  rawBody: Buffer,
  headerValue: string | undefined,
  secret: string
): boolean {
  if (!headerValue?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = headerValue.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

const VERIFIERS: Record<string, WebhookSignatureVerifier> = {
  github: { headerName: "x-hub-signature-256", verify: verifyGithubWebhookSignature }
  // TFC/Atlantis native signature schemes (X-TFE-Notification-Signature, Atlantis's own webhook
  // secret header) are NOT specifically implemented here — HONEST LIMITATION, flagged in the PR
  // body: an org relying on Mode 1's TFC/Atlantis webhooks configures the GENERIC sha256=<hex>
  // scheme below instead (most webhook-relay setups, and `scp change report`'s own CLI-side
  // signing, already speak it) until a source-specific verifier lands as follow-up work.
};

const DEFAULT_VERIFIER: WebhookSignatureVerifier = {
  headerName: "x-scp-signature-256",
  verify: verifyGenericHmacSha256
};

export function verifierForSourceKind(sourceKind: string): WebhookSignatureVerifier {
  return VERIFIERS[sourceKind] ?? DEFAULT_VERIFIER;
}

/** Looks up which `secrets` key (if any) holds this org+sourceKind's webhook signing secret
 *  (`change_source_webhook_secrets`) and resolves its plaintext value. `undefined` means "no
 *  signing secret configured for this org+sourceKind" — the caller's fallback is the pre-M7
 *  PAT-only path (`routes/change-sources.ts`'s module doc), never a silent "treat as verified". */
export async function resolveWebhookSecret(
  tx: TenantTx,
  orgId: string,
  sourceKind: string,
  masterKey: Buffer
): Promise<string | undefined> {
  const rows = await tx
    .select()
    .from(changeSourceWebhookSecrets)
    .where(
      and(
        eq(changeSourceWebhookSecrets.orgId, orgId),
        eq(changeSourceWebhookSecrets.sourceKind, sourceKind)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return getSecretValue(tx, orgId, row.secretKey, masterKey);
}
