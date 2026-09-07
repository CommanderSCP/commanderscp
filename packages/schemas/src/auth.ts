import { z } from "zod";
import { ProblemSchema } from "./common.js";

/** Local-auth login — DESIGN.md §7. Issues a bearer token; the UI also receives it as a cookie. */
export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  org: z.string()
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// Web UI v1 session discovery. See docs/schemas.md §6.

/** The install-time federation role of this instance. See docs/schemas.md §7. */
export const InstanceRoleSchema = z.enum(["commander", "outpost", "retrans"]);
export type InstanceRole = z.infer<typeof InstanceRoleSchema>;

/** `GET /auth/me` — mirrors `AuthContext` (auth/local-auth.ts) exactly, plus the serving
 *  instance's install-time role (additive, outpost-ui.md §9.2). */
export const CurrentUserSchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  orgName: z.string(),
  username: z.string(),
  subjectObjectId: z.string().uuid(),
  instanceRole: InstanceRoleSchema,
  /** Every role binding this caller holds anywhere in the org. See docs/schemas.md §8. */
  roleBindings: z.array(
    z.object({
      roleId: z.string().uuid(),
      roleName: z.string(),
      scopeObjectId: z.string().uuid(),
      effect: z.enum(["allow", "deny"])
    })
  ),
  /** ⚠️ THE UNION OF PERMISSIONS HELD AT *SOME* SCOPE. See docs/schemas.md §9. */
  permissionsAnywhere: z.array(z.string())
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

/** `GET /auth/config` — public, no auth required. */
export const AuthConfigSchema = z.object({
  localAuthEnabled: z.literal(true),
  oidcEnabled: z.boolean()
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

// -------------------------------------------------------------------------------------------
// Personal Access Tokens (M2 step 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — hashed at rest,
// never returned in plaintext after creation (routes/pats.ts, auth/pat.ts).
// -------------------------------------------------------------------------------------------

export const CreatePatRequestSchema = z.object({
  name: z.string().min(1),
  expiresAt: z.string().datetime().optional()
});
export type CreatePatRequest = z.infer<typeof CreatePatRequestSchema>;

/** Returned ONCE, at creation — `token` is never retrievable again. */
export const CreatePatResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  token: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable()
});
export type CreatePatResponse = z.infer<typeof CreatePatResponseSchema>;

/** Metadata only — never the token, its hash, or its lookup id. */
export const PatSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable()
});
export type Pat = z.infer<typeof PatSchema>;

export const PatListResponseSchema = z.object({
  items: z.array(PatSchema)
});
export type PatListResponse = z.infer<typeof PatListResponseSchema>;

export const PatIdParamSchema = z.object({ id: z.string().uuid() });
export type PatIdParam = z.infer<typeof PatIdParamSchema>;

// -------------------------------------------------------------------------------------------
// OIDC device authorization flow (M2 step 2 Part C) — SCP's own RFC 8628-shaped flow, hosted by
// SCP itself (routes/device-flow.ts, auth/device-flow.ts).
// -------------------------------------------------------------------------------------------

export const DeviceStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresIn: z.number().int(),
  interval: z.number().int()
});
export type DeviceStartResponse = z.infer<typeof DeviceStartResponseSchema>;

export const DeviceApproveRequestSchema = z.object({
  userCode: z.string().min(1)
});
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequestSchema>;

export const DeviceApproveResponseSchema = z.object({
  approved: z.literal(true)
});
export type DeviceApproveResponse = z.infer<typeof DeviceApproveResponseSchema>;

export const DeviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(1)
});
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequestSchema>;

/** RFC 8628 §3.5 error-code vocabulary — the CLI branches on `error`, not `detail` prose. */
export const DeviceFlowErrorCodeSchema = z.enum([
  "authorization_pending",
  "expired_token",
  "access_denied",
  "invalid_grant"
]);
export type DeviceFlowErrorCode = z.infer<typeof DeviceFlowErrorCodeSchema>;

export const DeviceTokenErrorSchema = ProblemSchema.extend({
  error: DeviceFlowErrorCodeSchema
});
export type DeviceTokenError = z.infer<typeof DeviceTokenErrorSchema>;
