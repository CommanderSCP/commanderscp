import {
  ArtifactClassSchema,
  type ArtifactClass,
  type ArtifactClassVerification,
  type ExecutorType
} from "@scp/schemas";

/** D13 (team-pipeline-iac increment 8). See docs/coordination.md §7. */
export function verifyArtifactClass(
  declared: ExecutorType,
  observed: ArtifactClass | null | undefined
): ArtifactClassVerification {
  // ABSENT IS `unverified`, NEVER `match`. This is the additive property that lets every existing
  // reporter keep working untouched: a report that carries no class is not asserting agreement, so
  // treating it as a pass would silently convert "we never checked" into "we checked and it was
  // fine" — the precise inversion `unverified` exists to keep visible.
  if (observed === null || observed === undefined) {
    return { declared, observed: null, evidenceSource: null, verdict: "unverified" };
  }
  return {
    declared,
    observed,
    evidenceSource: "buildReport",
    // A non-build declaration (`infrastructure` / `configuration`, the `source_mappings.type`
    // column default) can never equal an `ArtifactClass`, so this comparison ALREADY refuses an
    // infra pipeline that claims to have produced an image — no separate branch, no second
    // mechanism, which is why `declared` is the full `ExecutorType` rather than the narrow class.
    verdict: declared === observed ? "match" : "mismatch"
  };
}

/** The operator-facing reason for a refused release. See docs/coordination.md §8. */
export function artifactClassMismatchReason(v: ArtifactClassVerification): string {
  return (
    `artifact-class mismatch: this pipeline declares \`${v.declared}\` ` +
    `(the matched source mapping's type) but the build reported producing \`${String(v.observed)}\`. ` +
    `The declared class selects the journey template, so proceeding would run a journey shaped for ` +
    `bytes this release does not have. Correct the pipeline declaration or the build's reported class.`
  );
}

/** Parse a reported artifact class off a raw report body. Invalid values yield `undefined` (and are
 *  preserved verbatim on `sourceRef` by the caller for forensics) rather than throwing here — the
 *  ingress is persist-then-process, so shape defects are refused at the propose savepoint with a
 *  Decision, never as an exception that would wedge the tick. */
export function parseReportedArtifactClass(value: unknown): ArtifactClass | undefined {
  const parsed = ArtifactClassSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
