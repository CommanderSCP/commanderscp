import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { and, eq } from "drizzle-orm";
import { changeSourceWebhookSecrets } from "../db/schema.js";
import { getSecretValue } from "../secrets/secrets-repo.js";

/** Per-source-kind webhook signature verification. See docs/coordination.md §1115. */

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

const DEFAULT_VERIFIER: WebhookSignatureVerifier = {
  headerName: "x-scp-signature-256",
  verify: verifyGenericHmacSha256
};

/** Resolves the signature verifier through the registry. See docs/coordination.md §1116. */
export function verifierForSourceKind(sourceKind: string): WebhookSignatureVerifier {
  const adapter = webhookAdapterForSourceKind(sourceKind);
  // An adapter that ships its own signature scheme. See docs/coordination.md §1117.
  if (adapter?.verify && adapter.signatureHeaderName) {
    return { headerName: adapter.signatureHeaderName, verify: adapter.verify };
  }
  return DEFAULT_VERIFIER;
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
