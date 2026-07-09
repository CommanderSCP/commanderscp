import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client.js";
import { deviceAuthRequests } from "../db/schema.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { createSession } from "./local-auth.js";

/**
 * SCP's OWN RFC 8628-shaped device-authorization flow (M2 stage 2 Part C, DESIGN.md §7's
 * "OIDC device flow... grafted — headless jump boxes can't do browser redirects") — a decision
 * made deliberately, flagged here as security-sensitive: this is NOT a proxy to the upstream
 * IdP's device grant. It's hosted entirely by SCP, so it works identically whether the org is
 * OIDC-configured or local-auth-only/air-gapped. The `verificationUri` points at SCP's own web
 * UI/API; the human approves there using whatever auth method (local or OIDC) they already have a
 * browser session for (routes/device-flow.ts `approve`, behind `requireAuth`).
 */

const DEVICE_TTL_MS = 10 * 60 * 1000; // 10 min — request itself expires
const POLL_INTERVAL_SECONDS = 5;
// Excludes visually-ambiguous characters (0/O, 1/I) — this code is hand-typed by a human.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]).join(
    ""
  );
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export interface StartedDeviceAuth {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

/** `POST /auth/device/start` — no auth required (this is how an unauthenticated CLI begins). */
export async function startDeviceAuth(db: Db): Promise<StartedDeviceAuth> {
  const deviceCode = generateDeviceCode();
  const expiresAt = new Date(Date.now() + DEVICE_TTL_MS);

  // Collision-retry on the low-entropy, human-typed user_code's unique constraint (device_code is
  // long/random enough that a collision here isn't worth retrying for).
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await db.insert(deviceAuthRequests).values({
        id: uuidv7(),
        deviceCodeHash: hashDeviceCode(deviceCode),
        userCode,
        status: "pending",
        expiresAt
      });
      return {
        deviceCode,
        userCode,
        expiresIn: Math.floor(DEVICE_TTL_MS / 1000),
        interval: POLL_INTERVAL_SECONDS
      };
    } catch (err) {
      if (isUniqueViolation(err, "device_auth_requests_user_code_unique")) continue;
      throw err;
    }
  }
  throw new Error("failed to allocate a unique device user_code after 5 attempts");
}

/**
 * `POST /auth/device/approve` — REQUIRES requireAuth (the already-logged-in human approving from
 * their own browser/UI session). Issues a new session token exactly like local-auth's session
 * creation and parks it in `issuedToken` until the CLI's next poll claims it (single-use, see
 * `pollDeviceAuth`). Returns `false` if no matching PENDING, unexpired request exists — callers
 * should turn that into a 404 without more detail (don't leak which case it was).
 */
export async function approveDeviceAuth(
  db: Db,
  params: { userCode: string; orgId: string; userId: string }
): Promise<boolean> {
  const pending = await db.query.deviceAuthRequests.findFirst({
    where: eq(deviceAuthRequests.userCode, params.userCode)
  });
  if (!pending || pending.status !== "pending" || pending.expiresAt.getTime() < Date.now()) {
    return false;
  }

  const session = await createSession(db, { userId: params.userId, orgId: params.orgId });

  const [updated] = await db
    .update(deviceAuthRequests)
    .set({
      status: "approved",
      orgId: params.orgId,
      issuedToken: session.token,
      issuedTokenExpiresAt: session.expiresAt
    })
    .where(eq(deviceAuthRequests.id, pending.id))
    .returning({ id: deviceAuthRequests.id });

  return !!updated;
}

export type DeviceFlowErrorCode =
  "invalid_grant" | "expired_token" | "authorization_pending" | "access_denied";

export type DeviceTokenResult =
  | { kind: "ok"; token: string; expiresAt: Date; orgId: string }
  | { kind: "error"; error: DeviceFlowErrorCode };

/**
 * `POST /auth/device/token` — no auth required (this IS the auth mechanism); RFC 8628 error-code
 * vocabulary (`authorization_pending`/`expired_token`/`access_denied`/`invalid_grant`) so the CLI
 * can branch predictably (routes/device-flow.ts documents the response shape in a schema).
 *
 * Single-use: an `approved` request is atomically flipped to `claimed` and `issuedToken` is
 * nulled out in the same update, inside one transaction with the read — a second poll after a
 * successful claim always sees `claimed` and gets `invalid_grant`, never a replayed token.
 */
export async function pollDeviceAuth(db: Db, deviceCode: string): Promise<DeviceTokenResult> {
  const deviceCodeHash = hashDeviceCode(deviceCode);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(deviceAuthRequests)
      .where(eq(deviceAuthRequests.deviceCodeHash, deviceCodeHash))
      .for("update");
    const row = rows[0];
    if (!row) return { kind: "error", error: "invalid_grant" };

    if (row.status === "claimed") return { kind: "error", error: "invalid_grant" };

    if (row.expiresAt.getTime() < Date.now()) {
      if (row.status !== "expired") {
        await tx
          .update(deviceAuthRequests)
          .set({ status: "expired" })
          .where(eq(deviceAuthRequests.id, row.id));
      }
      return { kind: "error", error: "expired_token" };
    }

    if (row.status === "pending") return { kind: "error", error: "authorization_pending" };
    if (row.status === "denied") return { kind: "error", error: "access_denied" };

    if (row.status === "approved" && row.issuedToken && row.issuedTokenExpiresAt && row.orgId) {
      const token = row.issuedToken;
      const expiresAt = row.issuedTokenExpiresAt;
      const orgId = row.orgId;
      await tx
        .update(deviceAuthRequests)
        .set({ status: "claimed", issuedToken: null })
        .where(eq(deviceAuthRequests.id, row.id));
      return { kind: "ok", token, expiresAt, orgId };
    }

    return { kind: "error", error: "invalid_grant" };
  });
}
