import { z } from "zod";

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
