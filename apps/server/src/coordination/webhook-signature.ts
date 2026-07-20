import { createHmac, timingSafeEqual } from "node:crypto";
import { webhookAdapterForSourceKind } from "./webhook-adapters.js";
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

const DEFAULT_VERIFIER: WebhookSignatureVerifier = {
  headerName: "x-scp-signature-256",
  verify: verifyGenericHmacSha256
};

/**
 * Resolves the signature verifier for a source kind through the per-`sourceKind` webhook ADAPTER
 * REGISTRY (`webhook-adapters.ts`, M15.1b) — github (`sha256=<hex>` in `x-hub-signature-256`) and
 * gitea (bare-hex in `x-gitea-signature`) each resolve their OWN provider verifier off their own
 * `GitProviderAdapter`, so this file no longer imports any single provider's verifier directly.
 *
 * A source kind with no provider-specific adapter (e.g. `terraform`, or a generic first-party
 * reporter) falls back to `DEFAULT_VERIFIER` — the generic `sha256=<hex>` scheme in
 * `x-scp-signature-256`. TFC/Atlantis native signature schemes are still NOT specifically
 * implemented (HONEST LIMITATION): an org relying on those configures the generic scheme instead
 * until a source-specific adapter lands as follow-up.
 */
export function verifierForSourceKind(sourceKind: string): WebhookSignatureVerifier {
  const adapter = webhookAdapterForSourceKind(sourceKind);
  // An adapter that ships its own signature scheme (github/gitea/gitlab) resolves it here. A
  // webhook-source adapter that carries NO `verify`/`signatureHeaderName` (harbor — a registry
  // authed by a `Bearer`-PAT `Authorization` header, with no separate signature header, M15.3c)
  // falls back to `DEFAULT_VERIFIER`. This path is only ever reached when a secret IS configured
  // for the source kind; harbor configures none, so it is never exercised for harbor — the fallback
  // is defensive, keeping the type honest rather than asserting a `verify` that isn't there.
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
