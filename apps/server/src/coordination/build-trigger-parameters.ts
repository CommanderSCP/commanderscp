import { categoryOfType, type ExecutorType } from "@scp/schemas";
import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { registryForComponent } from "./component-pipeline.js";

/** WHAT A BUILD-LANE TRIGGER TELLS ITS EXECUTOR.
 *
 *  A build-lane trigger used to carry `targetRef` and nothing else: `parameters` was populated only
 *  from a campaign recipe (`recipeTriggerParameters`, which returns operator-authored values), so an
 *  ordinary promotion reached the executor with no repo, no commit and no destination. That made a
 *  SHIPPED, parameterised build template impossible — the only workable shape was one template per
 *  component with all three hardcoded, which is a catalog in name only.
 *
 *  The TEST lane already does this and says why: it sends the hook's declared `workflow` ref as a
 *  parameter rather than resolving the run itself, because "SCP coordinates, the executor
 *  executes" (`pipeline-hook-runs.ts`). This is the same rule applied to the build lane. Every
 *  value below is something SCP ALREADY HOLDS and is merely passing on — none of it is computed by
 *  inspecting the source, and nothing here builds anything.
 *
 *  ABSENT KEYS ARE OMITTED, never sent empty. A template that needs `sourceCommit` should fail
 *  because the parameter is missing, loudly, rather than receive "" and build whatever HEAD happens
 *  to be — which is the difference between a refused run and a wrong artifact. */
export interface BuildTriggerParameterInput {
  orgId: string;
  /** The component being built. */
  targetObjectId: string;
  /** The routing Type — only a `build` Category gets these parameters. */
  type: ExecutorType;
  /** The change's `sourceRef` bag (`webhook-processor.ts`'s `canonicalizeSourceRef` writes
   *  `repo`/`ref`/`commit` into it). Untyped on purpose: a row replicated from an older peer, or a
   *  change proposed with a hand-supplied `sourceRef`, was never checked against a shape. */
  sourceRef: unknown;
  changeObjectId: string;
}

function readString(bag: unknown, key: string): string | undefined {
  if (!bag || typeof bag !== "object") return undefined;
  const value = (bag as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export async function buildLaneTriggerParameters(
  tx: TenantTx,
  input: BuildTriggerParameterInput
): Promise<Record<string, unknown> | undefined> {
  // Only the BUILD Category. A `configuration` trigger drives a deploy that already knows what it
  // is deploying, and an `infrastructure` one has no artifact at all; sending build parameters
  // there would be noise the executor cannot act on.
  if (categoryOfType(input.type) !== "build") return undefined;

  const params: Record<string, unknown> = { changeObjectId: input.changeObjectId };

  const repo = readString(input.sourceRef, "repo");
  const ref = readString(input.sourceRef, "ref");
  const commit = readString(input.sourceRef, "commit");
  if (repo) params.sourceRepo = repo;
  if (ref) params.sourceRef = ref;
  if (commit) params.sourceCommit = commit;

  // The SAME resolution the pipeline view renders, not a second one. `declared` is the only state
  // that names a destination: `none` has no edge and `ambiguous` has more than one, and picking
  // one of several would be exactly the silent guess the pipeline view refuses to make.
  // WHERE THIS COMPONENT'S DOCKERFILE LIVES, when it says. A monorepo puts each component's
  // Dockerfile under its own directory (`apps/profile-web/Dockerfile`), so the path is a fact
  // ABOUT THE COMPONENT, not a property of the build tooling — carrying it in chart values would
  // force every component in an organization to share one path. Absent ⇒ the catalog template's
  // own default, which is the single-service repo case.
  const [component] = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(and(eq(objects.orgId, input.orgId), eq(objects.id, input.targetObjectId)))
    .limit(1);
  // Untyped for the same reason `sourceRef` is: a replicated row from an older peer was never
  // checked against a shape here.
  const dockerfile = readString(component?.properties, "dockerfile");
  if (dockerfile) params.dockerfile = dockerfile;

  const registry = await registryForComponent(tx, input.orgId, input.targetObjectId);
  if (registry.state === "declared") {
    if (registry.repository) params.imageRepository = registry.repository;
    if (registry.url) params.registryUrl = registry.url;
    if (registry.name) params.registryName = registry.name;
  }

  return Object.keys(params).length > 1 ? params : undefined;
}
