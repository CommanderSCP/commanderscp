import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A plan document in a workspace, and its digest — what an apply must name (ADR-0056 addendum 4:
 *  the plugin refuses an apply whose `planDigest` is not the workspace's `plan.json`). For the
 *  tests that exercise an APPLY's launch, not its gate. */
export const APPROVED_PLAN_JSON = JSON.stringify({
  resource_changes: [{ change: { actions: ["create"] } }]
});
export const APPROVED_PLAN_DIGEST = createHash("sha256").update(APPROVED_PLAN_JSON).digest("hex");

/** Seeds `<workspaceRoot>/<orgId>/<targetRef>/plan.json` (the plugin's own derivation, for plain ids). */
export async function seedApprovedPlan(
  workspaceRoot: string,
  orgId = "org-1",
  targetRef = "t1"
): Promise<string> {
  const dir = join(workspaceRoot, orgId, targetRef);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plan.json"), APPROVED_PLAN_JSON, "utf8");
  return APPROVED_PLAN_DIGEST;
}

/** The digest of whatever plan a REAL plan run left in a workspace dir. */
export async function planDigestIn(workspaceDir: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(join(workspaceDir, "plan.json"), "utf8"))
    .digest("hex");
}
