import { z } from "zod";
import type { DependencyEcosystem } from "./dependencies.js";
import {
  ScanDbSourceSchema,
  ScanDbStalenessClassSchema,
  ScanDbThresholdFiredSchema
} from "./scan-db.js";

/**
 * Supply-chain governance evidence (DESIGN §10, ADR-0013 "scan as a boundary-authorization gate",
 * BUILD_AND_TEST.md §8 M17). This file carries the TYPED shape of a `ControlOutcome.evidence`
 * payload for a coordinated Trivy scan verdict — the M17.1 `scan-result-control` ControlPlugin
 * produces it, and it is persisted verbatim on the `control_runs.evidence` column (free-form
 * `z.record` at the storage layer — `ControlRunSchema` in governance.ts).
 *
 * Why a typed schema for something the DB stores as free-form JSON: today a control's evidence is
 * an opaque bag, so a policy's CEL condition has no typed field to threshold on. Pinning the scan
 * verdict's shape here gives policy authors stable, documented fields — `evidence.severityCounts.critical`,
 * `evidence.artifactDigest`, `evidence.digestMatch` — to write conditions against, and gives the
 * plugin a single source of truth it validates its own output against (scan-result-control parses
 * its evidence through `ScanEvidenceSchema` before returning it, so a shape regression fails the
 * plugin's own tests rather than silently shipping malformed evidence into a Decision).
 *
 * CHARTER — coordinate, not execute: the SCP *gate* never runs Trivy; the charter-enumerated
 * `scp-managed-scan` runner does, as the promotion scan step (ADR-0020). This evidence is the
 * shape of a verdict the gate *consumes* — either from an org's own coordinated Trivy step (Argo
 * Workflows, ADR-0012) or from the commander-resident `scp-managed-scan` promotion scan step
 * (ADR-0020) — `scanner`/`scannerVersion` record WHICH scanner produced it, they are not a claim
 * the gate scanned anything itself.
 */

/** Per-severity vulnerability counts distilled from a Trivy result's `Results[].Vulnerabilities[]`
 *  (Trivy severities: CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN — `unknown` folded away; only the four the
 *  threshold model acts on are surfaced). */
export const ScanSeverityCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  high: z.number().int().nonnegative(),
  medium: z.number().int().nonnegative(),
  low: z.number().int().nonnegative()
});
export type ScanSeverityCounts = z.infer<typeof ScanSeverityCountsSchema>;

/** The four severities the threshold model acts on. Trivy also emits `UNKNOWN`, which is folded
 *  away — see `parseTrivyFindings`. */
const COUNTED_SEVERITIES = ["critical", "high", "medium", "low"] as const;

/**
 * M22.1 (ADR-0033) — ONE Trivy finding, retained.
 *
 * Until now a scan verdict was four integers: both parsers walked `Results[].Vulnerabilities[]`,
 * read `.Severity`, incremented a counter, and discarded the vulnerability object; the raw document
 * was then deleted. Every rule in ADR-0033 is a rule ABOUT A FINDING — "this package is at the
 * vendor's latest", "this one has no fix", "this component declared the finding inapplicable" — and
 * none of them can be expressed against four integers. This type is what survives so they can be.
 *
 * WHY NEARLY EVERY FIELD IS OPTIONAL, and why that is not laziness. Today an entry is counted on
 * the strength of its `Severity` ALONE — nothing else is read, so an entry with no
 * `VulnerabilityID`, no `PkgName` or no versions is still counted. Requiring those fields here
 * would silently drop such entries and MOVE THE NUMBERS OPERATORS ALREADY SEE, which the M22.1
 * definition of done forbids. So a finding is retained whenever it would have been counted, and a
 * finding that lacks an identifier is simply one that no exclusion clause can ever match — the safe
 * direction, since an unmatchable finding still counts against the ceiling.
 */
export const ScanFindingSchema = z.object({
  /** Trivy `VulnerabilityID` (e.g. `CVE-2026-1234`). */
  vulnerabilityId: z.string().optional(),
  /** Trivy `PkgName`. */
  pkgName: z.string().optional(),
  installedVersion: z.string().optional(),
  /** Trivy `FixedVersion`. ABSENT means upstream has shipped no fix — the "no fix available"
   *  exclusion class reads exactly this, and reads absence as the signal rather than inferring it. */
  fixedVersion: z.string().optional(),
  /** Trivy `Results[].Class` — `os-pkgs` distinguishes an OS package (attributable to the BASE
   *  IMAGE line) from `lang-pkgs` (attributable to a declared manifest dependency, or transitive
   *  and attributable to nothing). This single field is what makes the vendor rule expressible
   *  without an inventory join. */
  class: z.string().optional(),
  /** Trivy `Results[].Target` — which artifact layer/file the finding came from. */
  target: z.string().optional(),
  severity: z.enum(COUNTED_SEVERITIES),
  /** `PkgIdentifier.PURL` VERBATIM, never normalized here. The dependency inventory stores its
   *  coordinate deliberately un-normalized too, so any canonicalization belongs at the join, once,
   *  where both sides are visible — not smeared across two parsers. */
  purl: z.string().optional()
});
export type ScanFinding = z.infer<typeof ScanFindingSchema>;

/**
 * THE SHARED TRIVY PARSE — the single source of truth for both verdict producers.
 *
 * This lives here rather than being duplicated because an earlier draft of ADR-0033 asserted that
 * "a plugin cannot import `@scp/schemas`" and designed a duplicated parser with a cross-boundary
 * conformance test to keep the copies honest. That premise was FALSE:
 * `@scp/plugin-scan-result-control` already declares `@scp/schemas` as a dependency and already
 * imports values from it. Two hand-synced parse loops with identical semantics is precisely the
 * shape where a fix lands in one and the paths diverge silently, so the copies are now one function.
 *
 * TOTAL AND DEFENSIVE, exactly as both originals were: a malformed or partial document yields an
 * empty array (and therefore zero counts) rather than throwing. The runner already fails the run for
 * a broken scan, so this path normally sees a real result.
 *
 * PER-ENTRY, NOT PER-CVE. One finding per `Vulnerabilities[]` element, with no de-duplication — the
 * same CVE affecting three packages counts three times, because that is what both parsers did
 * before this. De-duplicating would be defensible and is NOT done here: it would change every
 * operator's numbers on the day this ships.
 *
 * `UNKNOWN` (and any unrecognized severity) is dropped, unchanged from both originals.
 */
export function parseTrivyFindings(raw: unknown): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const results = (raw as { Results?: unknown } | null | undefined)?.Results;
  if (!Array.isArray(results)) return findings;
  for (const result of results) {
    const row = result as { Vulnerabilities?: unknown; Class?: unknown; Target?: unknown };
    const vulns = row.Vulnerabilities;
    if (!Array.isArray(vulns)) continue;
    const cls = typeof row.Class === "string" ? row.Class : undefined;
    const target = typeof row.Target === "string" ? row.Target : undefined;
    for (const v of vulns) {
      const entry = v as {
        Severity?: unknown;
        VulnerabilityID?: unknown;
        PkgName?: unknown;
        InstalledVersion?: unknown;
        FixedVersion?: unknown;
        PkgIdentifier?: { PURL?: unknown };
      };
      if (typeof entry.Severity !== "string") continue;
      const severity = entry.Severity.toLowerCase();
      if (!(COUNTED_SEVERITIES as readonly string[]).includes(severity)) continue;
      const str = (value: unknown): string | undefined =>
        typeof value === "string" && value.length > 0 ? value : undefined;
      findings.push({
        severity: severity as (typeof COUNTED_SEVERITIES)[number],
        ...(str(entry.VulnerabilityID) ? { vulnerabilityId: str(entry.VulnerabilityID)! } : {}),
        ...(str(entry.PkgName) ? { pkgName: str(entry.PkgName)! } : {}),
        ...(str(entry.InstalledVersion) ? { installedVersion: str(entry.InstalledVersion)! } : {}),
        ...(str(entry.FixedVersion) ? { fixedVersion: str(entry.FixedVersion)! } : {}),
        ...(cls ? { class: cls } : {}),
        ...(target ? { target } : {}),
        ...(str(entry.PkgIdentifier?.PURL) ? { purl: str(entry.PkgIdentifier?.PURL)! } : {})
      });
    }
  }
  return findings;
}

/** `severityCounts` DERIVED from the retained findings, so the two can never disagree. Because
 *  `parseTrivyFindings` retains exactly the entries the old loops counted, this is numerically
 *  identical to what both parsers produced before M22.1 — that equivalence is the property the
 *  M22.1 suite pins, and it is why `severityCounts` can keep meaning "what the scanner found" while
 *  a separate post-exclusion count is introduced beside it. */
export function severityCountsFromFindings(findings: readonly ScanFinding[]): ScanSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// ===========================================================================================
// M22.1b (ADR-0033 §7) — PERSISTING the findings: the cap, the record marker, and the transport
// seam between a plugin that cannot reach the database and the server that can.
// ===========================================================================================

/**
 * The maximum number of findings persisted per scan (ADR-0033 §7).
 *
 * `scan_findings` is the highest-cardinality table in the system and one scan of a stale base image
 * routinely yields thousands of entries. A cap is NOT a retention story (ADR-0024 §D0: retention
 * never licenses write amplification); it is the bound on a single scan's write.
 *
 * The cap keeps the FIRST N findings in parse order — deterministic, and not a severity-priority
 * selection. Nothing is lost by that choice, because a TRUNCATED set refuses EVERY exclusion for
 * that scan (ADR-0033 §7: "you cannot except what you did not record"), so the retained subset is
 * only ever an explanation, never an input to a verdict.
 *
 * `severityCounts` is derived BEFORE the cap and is therefore unaffected: capping what is persisted
 * never moves what the scanner found.
 */
export const SCAN_FINDINGS_PERSIST_CAP = 2000;

export interface CappedScanFindings {
  findings: ScanFinding[];
  /** True iff the producer saw MORE findings than were retained. */
  truncated: boolean;
}

export function capScanFindings(
  findings: readonly ScanFinding[],
  cap: number = SCAN_FINDINGS_PERSIST_CAP
): CappedScanFindings {
  if (findings.length <= cap) return { findings: [...findings], truncated: false };
  return { findings: findings.slice(0, cap), truncated: true };
}

/**
 * WHAT A SCAN'S PERSISTED FINDING SET IS — stated positively in evidence, never inferred from the
 * absence of rows.
 *
 * ADR-0033's consequences list is explicit that "OpenSCAP verdicts can never be excluded from" must
 * be "explicit and tested, not left to 'there were no findings to exclude'". The two are genuinely
 * different states and a reader with only the rows cannot tell them apart:
 *
 *   `full`        — every finding the scanner reported is on disk. Exclusions may apply.
 *   `truncated`   — the set hit `SCAN_FINDINGS_PERSIST_CAP`. EVERY exclusion for this scan is
 *                   refused (ADR-0033 §7).
 *   `unsupported` — this scanner family structurally cannot carry findings (OpenSCAP: XCCDF
 *                   rule-results have no package, no purl, no `FixedVersion` and no `Class`).
 *                   Exclusions can never apply — not because none matched, but because there is no
 *                   per-finding material to match on.
 *
 * ABSENT is a fourth state and it is the one that matters most for safety: evidence written before
 * M22.1b recorded no findings at all, so a consumer that reads no marker must refuse exclusions
 * exactly as it does for `truncated`. Every state except `full` refuses.
 */
export const ScanFindingsRecordSchema = z.enum(["full", "truncated", "unsupported"]);
export type ScanFindingsRecord = z.infer<typeof ScanFindingsRecordSchema>;

/**
 * Whether a scan METHOD can carry per-finding detail at all.
 *
 * Deliberately an EXHAUSTIVE switch over `ScanMethod` rather than `method !== "openscap"`: a fourth
 * method added later is then a compile error here, forcing a decision, instead of silently
 * inheriting "yes, it has findings" — which for a rule-based scanner would be a fail-open (an
 * exclusion applied against a finding set that was never populated).
 *
 * It is also NOT `usesTrivyDb`, though the two agree today. That predicate answers "does this method
 * read the Trivy vulnerability DB?" (a staleness-gate question); this one answers "does a verdict of
 * this method decompose into findings?". Sharing one helper between two questions is how the answer
 * to one silently becomes the answer to the other.
 */
export function scanMethodCarriesFindings(method: ScanMethod): boolean {
  switch (method) {
    case "trivy":
    case "trivy-vm":
      return true;
    case "openscap":
      return false;
  }
}

/**
 * THE ONE DECISION about what a scan's finding set is — used by BOTH the evidence marker and the
 * row writer, so the two can never disagree about the same scan.
 *
 * `undefined` means NOTHING WAS RECORDED (the producer transported no findings at all). It is a
 * real, distinct state and it is written as an ABSENT `evidence.findingsRecord`, matching every
 * pre-M22.1b document — and like every state but `full`, it refuses exclusions.
 *
 * The `unsupported` arm is deliberately decided BEFORE the payload is looked at. A caller that
 * handed OpenSCAP findings (there is no such thing, but a future runner shim could) gets them
 * refused because of WHAT SCANNED, never because the array happened to be empty — which is exactly
 * the distinction ADR-0033's consequences list requires be explicit and tested.
 */
export function scanFindingsRecordFor(
  method: ScanMethod,
  capped: CappedScanFindings | undefined
): ScanFindingsRecord | undefined {
  if (!scanMethodCarriesFindings(method)) return "unsupported";
  if (capped === undefined) return undefined;
  return capped.truncated ? "truncated" : "full";
}

/**
 * The ADR-0024 §D1 evidentiary class of ONE persisted finding row (D10).
 *
 * `scan_findings` does not have a single class, and that is the whole point of assigning it per row:
 *
 *   `E` — an EXCLUDED finding is accepted-risk evidence. It explains a LIVE verdict and records what
 *         an operator chose to tolerate, so it is retained at least as long as its subject is live.
 *   `O` — an ordinary finding is telemetry: bookkeeping about what a scanner saw, on a short window.
 *
 * This follows ADR-0024 §D1's EXISTING per-row assignment (`decisions` already splits across all
 * three classes — P when cited or pinned, E while current for its subject, O when uncited and
 * superseded) rather than introducing a new retention shape.
 *
 * `P` is deliberately not in this enum: no finding is permanent evidence. The permanent record of a
 * gate verdict is the Decision and the audit event, both of which cite it.
 */
export const ScanFindingRetentionClassSchema = z.enum(["E", "O"]);
export type ScanFindingRetentionClass = z.infer<typeof ScanFindingRetentionClassSchema>;

/**
 * The class a finding row is written with. M22.2 landed the exclusion dimension, so the `E` arm is
 * now REACHED in production: a finding an admitted clause excluded is accepted-risk evidence
 * explaining a live verdict, and is written `E` in the same transaction as the verdict itself.
 * Every other row stays `O` — telemetry about what a scanner saw.
 */
export function scanFindingRetentionClass(excluded: boolean): ScanFindingRetentionClass {
  return excluded ? "E" : "O";
}

/**
 * THE PLUGIN → SERVER TRANSPORT SEAM, and why the key is not a field on `ScanEvidenceSchema`.
 *
 * A ControlPlugin runs in the subprocess plugin host with NO `DATABASE_URL` — it cannot write
 * `scan_findings` itself. Its ONLY channel back to the server is `ControlOutcome.evidence`, a
 * free-form record. So the findings ride out on that record and the SERVER persists them.
 *
 * They must NOT stay there. `control_runs.evidence` is copied VERBATIM into the promotion bundle
 * (`federation/promotion-repo.ts` projects `{controlUrn, status, evidence, detail}` for every run),
 * and ADR-0033 keeps findings COMMANDER-LOCAL — the bundle keeps counts. Leaving them on the
 * evidence would both bloat every bundle and federate accepted-risk detail that §8 confines to
 * grants.
 *
 * Hence a `$`-prefixed transport key that `takeScanFindingsFromTransport` REMOVES as it reads. The
 * extract and the strip are ONE function on purpose: a caller cannot obtain the findings and then
 * forget to strip them, because the only way to get them hands back an already-stripped evidence
 * object.
 */
export const SCAN_FINDINGS_TRANSPORT_KEY = "$scanFindings";
export const SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY = "$scanFindingsTruncated";
/** M22.2 — which of the transported findings the plugin EXCLUDED, by position. It rides the same
 *  seam and for the same reason: the plugin decided the exclusion (it has the findings and the
 *  gate-resolved clauses on its context) but only the server can write the row's ADR-0024 retention
 *  class, and an excluded finding is accepted-risk evidence (class `E`) rather than telemetry. */
export const SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY = "$scanFindingsExcluded";

/** Attach a producer's capped findings to an outcome's evidence for the trip across the plugin-host
 *  RPC. Called AFTER `ScanEvidenceSchema.parse`, because that parse strips unknown keys. */
export function attachScanFindingsForTransport(
  evidence: Record<string, unknown>,
  capped: CappedScanFindings,
  excludedOrdinals: readonly number[] = []
): Record<string, unknown> {
  return {
    ...evidence,
    [SCAN_FINDINGS_TRANSPORT_KEY]: capped.findings,
    [SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY]: capped.truncated,
    ...(excludedOrdinals.length > 0
      ? { [SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY]: [...excludedOrdinals] }
      : {})
  };
}

/**
 * Read a plugin's transported findings OUT of an evidence record, returning the evidence WITHOUT
 * the transport keys.
 *
 * RE-VALIDATES AND RE-CAPS SERVER-SIDE. The producing plugin is a separate process; a buggy or
 * tampered one must not be able to steer what lands in the database, so the payload is parsed
 * through `ScanFindingSchema` and re-capped here rather than trusted. A malformed payload yields
 * `undefined` (no findings recorded) — the safe direction, since every state but `full` refuses
 * exclusions.
 */
export function takeScanFindingsFromTransport(evidence: Record<string, unknown>): {
  evidence: Record<string, unknown>;
  capped: CappedScanFindings | undefined;
  /** M22.2 — positions within the (re-capped) finding set the producer excluded. Re-validated
   *  server-side against the array that actually landed: an ordinal past its end is dropped rather
   *  than trusted, exactly as the findings themselves are re-parsed and re-capped. */
  excludedOrdinals: number[];
} {
  const hasKey = SCAN_FINDINGS_TRANSPORT_KEY in evidence;
  const rawTruncated = evidence[SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY];
  const rawExcluded = evidence[SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY];
  const rest = { ...evidence };
  delete rest[SCAN_FINDINGS_TRANSPORT_KEY];
  delete rest[SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY];
  delete rest[SCAN_FINDINGS_EXCLUDED_TRANSPORT_KEY];
  if (!hasKey) return { evidence: rest, capped: undefined, excludedOrdinals: [] };
  const parsed = z.array(ScanFindingSchema).safeParse(evidence[SCAN_FINDINGS_TRANSPORT_KEY]);
  if (!parsed.success) return { evidence: rest, capped: undefined, excludedOrdinals: [] };
  const capped = capScanFindings(parsed.data);
  const excluded = z.array(z.number().int().nonnegative()).safeParse(rawExcluded);
  const excludedOrdinals = excluded.success
    ? [...new Set(excluded.data.filter((o) => o < capped.findings.length))].sort((a, b) => a - b)
    : [];
  return {
    evidence: rest,
    capped: { findings: capped.findings, truncated: capped.truncated || rawTruncated === true },
    excludedOrdinals
  };
}

/** The severity threshold a `scan-result-control` binding applied to reach its verdict — echoed
 *  into evidence so a Decision reconstructs exactly WHICH gate policy authorized (or blocked) the
 *  artifact, not just the raw counts. `maxCritical`/`maxHigh` default to 0 (any is a fail);
 *  `maxMedium`/`maxLow` omitted mean "not thresholded" (unbounded). */
export const ScanThresholdSchema = z.object({
  maxCritical: z.number().int().nonnegative(),
  maxHigh: z.number().int().nonnegative(),
  maxMedium: z.number().int().nonnegative().optional(),
  maxLow: z.number().int().nonnegative().optional()
});
export type ScanThreshold = z.infer<typeof ScanThresholdSchema>;

/**
 * The managed-scan METHODS the commander's promotion scan step can run (ADR-0020 §2, proposal §13.3).
 * A closed enum, extended only by a deliberate owner decision (a new scanner plugin lands as a new
 * value here + a new runner-image tool). This is the value set the scanner-assignment registry maps
 * artifact types onto (`ScannerAssignmentSchema` in executors.ts) and the value set `ScanEvidence.scanner`
 * is widened to below — so evidence is self-describing about WHICH method produced it. M13 ships
 * `trivy` first, `openscap` second (proposal §13.3 "Increment order"); both are enumerated up front so
 * the registry and evidence shapes are stable across the two 13.3a increments.
 *
 * `trivy-vm` — THE MACHINE-IMAGE ARM (13.3a, owner decision D2: "image-only for M13, where image
 * INCLUDES machine images"). A DISTINCT method rather than a mode of `trivy`, for two reasons that
 * are both load-bearing:
 *   1. **The registry can express it.** Scanner assignment is per `ExecutorType` (machine images ride
 *      `infrastructure`), and `infrastructure -> ["trivy-vm"]` is a statement the registry can make;
 *      "run `trivy`, but in vm mode, when the subject happens to be a disk" is not — it would force
 *      the runner to SNIFF the subject and silently pick a scan mode, which is exactly the kind of
 *      guess a fail-closed gate must not make.
 *   2. **The evidence stays honest.** `scanner: "trivy-vm"` is the claim "this artifact was scanned
 *      as a VM disk image (partition table → filesystem → OS package DB)", which is a materially
 *      different assertion from "scanned as a container image layer stack" — same binary, same
 *      vulnerability DB, different subject model. A reader of a Decision can tell them apart.
 * The widening is ADDITIVE and GATE-INVISIBLE, exactly as `openscap`'s was: E6 reads only
 * `digestMatch`/`artifactDigest`, never `scanner`, so every pre-existing evidence document still
 * parses and no gate code changes.
 */
export const ScanMethodSchema = z.enum(["trivy", "openscap", "trivy-vm"]);
export type ScanMethod = z.infer<typeof ScanMethodSchema>;

/**
 * The subset of `ScanMethod`s that read the **Trivy vulnerability DB** — so every DB-dependent
 * concern (the M13.3b-ii offline pre-load seam, the staleness gate, the `scanDb*` evidence fields)
 * applies to ALL of them and never to `openscap` (which evaluates baked SSG content instead).
 *
 * This predicate exists because the alternative — a `method === "trivy"` comparison at each site —
 * is precisely how a second Trivy-family method silently escapes the staleness gate: a `trivy-vm`
 * scan would then run against an unclassified (possibly hard-stale) DB and still emit passing
 * evidence. One named predicate, every call site.
 */
export function usesTrivyDb(method: ScanMethod): boolean {
  return method === "trivy" || method === "trivy-vm";
}

// ===========================================================================================
// M17.5 — SCOPED SCAN-REQUIREMENT POLICIES (ADR-0016), most-restrictive-wins over six tiers.
//
//   platform -> trust domain (partition) -> org -> containment domain -> service -> component
//
// The effective threshold is the per-severity MIN of `maxCritical`/`maxHigh`/`maxMedium`/`maxLow`
// across every APPLICABLE tier: a child may only TIGHTEN, never loosen. MIN over a set is
// commutative and associative, so resolution is ORDER-INDEPENDENT by construction — which is
// exactly why the documented containment-domain-vs-service ordering tie
// (`graph/containment.ts:60-73`) is harmless here and why most-restrictive-wins was the safe
// choice rather than "most specific wins" override semantics (ADR-0016 §4).
//
// TWO SENSES OF "DOMAIN", never conflated (ADR-0016 terminology section): `trust_domain` is the
// ambient federation boundary (a partition) ABOVE org; `containment_domain` is the intra-org
// `domain` OBJECT TYPE BELOW org. The stored/emitted literal is `trust_domain` — never bare
// `domain`.
// ===========================================================================================

/** The tiers a scan-requirement floor can be authored at, top-down.
 *
 *  `assembly` was ADDED 2026-08-17 (M22.0, ADR-0033 §5). It is the OPTIONAL rung between a service
 *  and its components (migration 0055, `CONTAINER_TYPES`), and it shipped AFTER ADR-0016 wrote this
 *  enum — so an assembly-anchored ceiling has always ENFORCED correctly (the merge is an
 *  order-independent per-severity MIN that never reads a tier label) while REPORTING itself as
 *  `component`, breaking ADR-0016 §5's promise that a block can name the tier that bound it. This is
 *  a LABEL fix, not an enforcement change: no threshold moves.
 *
 *  This is a WIRE enum. Adding a member changes the generated SDK and the OpenAPI response schema. */
export const ScanRequirementTierSchema = z.enum([
  "platform",
  "trust_domain",
  "org",
  "containment_domain",
  "service",
  "assembly",
  "component"
]);
export type ScanRequirementTier = z.infer<typeof ScanRequirementTierSchema>;

/** Where an above-org floor row came from: authored locally by this deployment's operator, or
 *  arrived over federation from the commander (DESIGN §13 — "the commander is the source of truth
 *  for global config; outposts hold it read-only"). */
export const ScanFloorOriginSchema = z.enum(["local", "federated"]);
export type ScanFloorOrigin = z.infer<typeof ScanFloorOriginSchema>;

/**
 * A PARTIAL threshold — every severity independently optional. An absent severity means this tier
 * SETS NO CEILING for it and therefore does NOT contribute to the MIN: "no floor" is never read as
 * `0` (which would be the tightest possible ceiling and would silently block everything).
 */
export const PartialScanThresholdSchema = z.object({
  maxCritical: z.number().int().nonnegative().optional(),
  maxHigh: z.number().int().nonnegative().optional(),
  maxMedium: z.number().int().nonnegative().optional(),
  maxLow: z.number().int().nonnegative().optional()
});
export type PartialScanThreshold = z.infer<typeof PartialScanThresholdSchema>;

/** One tier's contribution to the merged floor — carried into the scan evidence so a Decision can
 *  answer "WHICH tier set the ceiling that blocked me?" (charter principle 6). */
export const ScanThresholdContributionSchema = z.object({
  tier: ScanRequirementTierSchema,
  /** Human-legible origin of this contribution: `instance:platform:local`,
   *  `policy:<name>@<objectId>`, … */
  source: z.string(),
  /** For org-and-below contributions, the `object_types.id` of the graph object the contributing
   *  policy matched at — recorded verbatim so the tier mapping is auditable rather than implicit. */
  objectTypeId: z.string().optional(),
  threshold: PartialScanThresholdSchema
});
export type ScanThresholdContribution = z.infer<typeof ScanThresholdContributionSchema>;

/**
 * The gate-resolved effective threshold, threaded to `scan-result-control` on the control-run
 * CONTEXT (`context.scanThreshold`) — reusing the shipped M17.1 `context.artifactDigest` threading
 * pattern (ADR-0016 §4 design A, gate-orchestrator.ts `buildControlContext`).
 */
export const EffectiveScanThresholdSchema = z.object({
  threshold: PartialScanThresholdSchema,
  contributors: z.array(ScanThresholdContributionSchema)
});
export type EffectiveScanThreshold = z.infer<typeof EffectiveScanThresholdSchema>;

/** Which of the two ceiling sources supplied the value ACTUALLY applied for one severity. */
export const ScanThresholdSourceSchema = z.enum(["config", "scoped", "default"]);
export type ScanThresholdSource = z.infer<typeof ScanThresholdSourceSchema>;

/** Per-severity provenance of the applied threshold. Only severities the applied threshold actually
 *  carries appear (`maxMedium`/`maxLow` are omitted when unbounded). */
export const ScanThresholdSourceMapSchema = z.object({
  maxCritical: ScanThresholdSourceSchema,
  maxHigh: ScanThresholdSourceSchema,
  maxMedium: ScanThresholdSourceSchema.optional(),
  maxLow: ScanThresholdSourceSchema.optional()
});
export type ScanThresholdSourceMap = z.infer<typeof ScanThresholdSourceMapSchema>;

/** One instance-scoped (above-org) floor row — the API projection of `scan_requirement_floors`
 *  (no `orgId`: it applies to EVERY org on the deployment). */
export const InstanceScanFloorSchema = z.object({
  tier: z.enum(["platform", "trust_domain"]),
  origin: ScanFloorOriginSchema,
  maxCritical: z.number().int().nonnegative().nullable(),
  maxHigh: z.number().int().nonnegative().nullable(),
  maxMedium: z.number().int().nonnegative().nullable(),
  maxLow: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  updatedAt: z.string()
});
export type InstanceScanFloor = z.infer<typeof InstanceScanFloorSchema>;

export const InstanceScanFloorListResponseSchema = z.object({
  items: z.array(InstanceScanFloorSchema)
});
export type InstanceScanFloorListResponse = z.infer<typeof InstanceScanFloorListResponseSchema>;

export const InstanceScanFloorTierParamSchema = z.object({
  tier: z.enum(["platform", "trust_domain"])
});

/** Operator-authored write body. Severities are `null`-able so an operator can explicitly CLEAR a
 *  ceiling (making that severity stop contributing) without deleting the row. */
export const PutInstanceScanFloorRequestSchema = z.object({
  origin: ScanFloorOriginSchema.default("local"),
  maxCritical: z.number().int().nonnegative().nullish(),
  maxHigh: z.number().int().nonnegative().nullish(),
  maxMedium: z.number().int().nonnegative().nullish(),
  maxLow: z.number().int().nonnegative().nullish(),
  note: z.string().max(500).nullish()
});
export type PutInstanceScanFloorRequest = z.infer<typeof PutInstanceScanFloorRequestSchema>;

// ===========================================================================================
// M22.2 (ADR-0033 §1–§4) — THE EXCLUSION DIMENSION: what is COUNTED, resolved separately from
// what the count is compared against.
//
// ADR-0016's ceiling is a per-severity MIN over an unordered set: commutative, associative, and
// a child may only ever TIGHTEN. That algebra is untouched here. This is the OPPOSITE direction
// and therefore gets the OPPOSITE guard — a monotone AND down the tier chain, so a loosening at
// any depth requires admission from every tier above it. The two dimensions never meet:
// exclusions change WHAT IS COUNTED, the ceiling changes WHAT THE COUNT IS COMPARED AGAINST.
//
// THE INVARIANT THAT OUTRANKS EVERY CONVENIENCE HERE: `severityCounts` keeps meaning WHAT THE
// SCANNER FOUND. Operators author CEL conditions against `evidence.severityCounts.*`, so
// redefining that field post-exclusion would silently change the meaning of every rule already
// written — a compatibility promise to policy authors, not to a linter (there is no contract gate
// on this shape; `ScanEvidence` never reaches `openapi.v1.json`). The post-exclusion number lives
// in a NEW `effectiveSeverityCounts`, and ONLY the threshold comparison reads it.
// ===========================================================================================

/**
 * The CLASSES of exclusion — the unit the tier chain admits or declines.
 *
 * Admission is per CLASS, never per clause: SecOps above says "override requests of this kind may
 * have effect beneath me", and a tier below then authors the individual clauses. That is what makes
 * §6's accepted escalation seam (a component owner authors a declaration they benefit from, at a
 * weaker permission than the one that set the constraint) bounded rather than unbounded — "the
 * component authors the override; it does not author its own admission".
 *
 * A CLOSED enum. A clause naming an unrecognized class fails to parse and therefore excludes
 * nothing — the safe direction for a loosening.
 */
export const ScanExclusionClassSchema = z.enum([
  /** M22.3 — upstream has shipped no fix at all (`FixedVersion` absent). Pure data over the
   *  retained finding; no join. */
  "no_fix_available",
  /** M22.4 (owner decision D1) — the component is on the latest version of that dependency's major
   *  line. Needs the ADR-0032 dependency inventory. */
  "vendor_latest",
  /** M22.5 (owner decision D2) — the component declared a fact that makes the finding
   *  inapplicable. */
  "declared_fact",
  /** M22.6 (owner decisions D3/D4) — a standing, expiring grant approved at the tier that set the
   *  rule. */
  "approved_override"
]);
export type ScanExclusionClass = z.infer<typeof ScanExclusionClassSchema>;

// -------------------------------------------------------------------------------------------
// M22.5 (owner decision D2) — THE COMPONENT-DECLARED FACT's vocabulary.
//
// The owner chose DIRECT ENCODING: component info encodes the override, rather than SecOps
// authoring a mapping from a declaration to an exemption (recommended, declined). The escalation
// seam that follows is real and settled — a component's `properties` are writable at plain
// `object:write` SCOPED AT THAT COMPONENT, so the beneficiary of a declaration is also its author,
// at a weaker permission than the `policy:write` that set the constraint.
//
// What D2 does NOT require is that the declaration be UNBOUNDED, and these two schemas are where
// that bound is drawn:
//
//  1. A declared value lands VERBATIM in `control_runs.evidence` and in the gate Decision's
//     `inputContext` (ADR-0033 §6 guard 2 — an auditor reads *"passed because component X asserted
//     `egress: none` under admission Y"*, never just *"passed"*). Both of those are read by humans
//     and one of them is a row this project has already measured flooding at 1.44 GB/day, so an
//     unbounded blob is not an option: keys and values are short, single-line, and countable.
//  2. NEVER `labels`. They are tenant-writable, unvalidated (no schema, no reserved namespace) and
//     are already a live evasion path for selector-scoped policies (PR #247). A declaration lives in
//     a TYPED `property_schema` instead.
// -------------------------------------------------------------------------------------------

/** A declared fact's KEY — `egress`, `data.classification`, `internet_facing`. Lower-case, bounded,
 *  and single-line so it can be rendered in a Decision and in an audit trail without escaping. */
export const ScanDeclarationKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, "declaration key must match /^[a-z][a-z0-9_.-]*$/");

/** A declared fact's VALUE — `none`, `internal-only`, `pci`. Deliberately a STRING and not a union:
 *  the vocabulary is the org's, not this project's, and a closed value enum here would be the
 *  SecOps-authored mapping D2 declined. Bounded and single-line for the same reason the key is. */
export const ScanDeclarationValueSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\r\n\t]+$/, "declaration value must be a single line");

/**
 * ONE exclusion clause — what a `scanExclusion` policy effect's `exclude` key carries.
 *
 * `class` is REQUIRED and is the admission key. The remaining fields NARROW which findings the
 * clause reaches; every one that is PRESENT must equal the finding's corresponding field, and a
 * finding that does not carry that field never matches (ADR-0033 §1: "on a matcher miss, yields no
 * exclusion" — the opposite sign from the ceiling's fail-closed miss).
 *
 * `z.strictObject` for exactly the reason drizzle/0062's header gives for
 * `DependencySubscriptionEffectSchema`, and it bites HARDER here: a mistyped NARROWING key would be
 * silently stripped, leaving a clause with FEWER matchers — which for a loosening is a WIDENING.
 * `{"class": "no_fix_available", "pkgNmae": "openssl"}` must be refused, not quietly turned into
 * "every finding with no fix, anywhere in scope".
 */
export const ScanExclusionClauseSchema = z.strictObject({
  class: ScanExclusionClassSchema,
  /** Exact match on `ScanFinding.vulnerabilityId` (Trivy `VulnerabilityID`). */
  vulnerabilityId: z.string().min(1).optional(),
  /** Exact match on `ScanFinding.pkgName`. */
  pkgName: z.string().min(1).optional(),
  /** Exact match on `ScanFinding.purl`, VERBATIM as the scanner emitted it — no normalization here,
   *  matching `ScanFindingSchema.purl`'s own rule that canonicalization belongs at a join where both
   *  sides are visible. */
  purl: z.string().min(1).optional(),
  /** Exact match on `ScanFinding.class` (Trivy `Results[].Class`, e.g. `os-pkgs`/`lang-pkgs`). Named
   *  `findingClass` because `class` is already taken by the clause's own admission class, and one
   *  key meaning two different things is how a provenance label goes quietly false. */
  findingClass: z.string().min(1).optional(),
  /** M22.5 (owner decision D2) — WHICH component-declared fact this clause relies on, and WHAT the
   *  component must have declared for it. BOTH are required for a `declared_fact` clause to resolve
   *  at all: a clause naming a key but no value would exclude on the mere PRESENCE of a declaration,
   *  which is a component writing its own exemption with a one-word property. See
   *  {@link declaredFactPredicate}. Ignored by every other class. */
  declaredFact: ScanDeclarationKeySchema.optional(),
  declaredValue: ScanDeclarationValueSchema.optional(),
  /** Free text recorded verbatim in evidence and in the Decision (charter principle 6 — an auditor
   *  reads WHY a finding was tolerated, never just that it was). */
  reason: z.string().max(500).optional()
});
export type ScanExclusionClause = z.infer<typeof ScanExclusionClauseSchema>;

/**
 * The `scanExclusion` POLICY EFFECT — one effect kind carrying BOTH of §1's roles, because they are
 * two halves of one authoring act and splitting them into two effect kinds would let a reader
 * believe an `admit` had been authored where a `exclude` was.
 *
 *   `{"scanExclusion": {"admit": ["no_fix_available"]}}`
 *       — this tier ADMITS that class BENEATH it. Authored by whoever holds `policy:write` at or
 *         above the object it is scoped to.
 *   `{"scanExclusion": {"exclude": {"class": "no_fix_available", "pkgName": "openssl"}}}`
 *       — this tier CONTRIBUTES a clause. It has effect only if every tier ABOVE it admitted the
 *         class.
 *
 * An effect carrying NEITHER key is INERT — not an error. It reaches the resolver only from a
 * document that passed the migration's JSON Schema, and an inert contribution is the safe reading
 * for a loosening.
 */
export const ScanExclusionEffectSchema = z.strictObject({
  admit: z.array(ScanExclusionClassSchema).optional(),
  exclude: ScanExclusionClauseSchema.optional()
});
export type ScanExclusionEffect = z.infer<typeof ScanExclusionEffectSchema>;

/**
 * A clause that survived the AND, with the full chain of tiers that admitted it.
 *
 * `admittedBy` is not decoration: ADR-0033 §11 requires that "every applied exclusion names its
 * clause, admitting tier, authority and expiry", and a verdict that says only "excluded" is exactly
 * the coarse waiver §2 rejected.
 */
export const AdmittedScanExclusionClauseSchema = z.object({
  clause: ScanExclusionClauseSchema,
  /** The tier the CLAUSE was anchored at. */
  tier: ScanRequirementTierSchema,
  /** Human-legible origin: `policy:<name>@<objectId>`. */
  source: z.string(),
  /** Every tier above that admitted this clause's class, with the statement that did it. */
  admittedBy: z.array(z.object({ tier: ScanRequirementTierSchema, source: z.string() }))
});
export type AdmittedScanExclusionClause = z.infer<typeof AdmittedScanExclusionClauseSchema>;

// ===========================================================================================
// M22.8 — THE READ SURFACE'S WIRE CONTRACT (`GET /components/{idOrUrn}/scan-requirements`).
//
// Everything above this point travels on `control_runs.evidence` and in a Decision's
// `inputContext`, both of which are free-form JSON and therefore NOT wire contracts (measured
// during M22.0: `ScanRequirementTierSchema` never reaches `openapi.v1.json`). The schemas BELOW
// are the first ones in this file that genuinely do, which is why the tier enum finally appears in
// the generated spec with this increment and not with M22.0.
// ===========================================================================================

/**
 * ONE exclusion class, and where a clause of it would actually have effect for this component.
 *
 * `admittedBy` alone is not the answer an operator needs. ADR-0033 §1's algebra is a monotone AND
 * *down the tier chain*: a clause anchored at tier T has effect only if EVERY represented tier
 * strictly above T admits its class. So "org admits `no_fix_available`" tells you nothing about
 * whether a clause you author at the component will work — that depends on `platform` and
 * `trust_domain` too. {@link effectiveAtTiers} answers the question directly: these are the tiers at
 * which a clause of this class would survive the AND right now.
 *
 * An EMPTY `effectiveAtTiers` with a non-empty `admittedBy` is the diagnostic shape this field
 * exists for — somebody admitted the class somewhere, and a rung above them did not, so every
 * clause of that class is inert. That is the shipped default (admission is empty at every tier) and
 * it is precisely the state that is invisible without this surface.
 */
export const ScanExclusionAdmittedClassSchema = z.object({
  class: ScanExclusionClassSchema,
  /** Every admission statement for this class, from any represented tier, content-sorted. */
  admittedBy: z.array(z.object({ tier: ScanRequirementTierSchema, source: z.string() })),
  /** The tiers at which a clause of this class would survive the AND, top-down. May be empty. */
  effectiveAtTiers: z.array(ScanRequirementTierSchema)
});
export type ScanExclusionAdmittedClass = z.infer<typeof ScanExclusionAdmittedClassSchema>;

/**
 * A contributing policy this route DID NOT EVALUATE, named rather than silently folded in.
 *
 * The route resolves scan requirements for a COMPONENT, not for a change — so there is no change,
 * no subject, no graph facts and no gate instant to build a CEL context from. Evaluating a
 * condition against a fabricated context would produce an answer that is confidently wrong; the
 * route therefore evaluates NO CEL at all and treats every condition-carrying contributor
 * conservatively **in each dimension's own direction** (see `scan-requirements-read.ts`).
 */
export const UnevaluatedScanPolicyConditionSchema = z.object({
  policyObjectId: z.string().uuid(),
  policyVersion: z.number().int().nonnegative(),
  name: z.string(),
  condition: z.string()
});
export type UnevaluatedScanPolicyCondition = z.infer<typeof UnevaluatedScanPolicyConditionSchema>;

/**
 * `GET /components/{idOrUrn}/scan-requirements` — WHAT RULES ARE IN FORCE FOR THIS COMPONENT.
 *
 * WRITES NO DECISION, and that is the reason it exists rather than pointing operators at
 * `POST /policy-evaluate`: that endpoint runs the real orchestrator and writes one Decision row per
 * call with NO write suppression, so a UI polling it would reproduce, on a per-viewer schedule, the
 * exact 1.44 GB/day amplification ADR-0024 §D0 was raised to stop. This surface reads.
 *
 * IT IS NOT A PREDICTION OF A GATE VERDICT. It answers "which ceiling and which loosenings are
 * authored and admitted for this component", which is a question about POLICY. A gate verdict also
 * depends on the change, the actor, the artifact, the scanner's findings and every CEL condition —
 * none of which exist here.
 */
export const ComponentScanRequirementsResponseSchema = z.object({
  componentId: z.string().uuid(),
  componentUrn: z.string(),
  /** The rungs of the six-tier chain that EXIST for this component (`platform` and `trust_domain`
   *  always; the rest from its containment chain). A rung that does not exist is never asked to
   *  admit anything — ADR-0033 §1, and the reason the AND is not vacuous in either direction. */
  representedTiers: z.array(ScanRequirementTierSchema),
  /** The resolved per-severity ceiling and every tier that contributed to it. `null` when NO tier
   *  contributes a ceiling at all — the scan control then falls back to its own per-binding
   *  `config.threshold` (the unchanged M17.1 behaviour), which this route cannot see. */
  threshold: EffectiveScanThresholdSchema.nullable(),
  /** Which exclusion classes are admitted, and where a clause of each would have effect. */
  admittedExclusionClasses: z.array(ScanExclusionAdmittedClassSchema),
  /** The exclusion clauses that survive the AND for this component today.
   *
   *  ADMISSION ONLY — never application. Whether a surviving clause actually excludes a finding
   *  depends on facts this route deliberately does not resolve (the dependency inventory's head,
   *  the component's declarations, live grants and their expiry) and on findings that do not exist
   *  until a scan runs. Conflating "admitted" with "applied" is the confusion ADR-0033 §1's last
   *  paragraph names; both halves are needed and they are different questions. */
  exclusionClauses: z.array(AdmittedScanExclusionClauseSchema),
  /** Every contributor carrying a CEL condition, which this route did not evaluate. */
  unevaluatedConditions: z.array(UnevaluatedScanPolicyConditionSchema)
});
export type ComponentScanRequirementsResponse = z.infer<
  typeof ComponentScanRequirementsResponseSchema
>;

// ===========================================================================================
// M22.4 (ADR-0033 D1) — THE VENDOR RULE'S FACTS.
//
// The owner's headline rule: a vendor dependency is accepted only if we are on the LATEST VERSION
// OF A MAJOR VERSION. That maps exactly onto `dependency_lines`' identity
// `(org_id, ecosystem, coordinate, major)` — being "at the head" of the line a declaration sits on.
//
// WHY THE FACTS TRAVEL AS DATA RATHER THAN BEING LOOKED UP. The exclusion set is resolved at GATE
// time, before any scan has been read, and it is then handed to a PLUGIN that has no database and
// no lookup ability. So every fact the rule needs is resolved server-side against the ADR-0032
// inventory and serialized here; the matcher below is pure and reaches nothing.
//
// THREE FINDING CLASSES, TWO REACHABLE (ADR-0033 "costs/honesty"):
//   - `os-pkgs`   — attributable to the BASE IMAGE line. `dockerfile.ts` parses every real `FROM`
//                   into a declared `oci` dependency, so "we are on the latest base image" is a
//                   fact about that line and it earns every OS-package finding a pass.
//   - `lang-pkgs` with a DECLARED line — attributable to its own line, via {@link packageKeys}.
//   - `lang-pkgs` TRANSITIVE — NO line, and therefore NO pass. Defensible rather than a gap: a
//                   transitive is fixed by moving the DIRECT parent that pulls it, and the direct
//                   parent has a line of its own.
// ===========================================================================================

/**
 * The `(ecosystem, coordinate)` identity of one at-head line, canonicalised ONCE, here, where both
 * sides of the join are visible.
 *
 * `ScanFindingSchema.purl` and `dependency_lines.coordinate` are BOTH stored deliberately
 * un-normalised, each in its own producer's vocabulary, and both of those decisions say the same
 * thing: canonicalisation belongs at the join, not smeared across the two writers. This is that
 * join, and it is a single exported function precisely so the server (building the fact) and the
 * matcher (consuming it) cannot drift into two spellings of one package.
 *
 * ONLY `python` IS FOLDED, and only by its own published rule (PEP 503: lower-case, and runs of
 * `-`, `_` and `.` collapsed to a single `-`) — Trivy reports a distribution's metadata name while a
 * manifest spells the requirement, and `Flask` vs `flask` vs `zope.interface` vs `zope-interface`
 * are the SAME distribution by specification. Nothing else is case-folded: npm names are lower-case
 * by registry rule, Maven coordinates are case-sensitive, and Go module paths are case-sensitive by
 * language specification (`github.com/Masterminds/semver`). Folding those would be inventing an
 * equality the ecosystem does not grant — and for a LOOSENING an invented equality is a false
 * positive, which is the one direction this feature may not fail in.
 */
export function vendorLatestPackageKey(ecosystem: DependencyEcosystem, coordinate: string): string {
  const canonical =
    ecosystem === "python" ? coordinate.toLowerCase().replace(/[-_.]+/g, "-") : coordinate;
  return `${ecosystem}|${canonical}`;
}

/** purl `type` → this project's `DependencyEcosystem`. A purl whose type is not one of the four
 *  LANGUAGE ecosystems (an `apk`/`deb`/`rpm` OS package, an unknown type, a malformed string) yields
 *  `undefined`, and a finding with no ecosystem can match no package key — the fail-closed
 *  direction. `oci` is deliberately ABSENT from this map: an image is never a `lang-pkgs` finding,
 *  and the base image is reached through {@link ScanVendorLatestFactsSchema.baseImageAtLatest}
 *  instead. */
const PURL_TYPE_TO_ECOSYSTEM: Readonly<Record<string, DependencyEcosystem>> = {
  npm: "npm",
  golang: "go",
  maven: "maven",
  pypi: "python"
};

/** Read the ecosystem out of a purl's `type` segment — `pkg:npm/lodash@4.17.21` → `npm`. Total: any
 *  string that is not a purl of a known LANGUAGE type yields `undefined`. */
export function purlEcosystem(purl: string | undefined): DependencyEcosystem | undefined {
  if (!purl) return undefined;
  const match = /^pkg:([^/@?#]+)\//.exec(purl);
  const type = match?.[1]?.toLowerCase();
  if (type === undefined) return undefined;
  return PURL_TYPE_TO_ECOSYSTEM[type];
}

/**
 * WHAT THE SERVER RESOLVED ABOUT THIS TARGET'S DEPENDENCY INVENTORY — the only input the
 * `vendor_latest` predicate has.
 *
 * ABSENT MEANS NO VENDOR-PASS, never "everything is current". That is the same reading
 * `dependency_lines.latest_version`'s own NULL carries ("not yet observed" is never "no newer
 * version exists") and the same reading `scan_requirement_floors` established for its nullable
 * ceilings. Every one of D1's fail-closed cases — a NULL `latest_version`, a stale
 * `latest_observed_at`, no inventory row at all, an `unresolved`/`unpinned` `FROM`, an outpost where
 * `dependencyVersionPollRoleGuard` means the head was never observed locally, and a component with
 * no dependency automation at all (D7) — arrives here as a MISSING fact rather than as a special
 * case in the matcher.
 */
export const ScanVendorLatestFactsSchema = z.object({
  /**
   * TRUE iff this target declares at least one `oci` base-image line AND every one of them is at
   * its observed head BY DIGEST.
   *
   * THE COMPARISON IS THE DIGEST, NEVER THE TAG (ADR-0033: "a tag is not an identity"). An OCI index
   * reports tags, and a tag is mutable — `3.19` names a different set of bytes this week than last —
   * so agreeing on a tag is not evidence of being on the same image. `latest_digest` is recorded in
   * the SAME observation as `latest_version` for exactly this reason.
   *
   * EVERY declared line, not any: a multi-stage build declares several, an `os-pkgs` finding names
   * no image, and there is no material to attribute it to one of them. Requiring all of them is the
   * only reading that cannot pass a finding that came from a stale base.
   */
  baseImageAtLatest: z.boolean(),
  /** {@link vendorLatestPackageKey} for every DECLARED LANGUAGE line this target is at the head of.
   *  Sorted, so two identical resolutions serialize identically — the M22.0 write-suppression rule
   *  reaches this array through the gate Decision's `inputContext`. */
  packageKeys: z.array(z.string())
});
export type ScanVendorLatestFacts = z.infer<typeof ScanVendorLatestFactsSchema>;

// ===========================================================================================
// M22.5 (owner decision D2) — WHAT THE COMPONENT DECLARED, and the write door that bounds it.
// ===========================================================================================

/** The `component.properties` key the declarations live under. ONE constant, because the migration's
 *  JSON Schema, the request-body validator and the gate-time reader must name the same key — three
 *  string literals is how one of them silently stops being read. */
export const COMPONENT_SECURITY_PROPERTY_KEY = "security";

/** How many declarations one component may carry. They all reach the gate Decision's `inputContext`
 *  verbatim, so the set is countable by construction rather than by hoping nobody writes a thousand. */
export const COMPONENT_SECURITY_DECLARATIONS_CAP = 32;

/**
 * THE REQUEST-BODY VALIDATOR — `z.strictObject`, and this is the guard ADR-0033 §6 names explicitly.
 *
 * WHY STRICT HERE AND OPEN IN THE MIGRATION, which is not an inconsistency but the whole design.
 * `import-repo.ts`'s `object_upsert` branch Ajv-validates an incoming object against the registered
 * `property_schema` with NO `try/catch`, so ONE rejection aborts a peer's ENTIRE signed bundle and
 * wedges the channel. A closed schema in the registry would therefore make every future property
 * addition a fail-closed version-skew hazard — 0043's rule, and 0051's header restates it. So the
 * registry stays OPEN and the strictness moves to the LOCAL author's door, where a refusal costs one
 * 400 and nobody's bundle.
 *
 * The strictness is load-bearing rather than tidy: `{"declarationz": {...}}` or
 * `{"declarations": {...}, "egress": "none"}` would otherwise be stored, read as NO declarations, and
 * the component owner would believe they had declared something. For a LOOSENING that mistake is
 * only ever fail-closed — but it is silent, and the author has no way to discover it.
 */
export const ComponentSecurityPropertySchema = z.strictObject({
  declarations: z
    .record(ScanDeclarationKeySchema, ScanDeclarationValueSchema)
    .refine((d) => Object.keys(d).length <= COMPONENT_SECURITY_DECLARATIONS_CAP, {
      message: `at most ${COMPONENT_SECURITY_DECLARATIONS_CAP} declarations`
    })
});
export type ComponentSecurityProperty = z.infer<typeof ComponentSecurityPropertySchema>;

/**
 * WHAT THE TARGETS DECLARED, as the gate resolved it — the only input the `declared_fact` predicate
 * has, for the same reason the vendor facts are data: the matcher runs inside a plugin with no
 * database.
 *
 * A SORTED ARRAY OF PAIRS rather than a record, so the serialization is order-stable by construction
 * on the way into the Decision's `inputContext`. (`restatesDecision` canonicalises object key order,
 * so a record would in fact also be safe — but `packageKeys` next door is an array, and one shape for
 * one job means nobody has to remember which of the two rules applies where.)
 */
export const ScanDeclaredFactsSchema = z.object({
  declarations: z.array(
    z.object({ key: ScanDeclarationKeySchema, value: ScanDeclarationValueSchema })
  )
});
export type ScanDeclaredFacts = z.infer<typeof ScanDeclaredFactsSchema>;

// ===========================================================================================
// M22.6 (owner decisions D3/D4) — THE APPROVED OVERRIDE, as the gate resolved it.
// ===========================================================================================

/**
 * ONE standing grant, already filtered to `approved` and already inside its expiry window by the
 * resolver's read-time SQL comparison (ADR-0033 §6a: "expiry is a read-time SQL window, never a
 * status column a job flips" — there is no sweeper in this tree and no `boss.schedule` to build one
 * on).
 *
 * `expiresAt` travels anyway, and NOT as a second enforcement point: it is the "until when" ADR-0033
 * §11 requires every applied exclusion to name. It is a STORED value, so two identical evaluations
 * still serialize identically and write suppression holds.
 */
export const ScanOverrideGrantFactSchema = z.object({
  /** The grant's graph object id — what an auditor resolves to read the whole act. */
  grantObjectId: z.string(),
  /** REQUIRED. D4's unit is (component × finding), and a grant naming no finding would be a blanket
   *  waiver on a component — precisely the coarse shape ADR-0033 §2 rejected. */
  vulnerabilityId: z.string(),
  /** Optional NARROWING: the same CVE in a different package is a different exposure. */
  pkgName: z.string().optional(),
  /** The object naming the tier that set the rule — the authority this grant was approved under
   *  (D3). */
  tierObjectId: z.string(),
  /**
   * The TIER of `tierObjectId`, DERIVED at resolve time from the target's own containment chain —
   * never a value anybody wrote down.
   *
   * This is the field D3 is actually enforced on. `tierObjectId` is supplied by the REQUESTER, so on
   * its own it decides nothing: naming a LOWER object would widen the approver set (`scopeExpandCte`
   * expands upward), which is the exact inverse of "you cannot waive a constraint stricter than your
   * own authority". The resolver therefore places the named object on the component's chain, reads
   * its tier from that placement, and compares it against {@link ScanApprovedOverridesSchema}'s
   * `requiredTier` — which is itself derived from the ceiling's contributing tiers. A grant that
   * cannot be placed, or whose tier is junior to the bar, never reaches this array.
   */
  tier: ScanRequirementTierSchema,
  expiresAt: z.string()
});
export type ScanOverrideGrantFact = z.infer<typeof ScanOverrideGrantFactSchema>;

/** A grant as the ROW says it is, before the authority bar has been applied — the resolver's
 *  intermediate shape. It has no `tier` because a tier is a property of the target's containment
 *  chain, not of the stored row. */
export type ScanOverrideGrantCandidate = Omit<ScanOverrideGrantFact, "tier">;

/** One grant that was live and in date but did NOT clear the authority bar, recorded so the refusal
 *  is a positive statement in the Decision rather than a silent absence (charter principle 6). */
export const RefusedScanOverrideGrantSchema = z.object({
  grantObjectId: z.string(),
  /** Absent when `tierObjectId` is not on the target's containment chain at all — the grant names an
   *  authority that has no standing over this component whatsoever. */
  tier: ScanRequirementTierSchema.optional(),
  reason: z.enum(["tier_not_on_containment_chain", "tier_below_required"])
});
export type RefusedScanOverrideGrant = z.infer<typeof RefusedScanOverrideGrantSchema>;

export const ScanApprovedOverridesSchema = z.object({
  grants: z.array(ScanOverrideGrantFactSchema),
  /**
   * THE DERIVED BAR (D3). The most senior tier that set any part of the ceiling this exclusion would
   * loosen; `component` when no tier set one at all. Present whenever the override dimension was
   * resolved — it is the rule the grants above were measured against, and a Decision that named the
   * grants without naming the bar would explain half of the verdict.
   */
  requiredTier: ScanRequirementTierSchema.optional(),
  /** Live, in-date grants the bar refused. Sorted by `grantObjectId`, content-only — no timestamps,
   *  so two identical evaluations still serialize identically (the M22.0 write-suppression rule). */
  refusedForAuthority: z.array(RefusedScanOverrideGrantSchema).optional()
});
export type ScanApprovedOverrides = z.infer<typeof ScanApprovedOverridesSchema>;

// -------------------------------------------------------------------------------------------
// The override request as a GRAPH OBJECT (charter principle 2) and its API surface.
// -------------------------------------------------------------------------------------------

/** The registered `object_types.id`. ONE constant: the migration, the governance-managed set, the
 *  repo and the resolver must all name the same type, and four string literals is how one of them
 *  quietly stops being reached. */
export const SCAN_OVERRIDE_GRANT_TYPE_ID = "scan_override_grant";

/**
 * A grant's lifecycle, held in `properties.status`.
 *
 * FOUR STATES, and `expired` is deliberately NOT one of them. Expiry is a READ-TIME SQL WINDOW
 * (ADR-0033 §6a) — `expiresAt > now()` evaluated by the resolver on every read — never a status a
 * background job flips, because there is no sweeper anywhere in this tree and no `boss.schedule`
 * usage to build one on. A fifth `expired` value would be a promise that something transitions rows
 * into it, and nothing would.
 *
 * `denied` and `revoked` are distinct on purpose: one is "this was never granted", the other is
 * "this was granted and has been taken back", and an auditor reading a Decision that cites a grant
 * needs to be able to tell those apart.
 */
export const ScanOverrideGrantStatusSchema = z.enum(["requested", "approved", "denied", "revoked"]);
export type ScanOverrideGrantStatus = z.infer<typeof ScanOverrideGrantStatusSchema>;

/** The API projection of one grant object. */
export const ScanOverrideGrantSchema = z.object({
  id: z.string(),
  urn: z.string(),
  name: z.string(),
  status: ScanOverrideGrantStatusSchema,
  componentId: z.string(),
  vulnerabilityId: z.string(),
  pkgName: z.string().nullable(),
  tierObjectId: z.string(),
  reason: z.string(),
  expiresAt: z.string().nullable(),
  decidedByActorId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  requestedByActorId: z.string(),
  createdAt: z.string()
});
export type ScanOverrideGrant = z.infer<typeof ScanOverrideGrantSchema>;

export const ScanOverrideGrantListResponseSchema = z.object({
  items: z.array(ScanOverrideGrantSchema)
});

export const ScanOverrideGrantIdParamSchema = z.object({ id: z.string() });

/** Listing is COMPONENT-SCOPED and the component is REQUIRED. An unscoped list of "every accepted
 *  risk in this org" is a map of deliberately-tolerated weaknesses, and handing one out to any holder
 *  of `object:read` at the org root is a wider disclosure than the read that authorized it. */
export const ScanOverrideGrantListQuerySchema = z.object({
  component: z.string().min(1)
});

/**
 * RAISING a request. `tierObjectId` names the object whose tier set the rule the requester wants
 * waived. It is constitutive of the request rather than something the approver supplies later.
 *
 * IT IS A CLAIM, NOT A GRANT OF STANDING, and the difference is load-bearing. The first version of
 * this comment said "naming a tier confers nothing: the approval check runs against the named
 * object" — which was false in the one direction that mattered. `authz/resolve.ts`'s
 * `scopeExpandCte` expands UPWARD, so naming a LOWER object strictly WIDENS the set of principals
 * whose bindings satisfy the approve check. A requester could therefore select their own approver
 * standing by naming an object they already held `policy:write` at, and waive a ceiling set far
 * above it. Three derived checks now bound the claim, none of which trusts it:
 *
 *   1. AT RAISE — the named object must lie on the component's own containment chain
 *      (`assertOverrideTierStanding`). An object elsewhere in the graph has no standing over this
 *      component at all.
 *   2. AT APPROVE — the same chain check, re-derived, plus a refusal when an INSTANCE floor
 *      (`platform`/`trust_domain`) contributes any ceiling: those rungs are operator-authored and no
 *      tenant object maps to them, so such a grant could never apply and approving it would leave
 *      the approver with a false belief.
 *   3. AT THE GATE — the decisive one. The resolver places `tierObjectId` on the target's chain,
 *      reads its TIER from that placement, and drops the grant unless that tier is at-or-above the
 *      most senior tier that contributed to the effective ceiling. That comparison is derived from
 *      `EffectiveScanThreshold.contributors`, which M22.0 recorded precisely so a verdict can name
 *      the tier that bound it.
 */
export const CreateScanOverrideGrantRequestSchema = z.strictObject({
  componentId: z.string().min(1),
  vulnerabilityId: z.string().min(1).max(200),
  pkgName: z.string().min(1).max(200).optional(),
  tierObjectId: z.string().min(1),
  /** MANDATORY and non-empty — the `freeze.override` shape (DESIGN §10.3), never the approvals
   *  shape. */
  reason: z.string().min(1).max(500)
});
export type CreateScanOverrideGrantRequest = z.infer<typeof CreateScanOverrideGrantRequestSchema>;

/** APPROVING. `expiresAt` is REQUIRED: D4's grant is standing *with an expiry*, and a grant with no
 *  expiry is the permanent blanket waiver the decision explicitly did not take. */
export const ApproveScanOverrideGrantRequestSchema = z.strictObject({
  expiresAt: z.string().datetime(),
  reason: z.string().min(1).max(500)
});
export type ApproveScanOverrideGrantRequest = z.infer<typeof ApproveScanOverrideGrantRequestSchema>;

/** DENYING or REVOKING — one shape, because both are the same act on the authority side and both
 *  need the same mandatory reason. */
export const DecideScanOverrideGrantRequestSchema = z.strictObject({
  reason: z.string().min(1).max(500)
});
export type DecideScanOverrideGrantRequest = z.infer<typeof DecideScanOverrideGrantRequestSchema>;

/** The gate-resolved exclusion set, threaded to `scan-result-control` on the control-run CONTEXT
 *  (`context.scanExclusions`) — the SAME conditional-context mechanism that already carries
 *  `artifactDigest` and `scanThreshold`. A plugin has no database and no lookup ability, so every
 *  exclusion FACT is resolved server-side and serialized here. */
export const EffectiveScanExclusionsSchema = z.object({
  clauses: z.array(AdmittedScanExclusionClauseSchema),
  /** M22.4 — resolved ONLY when a `vendor_latest` clause actually survived the AND, so a deployment
   *  that authored no such clause pays no inventory query and writes no extra key. */
  vendorLatest: ScanVendorLatestFactsSchema.optional(),
  /** M22.5 — same conditional resolution, same reason: no `declared_fact` clause, no property read. */
  declaredFacts: ScanDeclaredFactsSchema.optional(),
  /** M22.6 — same again: no `approved_override` clause, no grant query. */
  approvedOverrides: ScanApprovedOverridesSchema.optional()
});
export type EffectiveScanExclusions = z.infer<typeof EffectiveScanExclusionsSchema>;

/**
 * WHY EVERY EXCLUSION FOR A SCAN WAS REFUSED — a positive statement, never an inference from an
 * empty applied list.
 *
 *   `truncated`    — the persisted finding set hit `SCAN_FINDINGS_PERSIST_CAP`. "You cannot except
 *                    what you did not record" (ADR-0033 §7).
 *   `unsupported`  — this scanner family carries no per-finding material at all. OpenSCAP: XCCDF
 *                    rule-results have no package, no purl, no `FixedVersion`, no `Class`, and
 *                    XCCDF emits no `critical`. ADR-0033's consequences list requires this be
 *                    explicit and tested rather than left to "there were no findings to exclude".
 *   `not_recorded` — no finding set was recorded at all (a pre-M22.1b verdict, or a producer whose
 *                    payload did not survive validation).
 */
export const ScanExclusionRefusalSchema = z.enum(["truncated", "unsupported", "not_recorded"]);
export type ScanExclusionRefusal = z.infer<typeof ScanExclusionRefusalSchema>;

/** How many APPLIED exclusions are enumerated in evidence. `control_runs.evidence` is copied
 *  VERBATIM into every signed promotion bundle (`federation/promotion-repo.ts`), so the enumeration
 *  is bounded while `appliedCount` stays exact. */
export const SCAN_EXCLUSION_EVIDENCE_CAP = 100;

/** ONE applied exclusion, as it appears in evidence and in the Decision. */
export const AppliedScanExclusionSchema = z.object({
  /** Position of the excluded finding within the PERSISTED set — the `scan_findings.ordinal` of the
   *  row this decision is about, so evidence and table join without a second identity. */
  ordinal: z.number().int().nonnegative(),
  severity: z.enum(COUNTED_SEVERITIES),
  class: ScanExclusionClassSchema,
  /** The tier the clause was anchored at, and the policy that authored it. */
  tier: ScanRequirementTierSchema,
  source: z.string(),
  vulnerabilityId: z.string().optional(),
  pkgName: z.string().optional(),
  reason: z.string().optional(),
  /** M22.5 (ADR-0033 §6 guard 2) — the declaration this exclusion rested on, VERBATIM. An auditor
   *  reads *"passed because component X asserted `egress: none` under admission Y"*; a Decision that
   *  said only "declared_fact" would be the coarse waiver §2 rejected wearing a class name. */
  declaredFact: z.string().optional(),
  declaredValue: z.string().optional(),
  /** M22.6 (ADR-0033 §11) — the grant, its authority and its expiry: "under whose authority, until
   *  when". */
  grantObjectId: z.string().optional(),
  grantTierObjectId: z.string().optional(),
  grantExpiresAt: z.string().optional()
});
export type AppliedScanExclusion = z.infer<typeof AppliedScanExclusionSchema>;

export const ScanExclusionEvidenceSchema = z.object({
  /** How many clauses the gate resolved as admitted for this change's targets. */
  clauseCount: z.number().int().nonnegative(),
  /** How many findings were actually excluded — EXACT, even when `applied` below is capped. */
  appliedCount: z.number().int().nonnegative(),
  applied: z.array(AppliedScanExclusionSchema),
  /** Present iff admitted clauses existed and NONE could be applied, with the reason. */
  refused: ScanExclusionRefusalSchema.optional()
});
export type ScanExclusionEvidence = z.infer<typeof ScanExclusionEvidenceSchema>;

/**
 * THE CLASS'S OWN PREDICATE — the half of a clause that the class name promises.
 *
 * A clause is `class` + narrowing matchers, and the class is NOT merely a label for admission: it is
 * an assertion about the finding. A `no_fix_available` clause that excluded a finding which HAS a
 * fix would make the Decision misdescribe its own inputs (charter principle 6), so the class is
 * enforced as a conjunct, not trusted as a name.
 *
 * `undefined` means THIS CLAUSE CANNOT BE RESOLVED, and it then yields NO exclusion. All four classes
 * are now built (`vendor_latest` an ADR-0032 inventory join, `declared_fact` a typed component
 * property, `approved_override` a standing grant with a read-time expiry window), so `undefined` no
 * longer means "not written yet" — it means THE FACTS THIS CLAUSE NEEDS WERE NOT RESOLVED, which is
 * the ordinary shape of every one of ADR-0033's fail-closed cases: no inventory, no declaration, no
 * live grant. That the two states share a return value is deliberate and the reason is unchanged: a
 * clause whose input is missing must fail CLOSED rather than degrade into "the matchers alone".
 * Degrading would mean `{"class": "approved_override", "pkgName": "openssl"}` excluded every openssl
 * finding — a blanket waiver written as an exception.
 *
 * EXHAUSTIVE over `ScanExclusionClass` on purpose: a fifth class added later is a compile error
 * here, forcing a decision, rather than silently inheriting either arm.
 */
function scanExclusionClassPredicate(
  clause: ScanExclusionClause,
  facts: ScanExclusionFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  switch (clause.class) {
    case "no_fix_available":
      // M22.3 — PURE DATA OVER THE RETAINED FIELDS, no join of any kind. `fixedVersion` is absent
      // exactly when Trivy reported no `FixedVersion` — read as the signal, never inferred from
      // anything else (an EMPTY string is already normalized to absent by `parseTrivyFindings`, so
      // `""` and a missing key are one state here rather than two).
      //
      // NOTE WHAT THIS DELIBERATELY DOES NOT DO: it does not ask whether a fix exists ANYWHERE, only
      // whether THE SCANNER SAID SO for this entry. A finding whose `FixedVersion` the scanner could
      // not populate (an old vulnerability DB, a package ecosystem Trivy tracks without fix data) is
      // excluded by a clause of this class, and that is the accepted meaning of the class: "the
      // scanner offered us no remediation". Inferring the opposite from a second source would be a
      // provenance label named after the branch that matched.
      return (finding) => finding.fixedVersion === undefined;
    case "vendor_latest":
      return vendorLatestPredicate(facts?.vendorLatest);
    case "declared_fact":
      return declaredFactPredicate(clause, facts?.declaredFacts);
    case "approved_override":
      return approvedOverridePredicate(facts?.approvedOverrides);
  }
}

/**
 * M22.5 (D2) — "the component declared a fact that makes this finding inapplicable".
 *
 * TWO CONDITIONS, both required, and the second is what keeps D2's accepted escalation seam bounded
 * rather than unbounded:
 *
 *  1. The CLAUSE must name BOTH the fact and the value it relies on. A clause naming only
 *     `declaredFact: "egress"` would fire on any value at all — including `egress: "internet"` —
 *     which is a component excusing itself by writing a property whose CONTENT nobody constrained.
 *     Absent either key the predicate is `undefined` and the clause excludes nothing.
 *  2. The TARGETS must actually have declared that exact pair. The comparison is a plain string
 *     equality on values that were bounded at the write door; there is no case-folding and no
 *     truthiness reading, because `"None"` and `"none"` being the same fact is the org's decision to
 *     make in its own vocabulary, not one this file may invent. An invented equality is a false
 *     positive, and for a loosening that is the one direction this feature may not fail in.
 *
 * NOTE WHAT THIS DELIBERATELY IS NOT: the declaration does not describe the FINDING, so the predicate
 * is finding-INDEPENDENT once the fact holds. The narrowing to the findings the fact actually
 * excuses is the CLAUSE's other matchers (`findingClass`, `pkgName`, `vulnerabilityId`), authored at
 * `policy:write` by whoever admitted the class — never by the component. That split is the whole of
 * ADR-0033 §6 guard 1: the component authors the override, it does not author its own admission.
 */
function declaredFactPredicate(
  clause: ScanExclusionClause,
  facts: ScanDeclaredFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (clause.declaredFact === undefined || clause.declaredValue === undefined) return undefined;
  if (!facts) return undefined;
  const declared = facts.declarations.some(
    (d) => d.key === clause.declaredFact && d.value === clause.declaredValue
  );
  if (!declared) return undefined;
  return () => true;
}

/**
 * M22.6 (D3/D4) — "an owner raised an override request, it was approved at the tier that set the
 * rule, and it has not expired".
 *
 * Every one of those three words is decided BEFORE this predicate: the resolver reads only grants
 * whose status is `approved` and whose expiry is still in the future at the moment of the read (the
 * read-time SQL window), and approval itself required `policy:write` at the object naming the tier
 * that set the rule. What is left here is the per-finding join, and it is deliberately EXACT:
 * `vulnerabilityId` must be equal, and a grant that also names a `pkgName` must match that too.
 *
 * NO grants resolved yields `undefined` — no exclusion — rather than a predicate that is always
 * false, so a clause of this class with nothing granted behaves identically to a class whose
 * machinery does not exist. Both are "excludes nothing"; keeping them the same shape means a
 * later reader cannot mistake one for the other.
 */
function approvedOverridePredicate(
  facts: ScanApprovedOverrides | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (!facts || facts.grants.length === 0) return undefined;
  return (finding) => scanOverrideGrantFor(facts, finding) !== undefined;
}

/**
 * WHICH grant excuses this finding — the SINGLE definition, shared by the predicate above and by the
 * evidence projection in {@link applyScanExclusions}.
 *
 * Two functions answering "does a grant match?" and "which grant matched?" is exactly the shape where
 * the evidence names one grant and the verdict was decided by another. The first grant in the
 * resolver's own deterministic order wins, so two identical evaluations attribute identically.
 */
export function scanOverrideGrantFor(
  facts: ScanApprovedOverrides | undefined,
  finding: ScanFinding
): ScanOverrideGrantFact | undefined {
  if (!facts) return undefined;
  return facts.grants.find((g) => {
    // A finding with NO `VulnerabilityID` can never be excused: a grant is per (component × finding)
    // and an unidentifiable finding is not a finding anyone approved. `undefined !== "CVE-…"` already
    // says so; it is spelled out because this is the one comparison whose failure would be silent.
    if (finding.vulnerabilityId !== g.vulnerabilityId) return false;
    if (g.pkgName !== undefined && finding.pkgName !== g.pkgName) return false;
    return true;
  });
}

/**
 * M22.4 (D1) — "we are on the latest version of this dependency's major line", read off the
 * SERVER-RESOLVED facts and the finding's own `Results[].Class`.
 *
 * `undefined` when NO facts were resolved: a `vendor_latest` clause with no inventory behind it
 * excludes nothing at all, which is the whole of D7's "the gate is decoupled from automation, the
 * data is not" — a component with no dependency automation has no ingested manifests and no polled
 * head, so it gets no vendor-pass and upgrades manually.
 */
function vendorLatestPredicate(
  facts: ScanVendorLatestFacts | undefined
): ((finding: ScanFinding) => boolean) | undefined {
  if (!facts) return undefined;
  const keys = new Set(facts.packageKeys);
  return (finding) => {
    // OS PACKAGES → THE BASE IMAGE LINE. An `apk`/`deb`/`rpm` package is not declared in any
    // manifest; what the component declares is the `FROM` it came in on, so the base image line's
    // head is the fact that speaks for it.
    if (finding.class === "os-pkgs") return facts.baseImageAtLatest;
    if (finding.class !== "lang-pkgs") {
      // An UNRECOGNISED or ABSENT `Class` attributes to nothing. Trivy emits other classes
      // (`license`, `secret`, `config`) and a finding with no class at all is retained by
      // `parseTrivyFindings` on its severity alone. None of them names a dependency line, and
      // guessing one is the inversion this feature may not make.
      return false;
    }
    // A LANGUAGE PACKAGE → ITS OWN DECLARED LINE. `pkgName` is the join key rather than the purl's
    // own name segment because Trivy spells a package the way its ecosystem does — `@babel/core`,
    // `com.acme:lib`, `github.com/acme/lib` — which is exactly how the manifest parsers spell a
    // coordinate. The purl is read for the ECOSYSTEM only, and a finding with no purl (or a purl of
    // an OS type) yields no ecosystem and therefore no match: the alternative, matching a bare name
    // across all four ecosystems, would let a transitive npm `requests` be excused by a declared
    // Python `requests` at head.
    const ecosystem = purlEcosystem(finding.purl);
    if (ecosystem === undefined || finding.pkgName === undefined) return false;
    // A TRANSITIVE dependency has no declared line, so its key is simply not in the set and it does
    // not qualify. That is the mechanism, not an omission (ADR-0033: a transitive is fixed by moving
    // the direct parent that pulls it).
    return keys.has(vendorLatestPackageKey(ecosystem, finding.pkgName));
  };
}

/** The server-resolved facts a class predicate may consult. Structurally the exclusion set minus its
 *  clauses, so `applyScanExclusions` can hand the whole resolved object down without the pure
 *  matcher needing to know how it was assembled. */
export type ScanExclusionFacts = Pick<
  EffectiveScanExclusions,
  "vendorLatest" | "declaredFacts" | "approvedOverrides"
>;

/** Whether a clause reaches a finding: the class's own predicate AND every present matcher. A
 *  finding lacking a field the clause names never matches — `undefined !== "openssl"`. */
export function scanExclusionClauseMatches(
  clause: ScanExclusionClause,
  finding: ScanFinding,
  facts?: ScanExclusionFacts
): boolean {
  const predicate = scanExclusionClassPredicate(clause, facts);
  if (!predicate) return false; // class not yet resolvable — NO exclusion
  if (!predicate(finding)) return false;
  if (clause.vulnerabilityId !== undefined && finding.vulnerabilityId !== clause.vulnerabilityId)
    return false;
  if (clause.pkgName !== undefined && finding.pkgName !== clause.pkgName) return false;
  if (clause.purl !== undefined && finding.purl !== clause.purl) return false;
  if (clause.findingClass !== undefined && finding.class !== clause.findingClass) return false;
  return true;
}

export interface AppliedScanExclusions {
  /** The findings that SURVIVE — what the threshold comparison counts. */
  findings: ScanFinding[];
  /** Ordinals (positions in the input array) that were excluded, ascending. This is what promotes a
   *  `scan_findings` row from retention class `O` to `E`: an excluded finding is accepted-risk
   *  evidence explaining a live verdict (ADR-0024 §D1 per-row assignment, ADR-0033 D10). */
  excludedOrdinals: number[];
  /** The evidence projection — exact counts, bounded enumeration. `undefined` when the gate
   *  resolved NO clauses at all, so a deployment with nothing authored writes byte-identical
   *  evidence to pre-M22. */
  evidence: ScanExclusionEvidence | undefined;
}

/**
 * APPLY the resolved clauses to a scan's findings — BEFORE counting, never as a waiver on a verdict
 * (ADR-0033 §2).
 *
 * PURE, and the ONE place a clause meets a finding, so both verdict producers (the
 * `scan-result-control` plugin and the commander's own promotion scan step) can never diverge about
 * what an exclusion means.
 *
 * `record` is the finding set's own marker and it GATES EVERYTHING. Only `full` admits an exclusion:
 * `truncated`, `unsupported` and ABSENT each refuse EVERY exclusion for the scan, with the reason
 * stated positively in evidence. That is not defensive coding — it is the ADR-0033 §7 rule, and it
 * is why the per-scan cap keeping the first N findings in parse order is safe.
 *
 * FIRST MATCHING CLAUSE WINS for attribution. A finding is excluded once; which of two matching
 * clauses is named is decided by the clauses' own deterministic order, so two identical evaluations
 * attribute identically (the M22.0 write-suppression rule — nothing here may vary between two
 * evaluations of the same inputs).
 */
export function applyScanExclusions(
  findings: readonly ScanFinding[],
  effective: EffectiveScanExclusions | undefined,
  record: ScanFindingsRecord | undefined
): AppliedScanExclusions {
  const clauses = effective?.clauses ?? [];
  if (clauses.length === 0) {
    return { findings: [...findings], excludedOrdinals: [], evidence: undefined };
  }
  if (record !== "full") {
    const refused: ScanExclusionRefusal =
      record === "truncated"
        ? "truncated"
        : record === "unsupported"
          ? "unsupported"
          : "not_recorded";
    return {
      findings: [...findings],
      excludedOrdinals: [],
      evidence: { clauseCount: clauses.length, appliedCount: 0, applied: [], refused }
    };
  }

  const survivors: ScanFinding[] = [];
  const excludedOrdinals: number[] = [];
  const applied: AppliedScanExclusion[] = [];
  for (const [ordinal, finding] of findings.entries()) {
    const hit = clauses.find((c) => scanExclusionClauseMatches(c.clause, finding, effective));
    if (!hit) {
      survivors.push(finding);
      continue;
    }
    excludedOrdinals.push(ordinal);
    if (applied.length < SCAN_EXCLUSION_EVIDENCE_CAP) {
      // M22.6 — resolved through the SAME function the predicate used, so evidence can never name a
      // grant other than the one that actually decided this finding.
      const grant =
        hit.clause.class === "approved_override"
          ? scanOverrideGrantFor(effective?.approvedOverrides, finding)
          : undefined;
      applied.push({
        ordinal,
        severity: finding.severity,
        class: hit.clause.class,
        tier: hit.tier,
        source: hit.source,
        ...(finding.vulnerabilityId ? { vulnerabilityId: finding.vulnerabilityId } : {}),
        ...(finding.pkgName ? { pkgName: finding.pkgName } : {}),
        ...(hit.clause.reason ? { reason: hit.clause.reason } : {}),
        // M22.5 — the declared pair, verbatim. Taken from the CLAUSE rather than re-read from the
        // facts because the predicate already proved the two equal; the whole declared set travels
        // separately into the gate Decision's `inputContext`.
        ...(hit.clause.class === "declared_fact" && hit.clause.declaredFact !== undefined
          ? { declaredFact: hit.clause.declaredFact }
          : {}),
        ...(hit.clause.class === "declared_fact" && hit.clause.declaredValue !== undefined
          ? { declaredValue: hit.clause.declaredValue }
          : {}),
        ...(grant
          ? {
              grantObjectId: grant.grantObjectId,
              grantTierObjectId: grant.tierObjectId,
              grantExpiresAt: grant.expiresAt
            }
          : {})
      });
    }
  }
  return {
    findings: survivors,
    excludedOrdinals,
    evidence: {
      clauseCount: clauses.length,
      appliedCount: excludedOrdinals.length,
      applied
    }
  };
}

/**
 * The POST-EXCLUSION counts, derived from the counts the scanner actually produced MINUS one per
 * excluded finding.
 *
 * Deliberately a DELTA on `severityCounts` rather than a recount of the survivors. The survivor list
 * is the CAPPED set, so recounting it would silently report a truncated scan's numbers as smaller
 * than the scanner's own — while `severityCounts` is derived BEFORE the cap. A truncated set refuses
 * every exclusion, so the delta is zero there and the two counts stay identical, which is exactly
 * the property a recount would break.
 */
export function effectiveSeverityCountsAfterExclusions(
  counts: ScanSeverityCounts,
  applied: AppliedScanExclusions,
  findings: readonly ScanFinding[]
): ScanSeverityCounts {
  const out = { ...counts };
  for (const ordinal of applied.excludedOrdinals) {
    const finding = findings[ordinal];
    if (!finding) continue;
    out[finding.severity] = Math.max(0, out[finding.severity] - 1);
  }
  return out;
}

/**
 * The full evidence payload a `scan-result-control` outcome carries. Bound to a SPECIFIC artifact
 * digest (`artifactDigest` = the digest Trivy actually scanned; `expectedDigest` = the digest the
 * change is promoting): `digestMatch` is the ADR-0013 "nothing slipped in" check at the control
 * level — a verdict whose scanned digest does not match the change's artifact does NOT authorize the
 * change (the control returns `fail`, and this evidence records `digestMatch: false`).
 */
export const ScanEvidenceSchema = z.object({
  /** WHICH scan method produced this verdict. Widened from `z.literal("trivy")` to `ScanMethodSchema`
   *  (ADR-0020 §2 / proposal §13.3, 13.3a) — this was designed as a field "so a future second scanner
   *  slots in without a shape change", and `openscap` is that second scanner (`trivy-vm`, the
   *  machine-image arm, is the third). The widening is strictly
   *  ADDITIVE and GATE-INVISIBLE: `trivy` is still accepted, so every existing evidence document (and
   *  the E6 export gate's `ScanEvidenceSchema.safeParse`, promotion-repo.ts) parses byte-for-byte
   *  unchanged; the gate reads only `digestMatch`/`artifactDigest`, never `scanner`. */
  scanner: ScanMethodSchema,
  /** Trivy's own reported version (result JSON, best-effort) — `"unknown"` when the result omits it. */
  scannerVersion: z.string(),
  /** The artifact digest Trivy actually scanned, normalized to `sha256:<hex>` where derivable from
   *  the Trivy result's `Metadata.RepoDigests`/`Metadata.ImageID`; otherwise the raw reported ref. */
  artifactDigest: z.string(),
  /** The digest the change is promoting — the value `artifactDigest` was bound against. */
  expectedDigest: z.string(),
  /** True iff `artifactDigest` matches `expectedDigest` (the digest-binding guard). A `false` here
   *  is by itself sufficient for a `fail` outcome regardless of the vulnerability counts. */
  digestMatch: z.boolean(),
  severityCounts: ScanSeverityCountsSchema,
  /** M22.1b (ADR-0033 §7) — WHAT THE PERSISTED FINDING SET IS for this verdict: `full`, `truncated`
   *  at the per-scan cap, or `unsupported` because this scanner family carries no per-finding
   *  material at all (OpenSCAP). Written by the SERVER at persist time — the only party that knows
   *  what actually landed — never by the producing plugin.
   *
   *  Optional, so every pre-M22.1b evidence document still parses. ABSENT means no finding set was
   *  recorded, and a consumer must treat it exactly like `truncated`: refuse every exclusion. Only
   *  `full` admits one.
   *
   *  This is the MARKER, not the findings. The findings themselves are commander-local rows in
   *  `scan_findings` and deliberately never reach this document, because evidence is copied verbatim
   *  into the promotion bundle. */
  findingsRecord: ScanFindingsRecordSchema.optional(),
  /** M22.2 (ADR-0033 §2) — the counts the threshold was ACTUALLY compared against, AFTER exclusions.
   *
   *  `severityCounts` above is untouched and keeps meaning WHAT THE SCANNER FOUND, because operators
   *  author CEL conditions against `evidence.severityCounts.*` and redefining it post-exclusion would
   *  silently change the meaning of every rule already written. Those conditions stay STRICTER than
   *  the gate's own comparison — a divergence, but safe-signed, and documented here rather than
   *  discovered.
   *
   *  WRITTEN ONLY WHEN THE GATE RESOLVED AT LEAST ONE ADMITTED CLAUSE. With nothing authored this
   *  key is absent and the evidence document is byte-identical to pre-M22.2. */
  effectiveSeverityCounts: ScanSeverityCountsSchema.optional(),
  /** M22.2 — WHICH findings were excluded, under whose clause and at which tier — or the positive
   *  reason every exclusion was refused. Same absent-when-nothing-authored rule as above. */
  exclusions: ScanExclusionEvidenceSchema.optional(),
  /**
   * M22.7 (ADR-0033 §10) — THE ACTUATOR'S HANDLE: a content hash of the exclusion set the GATE
   * RESOLVED AND THREADED for this run.
   *
   * WHAT IT IS FOR. A control outcome is cached and treated as a historical fact
   * (`control-runner.ts`), so without this every grant is inert on any change whose gate has already
   * run — "a signal with no lever". The reconcile prewarm and the wave-boundary gate re-resolve the
   * set on every pass, hash it, and force a re-run when this recorded value differs. A grant approved
   * (or expired, or revoked) after a verdict was reached is therefore noticed exactly once, at the
   * next evaluation, rather than never.
   *
   * WHAT IT IS NOT. It is NOT a claim about what the producer *did* with the set — that is
   * {@link ScanExclusionEvidenceSchema} above, which records the applications and the refusals. It is
   * the label "this verdict was computed while THIS set was in force", written by the server, which
   * is the only party that knows what it threaded. Reading it as "the producer honoured these
   * clauses" would be exactly the inferred-provenance-label defect this codebase has already paid for
   * once.
   *
   * IT CARRIES NO TIMESTAMP AND NOTHING DERIVED FROM `now`. The digest is taken over the RESOLVED
   * SET — clause list, admitting tiers, and the stored facts (a grant's own `expiresAt` is a stored
   * value, not a clock reading). Hashing anything time-varying would make it differ on every tick and
   * re-run the control forever, re-creating the measured 1.44 GB/day write-amplification pattern in a
   * new sink.
   *
   * ABSENT when the gate resolved NO admitted clause, so a deployment with nothing authored writes a
   * byte-identical evidence document to pre-M22 — and absent on every run written before M22.7, which
   * the comparison treats as "not the current set" and re-runs once.
   */
  exclusionSetHash: z.string().optional(),
  /** The threshold ACTUALLY applied to reach this verdict (post-merge). */
  threshold: ScanThresholdSchema,
  /** M17.5 (ADR-0016) — WHERE the APPLIED ceilings actually came from, per severity. This is the
   *  honest label: the two sources are merged per-severity (tighter wins), so "the gate threaded a
   *  scoped floor" is NOT the same claim as "the scoped floor decided this verdict".
   *  `"config"` = the flat per-binding `config.threshold` supplied the applied (tightest) value;
   *  `"scoped"` = the gate-resolved six-tier merge did; `"default"` = neither source constrained
   *  that severity and the historical fail-closed default (0) applies. */
  thresholdSources: ScanThresholdSourceMapSchema.optional(),
  /** Summary of `thresholdSources`: `"config"`/`"scoped"` when every constrained severity was
   *  decided by that one source, `"mixed"` when both decided at least one severity each, and
   *  `"default"` when NEITHER source constrained anything and the applied ceilings are entirely the
   *  historical fail-closed default (0/0). Never reports `"scoped"` merely because a scoped floor
   *  was present, and never reports `"config"` merely because nothing was decided — see
   *  `thresholdSources`. Optional so every pre-M17.5 evidence document still parses. */
  thresholdSource: z.enum(["config", "scoped", "mixed", "default"]).optional(),
  /** M17.5 — every tier that contributed a ceiling to the merged threshold, so a blocked promotion's
   *  Decision can explain WHICH tier set the binding severity floor (charter principle 6). */
  thresholdContributors: z.array(ScanThresholdContributionSchema).optional(),
  /** M13.3b-ii — provenance + freshness of the scanner DB this verdict was produced against, so a
   *  Decision (and the status read) can explain "scanned with a stale/refreshed/operator-loaded DB".
   *  Only `fresh`/`warn` ever reach evidence (a `hard-fail`/`missing`/`corrupt` DB produces NO scan →
   *  no evidence → E6 refuses). All optional — a scan run before this increment, or with the baked
   *  fallback and no cache, simply omits them and still parses. Trivy-only (OpenSCAP uses SSG). */
  scanDbSource: ScanDbSourceSchema.optional(),
  scanDbAgeHours: z.number().nonnegative().optional(),
  scanDbStaleness: ScanDbStalenessClassSchema.optional(),
  scanDbThresholdFired: ScanDbThresholdFiredSchema.optional()
});
export type ScanEvidence = z.infer<typeof ScanEvidenceSchema>;

// -------------------------------------------------------------------------------------------
// M17.2 — BUILD-TIME SBOM, stored as a REFERENCE on the promotion (ADR-0015 §5).
//
// CHARTER — coordinate, not execute: SCP NEVER generates an SBOM and NEVER stores its BYTES. The
// EXECUTOR's coordinated Trivy pass emits the SBOM at BUILD time and cosign-signs it at ORIGIN; SCP
// persists only this reference — WHERE the document lives, WHAT it hashes to, and WHICH origin
// signature attests it. `scanner`/`scannerVersion`/`signatureRef` record WHO produced and signed it
// externally; none of them is a claim that SCP did anything.
//
// Why reference-only is FORCED, not a preference: SCP has no blob storage anywhere (no binary
// column in the schema, no multipart ingress, no object store) — every artifact in the system is
// already a string reference inside a jsonb column — and federation/promotion bundles are
// METADATA-ONLY by ADR-0009. Storing SBOM bytes would be a net-new storage subsystem AND would
// break the metadata-only bundle invariant. So: reference in, reference out.
//
// 2026-07-23 evolution (ADR-0020, "managed-scan-evidence"): this reference-only posture is evolved
// — narrowly — for evidence the commander's own `scp-managed-scan` promotion scan step produces.
// That evidence lands commander-resident in a Postgres-backed evidence store (still no blob
// storage, no new stateful service — a registry-shaped table, not bytes-out-to-Gitea) because the
// commander is that evidence's ORIGIN, not a cache of someone else's bytes. Org-pipeline SBOM/scan
// evidence above stays reference-only, unchanged; see ADR-0020 §3 and the merged proposal
// docs/proposals/airgap-cds-validate-promote.md §13.3.
//
// WHERE it is persisted: `changes.sourceRef.sbom` (the report body is persisted verbatim and becomes
// the change's canonical `sourceRef` — `coordination/webhook-processor.ts`). `source_ref` is jsonb,
// so this shape costs ZERO migration. HOW it arrives: the typed first-party report ingress
// (`POST /change-sources/{sourceKind}/report`, `ChangeReportRequestSchema.sbom`) — the only TYPED,
// SDK-generating ingress (charter principle 3), already PAT-authed and already carrying the
// artifact digest this SBOM describes.
//
// This shape is the M17.3 CONTRACT: the promotion manifest's artifact set reads these fields.
// -------------------------------------------------------------------------------------------

/** Reduce any digest reference to its bare lowercase sha256 hex — from `…@sha256:<hex>`,
 *  `sha256:<hex>`, or a bare 64-hex string. Returns `undefined` for anything without a sha256
 *  digest. Deliberately the SAME normalization `scan-result-control` applies to a Trivy result's
 *  digest, so an SBOM reference and a scan verdict for the SAME artifact compare equal. */
export function sbomDigestHex(ref: string): string | undefined {
  const prefixed = /sha256:([a-f0-9]{64})/i.exec(ref);
  if (prefixed?.[1]) return prefixed[1].toLowerCase();
  const bare = /^[a-f0-9]{64}$/i.exec(ref.trim());
  return bare ? bare[0].toLowerCase() : undefined;
}

/** Canonical `sha256:<lowercase-hex>` form of any accepted digest reference — `undefined` when the
 *  input carries no sha256 digest. Applied when the reference is LIFTED onto the change's canonical
 *  `sourceRef.sbom`, so what is persisted is always comparable byte-for-byte. */
export function normalizeSbomDigest(ref: string): string | undefined {
  const hex = sbomDigestHex(ref);
  return hex ? `sha256:${hex}` : undefined;
}

/**
 * A REFERENCE to a build-time SBOM. Never the document itself.
 *
 * `digest` is the SBOM DOCUMENT's own content digest (what the reader must verify the fetched bytes
 * hash to) — it is NOT the artifact digest; the artifact this SBOM describes is the change's own
 * `sourceRef.artifact_digest`, which travels alongside it on the same report.
 *
 * M10.6 `.strict()`: this is the field-level half of the M10.6 discipline (`ChangeReportRequestSchema`'s
 * own doc comment) — SCP has no column, no codec, and no route that stores SBOM bytes, and this is
 * what makes "no way to smuggle the document inside the reference" an ENFORCED refusal (400 naming
 * the unknown key) rather than a silent strip. A REFERENCE has a small, closed field set on
 * purpose; an SBOM DOCUMENT (e.g. a `document`/`bomFormat`/`components` field) is exactly what
 * `.strict()` now refuses.
 */
export const SbomRefSchema = z.strictObject({
  /** SBOM document format. Two, because these are the two cosign/Trivy actually emit. */
  format: z.enum(["cyclonedx", "spdx"]),
  /** The format's spec version as the producer reported it (e.g. `"1.5"`, `"SPDX-2.3"`). */
  specVersion: z.string().optional(),
  /** The SBOM DOCUMENT's content digest. Accepts `sha256:<hex>`, a bare 64-hex string, or a
   *  `<ref>@sha256:<hex>` form; normalized to `sha256:<lowercase-hex>` when persisted. */
  digest: z.string().refine((v) => sbomDigestHex(v) !== undefined, {
    message:
      "digest must carry a sha256 digest (sha256:<64-hex>, <ref>@sha256:<64-hex>, or bare 64-hex)"
  }),
  /** WHERE the document lives — an OCI referrer ref, registry URL, or artifact-store URI. SCP stores
   *  the string and never fetches it as part of persisting the reference. */
  location: z.string().min(1),
  /** Media type of the referenced document (e.g. `application/vnd.cyclonedx+json`). */
  mediaType: z.string().optional(),
  /** The EXECUTOR's ORIGIN cosign signature over the SBOM (a `.sig` ref / OCI referrer / Rekor
   *  entry). SCP NEVER signs the SBOM — it records which origin attestation exists so a downstream
   *  (air-gapped) verifier can check it against the producing domain's key. */
  signatureRef: z.string().optional(),
  /** WHICH external tool produced the SBOM (e.g. `"trivy"`). Not a claim SCP produced it. */
  scanner: z.string().optional(),
  /** That tool's reported version. */
  scannerVersion: z.string().optional(),
  /** When the producer emitted it (ISO-8601), as reported by the producer. */
  generatedAt: z.string().optional()
});
export type SbomRef = z.infer<typeof SbomRefSchema>;
