import { z } from "zod";

/** A sha256, lowercase hex. The only string the controller's input carries: it can only be
 *  COMPARED against bytes the controller holds, never rendered into anything. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Who performed an instance-level act. */
export const InstanceActorSchema = z.object({
  /** `session-role`: a logged-in user holding the instance-operator role. `credential` /
   *  `bootstrap-env-token`: a machine or CLI presenting an operator credential. `install`: the
   *  install-time bootstrap grant. */
  mechanism: z.enum(["session-role", "credential", "bootstrap-env-token", "install"]),
  orgId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  credentialId: z.string().uuid().nullable()
});
export type InstanceActor = z.infer<typeof InstanceActorSchema>;
