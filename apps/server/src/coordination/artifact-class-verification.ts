import {
  ArtifactClassSchema,
  type ArtifactClass,
  type ArtifactClassVerification,
  type ExecutorType
} from "@scp/schemas";

/**
 * D13 (team-pipeline-iac increment 8) — the pure verdict for "did this build produce what its
 * pipeline said it would".
 *
 * WHAT THIS CLOSES. `ArtifactClassVerificationSchema` shipped with the increment 8 contract (#294)
 * and then sat with ZERO consumers repo-wide — no server code, not even a test — while the
 * `buildReport` evidence source it named did not exist on the wire at all: the typed report door
 * carried `artifactDigest` but no artifact class, so a build had no channel to say it produced an
 * RPM. A record describing a check nothing performs is not a check. This module and
 * `ChangeReportRequestSchema.artifactClass` are the two halves of making it real.
 *
 * THE TWO SIDES ARE READ, NEVER INFERRED.
 *   - `declared` is `source_mappings.type` — the routing Type the matched mapping carries
 *     (ADR-0007), which is exactly what `@scp/iac`'s pipeline constructs write when they synthesize
 *     a pipeline of kind `K` (`addSourceMapping({..., type: kind})`). It is the same value
 *     `proposeChange` already receives as the change's `type`, so verification compares against the
 *     declaration the journey is ACTUALLY shaped by, not a second copy of it.
 *   - `observed` is what the build REPORTED. Deriving it instead — from the digest, the repository
 *     name, the source kind — would be provenance-by-inference, the failure class this codebase has
 *     already shipped once (a label named after which branch matched went false the moment that
 *     branch covered a second kind).
 *
 * DELIBERATELY NOT A TRUST BOUNDARY. Both sides originate with the team — the IaC declaration and
 * the CI report — so a reporter that lies in BOTH places is self-consistent and passes. This
 * catches the two DISAGREEING, which is the misconfiguration D13 names. Stated because the E6
 * self-exemption hole on the D23 path was exactly the mistake of reading a subject-supplied value
 * as though it were provenance.
 */
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

/**
 * The operator-facing reason for a refused release. Names BOTH sides and where each was read, so
 * the fix is actionable from the Decision alone — the reader has to know whether to correct the IaC
 * declaration or the CI step, and "artifact class mismatch" alone does not say.
 */
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
