/**
 * `@scp/iac` — CDK-style TypeScript constructs that synthesize a deterministic desired-state
 * manifest via PURE synth (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15). No API calls, no
 * randomness, no wall-clock reads in `synth()` — works fully offline, so IaC programs can be
 * authored/synthesized in CI or across an air gap and applied later (`scp plan`/`scp apply`,
 * `packages/cli`), exactly like a CDK cloud assembly being `cdk deploy`'d separately from where
 * it was synthesized.
 */
export { App, Stack, ResourceConstruct, Construct } from "./construct.js";
export type { ResourceProps } from "./construct.js";
export {
  Service,
  Component,
  Domain,
  Team,
  DeploymentTarget,
  Group,
  User,
  ServiceAccount,
  Campaign,
  Initiative,
  ReleaseTopology
} from "./construct.js";
export type { ComponentProps, CampaignProps, InitiativeProps, ReleaseTopologyProps, ReleaseTopologyWaveSpec } from "./construct.js";
export { deriveConstructUrn, slugify } from "./urn.js";
export { canonicalJson } from "./canonical.js";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesiredStateManifest } from "@scp/schemas";
import { App, Stack } from "./construct.js";
import { canonicalJson } from "./canonical.js";

function singleStackManifest(target: Stack | App): DesiredStateManifest {
  if (target instanceof Stack) return target.synth();
  const stacks = target.listStacks();
  if (stacks.length !== 1) {
    throw new Error(
      `synthToFile(app, ...) requires an App with exactly one stack (found ${stacks.length}) — ` +
        `pass the specific Stack directly (synthToFile(stack, ...)), or call app.synth() yourself ` +
        `to get every stack's manifest as an array and write them out individually.`
    );
  }
  // Non-null: length check above guarantees index 0 exists.
  return stacks[0]!.synth();
}

/**
 * Writes the canonical JSON manifest to disk — the interchange point between IaC authoring
 * (pure, offline synth) and server-side reconciliation (`scp plan`/`scp apply`, `POST /plans`),
 * exactly like `cdk synth` writing a cloud-assembly directory that `cdk deploy` reads separately.
 * Uses recursively-sorted-key canonical JSON (`canonicalJson`), not plain `JSON.stringify`, so the
 * file's bytes are stable even when caller-supplied `properties`/`labels` objects were built with
 * different key insertion order — the same byte-identical-output guarantee `synth()` itself makes.
 */
export async function synthToFile(target: Stack | App, filePath: string): Promise<void> {
  const manifest = singleStackManifest(target);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, canonicalJson(manifest) + "\n", "utf8");
}
