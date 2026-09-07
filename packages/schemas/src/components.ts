import { z } from "zod";
import {
  ChangeStageDependencyVerdictSchema,
  WaveTargetObservedSchema,
  type WaveTargetObserved
} from "./changes.js";
import {
  ExecutorCategorySchema,
  PipelineClassificationSchema,
  SourceMappingScopeSchema
} from "./executors.js";
import { ControlOutcomeStatusSchema } from "./governance.js";
import {
  SbomRefSchema,
  ScanMethodSchema,
  ScanSeverityCountsSchema,
  ScanThresholdSchema
} from "./supply-chain.js";
import { PromotionManifestSchema } from "./federation.js";

// COMPONENT PIPELINE (coordination-ui-views.md §2, as corrected 2026-08-03)

/** WHO MAINTAINS A PLACE. See docs/schemas.md §92. */
export const ComponentPipelineDomainSchema = z.object({
  domainId: z.string().uuid().nullable(),
  /** The domain's name, or null when the target's origin matches neither self nor any known peer —
   *  which is a real state on a replica whose peer row has not arrived, and must not render as
   *  "ours". */
  name: z.string().nullable(),
  /** Is this THIS instance's own domain? False means another domain maintains this place. */
  isSelf: z.boolean(),
  /** `commander` / `outpost` / `retrans` / `unset` — from `federation_self.role` or the peer's
   *  `role`. Null when the domain is unknown. */
  role: z.string().nullable()
});
export type ComponentPipelineDomain = z.infer<typeof ComponentPipelineDomainSchema>;

/** Which outpost a target is part of, by trust domain. See docs/schemas.md §93. */
export const ComponentPipelineTargetOutpostSchema = z.object({
  state: z.enum(["outpost", "self", "peer-without-outpost", "peer-not-outpost", "unknown-domain"]),
  /** The `outpost` object's id — `outpost` only. */
  id: z.string().uuid().nullable(),
  /** `outpost`: the object's name; `self`: this instance's name; `peer-without-outpost` /
   *  `peer-not-outpost`: the peer's name; `unknown-domain`: null. */
  name: z.string().nullable(),
  /** The outpost object's declared `trustTier`, verbatim when this build recognises it; else null. */
  trustTier: z.string().nullable(),
  /** The trust-domain id the state is about: the peer's id (`outpost`, `peer-without-outpost`,
   *  `peer-not-outpost`) or the raw unrecognised origin (`unknown-domain`); null for `self`. */
  peerDomainId: z.string().nullable(),
  /** The paired peer's federation ROLE. See docs/schemas.md §94. */
  peerRole: z.string().nullable()
});
export type ComponentPipelineTargetOutpost = z.infer<typeof ComponentPipelineTargetOutpostSchema>;

/** Which topology wave declares a stage, and where it sits in release order. */
export const ComponentPipelineWaveSchema = z.object({
  index: z.number().int(),
  name: z.string().nullable()
});

/** One executor binding at a stage — ONE PIPELINE. `type` is the ADR-0007 routing key (`image`,
 *  `infrastructure`, `configuration`, …), which is what distinguishes a build pipeline from an
 *  infra pipeline from a config-sync pipeline running at the same place. */
export const ComponentPipelineBindingSchema = z.object({
  externalRef: z.string().nullable(),
  type: z.string(),
  /** Where a HUMAN opens this — the Argo CD application, the GitHub Actions tab. Null when it
   *  cannot be KNOWN (no address on the execution system, or a ref nothing can be said about), and
   *  the client then renders an un-clickable node: a dead link in an operator console is a claim
   *  that something is over there. Never the REST base URL the executor is called on. */
  url: z.string().nullable(),
  /** DERIVED from `type` via `categoryOfType` (ADR-0007) — never stored. On the wire so a client
   *  groups pipelines into lanes without carrying its own copy of the Type→Category map, which is
   *  the duplication ADR-0007 kept out of the database in the first place. */
  category: ExecutorCategorySchema,
  executionSystemId: z.string().uuid().nullable(),
  executionSystemName: z.string().nullable(),
  /** WHERE the ladder found it (ADR-0027/0029). See docs/schemas.md §95. */
  resolvedVia: z.string().optional()
});
export type ComponentPipelineBinding = z.infer<typeof ComponentPipelineBindingSchema>;

/** The most recent change to touch a stage through ONE pipeline. `category` is which pipeline —
 *  from `change_wave_targets.type`, the routing Type the plan snapshotted for this target. */
export const ComponentPipelineCurrentSchema = z.object({
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  changeState: z.string().nullable(),
  waveName: z.string().nullable(),
  targetStatus: z.string().nullable(),
  type: z.string(),
  category: ExecutorCategorySchema,
  /** The same observed-state snapshot the wave target carries. See docs/schemas.md §96. */
  observed: WaveTargetObservedSchema.nullable().optional()
});
export type ComponentPipelineCurrent = z.infer<typeof ComponentPipelineCurrentSchema>;

/** THE SHARED VERSION-PREFERENCE RULE. See docs/schemas.md §97. */
export function realObservedImages(observed: WaveTargetObserved | null | undefined): string[] {
  const images = observed?.images;
  if (!images) return [];
  const entry = observed?.truncation?.images;
  if (typeof entry?.droppedEntries !== "number" || entry.droppedEntries <= 0) return images;
  return images.slice(0, -1);
}

export function preferredObservedVersion(
  observed: WaveTargetObserved | null | undefined
): string | undefined {
  return realObservedImages(observed)[0] ?? observed?.revision;
}

/** Where a component's releases come from: one mapping rule. See docs/schemas.md §98. */
export const ComponentPipelineSourceMappingSchema = z.object({
  id: z.string().uuid(),
  sourceKind: z.string(),
  repoPattern: z.string().nullable(),
  /** Path glob within the repo, or NULL meaning **the whole repo matches** — which is a much
   *  broader rule than it looks and must not render as an empty cell. Measured on the live estate:
   *  `agentkit-bootstrap` has such a mapping against all of `jag8765-personal/homelab-gitops`. */
  pathPattern: z.string().nullable(),
  /** Git ref glob, or NULL meaning **every branch matches** — the ref-side twin of the whole-repo
   *  case above, and just as broad: without it rendered, two mappings that route `dev` and `main`
   *  to different pipelines look identical in the UI (ADR-0030 §1). */
  refPattern: z.string().nullable(),
  type: z.string(),
  category: ExecutorCategorySchema,
  /** The operator's declared pipeline classification (ADR-0030 §2) — UI/reporting ONLY, never an
   *  enforcement input. Rendered as a label; it grants and withholds nothing. */
  classification: PipelineClassificationSchema.nullable(),
  /** DECLARED provenance (outpost-ui.md §9.3a): `true` = a local mirror of a commander-shared repo;
   *  `false` = domain-specific, tracked only in this domain. The source lane groups by it. Read,
   *  never inferred; never an enforcement input. */
  mirrorOfShared: z.boolean(),
  /** The operator's pause switch (migration 0063) — `false` means this source tile is declared but
   *  `matchComponentForSource` skips it, so a push that matches its repo/path/ref routes nowhere.
   *  This is what lets the UI give each source its own enable/disable, not just its own arrow. */
  enabled: z.boolean(),
  /** Timed close bound, or null; and the read-time truth the matcher acts on. The arrow is
   *  painted from `effectivelyEnabled`, never from `enabled` alone. */
  disabledUntil: z.string().datetime().nullable(),
  effectivelyEnabled: z.boolean(),
  /** The repo's web page, or null when it cannot be known — a GLOBBED `repoPattern` names a set of
   *  repos rather than a page, and a self-hosted provider's host is not recorded on a mapping. */
  url: z.string().nullable(),
  /** DECLARED reach (§10.6, migration 0066). See docs/schemas.md §99. */
  scope: SourceMappingScopeSchema.nullable()
});
export type ComponentPipelineSourceMapping = z.infer<typeof ComponentPipelineSourceMappingSchema>;

/** WHAT MUST PASS BEFORE A RELEASE MOVES INTO A STAGE. See docs/schemas.md §100. */
/** One automated check a policy requires, and its progress. See docs/schemas.md §101. */
export const ComponentPipelineCheckSchema = z.object({
  controlId: z.string(),
  /** The control object's name, or null when the reference dangles — which is worth seeing rather
   *  than silently dropping, since a policy requiring a control that no longer exists blocks. */
  name: z.string().nullable(),
  status: z.enum([
    "not_started",
    "pending",
    "pass",
    "fail",
    "warning",
    "skipped",
    "timed_out",
    "expired"
  ]),
  changeId: z.string().uuid().nullable()
});
export type ComponentPipelineCheck = z.infer<typeof ComponentPipelineCheckSchema>;

export const ComponentPipelineGateSchema = z.object({
  /** Every effective policy governing entry to this stage, stricter-wins-merged. Empty means
   *  nothing gates it — a real state, and different from "we did not look". */
  policies: z.array(
    z.object({
      name: z.string(),
      enforcement: z.enum(["advisory", "recommended", "required"]),
      /** Automated checks that must pass — the TESTS. Measured 2026-08-10: every live policy has
       *  this EMPTY, and the estate holds 0 control bindings and 0 control runs. So a component
       *  showing no required checks is reporting the truth about its configuration, not a gap in
       *  this projection. */
      requireControls: z.array(z.string()),
      /** Human sign-off required before the release may enter. */
      requireApprovals: z.array(
        z.object({ count: z.number().int(), fromRole: z.string(), scope: z.string() })
      )
    })
  ),
  /** Every control the policies above require, de-duplicated, each with its current outcome. Empty
   *  when no policy asks for one — measured 2026-08-10, that is EVERY policy on the live estate
   *  (0 control bindings, 0 control runs), so this array being empty is a fact about the estate's
   *  configuration and not a limit of this projection. */
  checks: z.array(ComponentPipelineCheckSchema)
});
export type ComponentPipelineGate = z.infer<typeof ComponentPipelineGateSchema>;

/** WHY A RELEASE IS SITTING AT THIS STAGE WITHOUT MOVING. See docs/schemas.md §102. */
export const ComponentPipelineHoldSchema = z.object({
  /** The release being withheld. It is one of this stage's `currents[]` entries — a client shows the
   *  hold against the lane whose `current` this is, since a change can hold the `configuration`
   *  target at a place while the `infrastructure` pipeline there is simply idle. */
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  /** The wave being worked when the hold was evaluated — the first not `succeeded`/`skipped`. Null
   *  only when the change has no plan, which a held target cannot come from. */
  waveIndex: z.number().int().nullable(),
  /** ONLY THE UNSATISFIED verdicts, each naming the dependency, the ADR-0028 decision 4 branch that
   *  applied and a one-line summary — the same `describeStageDependencyHold` sentence the hold
   *  Decision's `reasonTree` is built from, so this view and the audit record cannot drift. Never
   *  empty: a hold with nothing unsatisfied is not a hold, and is reported as null above. */
  dependencies: z.array(ChangeStageDependencyVerdictSchema)
});
export type ComponentPipelineHold = z.infer<typeof ComponentPipelineHoldSchema>;

/** ONE STAGE THE COMPONENT IS PLACED AT — one `placement`. See docs/schemas.md §103. */
export const ComponentPipelineStageSchema = z.object({
  placement: z.object({ id: z.string().uuid(), urn: z.string() }),
  /** Position in the whole journey, shared with `unplacedStages`: concatenate both arrays and sort
   *  by this to get the pipeline in release order. Contiguous from 0 across the union, so the client
   *  never has to infer an interleaving. */
  order: z.number().int(),
  /** Which topology wave declares this stage. Null when the component is placed at a target NO wave
   *  names — real state, kept rather than hidden behind a document's omission — and null throughout
   *  when `stageSource` is `placements`. */
  wave: ComponentPipelineWaveSchema.nullable(),
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    /** ADR-0026 D1 — present only on a place-role target; without it no stage name derives. */
    environment: z.string().nullable(),
    region: z.string().nullable(),
    /** THE SUBSTRATE FACET. See docs/schemas.md §104. */
    substrate: z.string().nullable(),
    /** Provider account / project / subscription id. Same reading rules as `substrate`. */
    account: z.string().nullable(),
    /** Cluster name inside that account/region. Same reading rules as `substrate`. */
    cluster: z.string().nullable()
  }),
  maintainedBy: ComponentPipelineDomainSchema,
  /** WHICH OUTPOST this place is part of — see `ComponentPipelineTargetOutpostSchema` (§10.2).
   *  Required: the server always resolves it (a state, never an omission), and a required additive
   *  response property is the class #222 measured oasdiff accepts. */
  outpost: ComponentPipelineTargetOutpostSchema,
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1). Null when the target carries no
   *  `environment`: not every deployment-target is a stage, and inventing a name would be a lie. */
  stageName: z.string().nullable(),
  /** ONE of this stage's pipelines. See docs/schemas.md §105. */
  binding: ComponentPipelineBindingSchema.nullable(),
  /** EVERY PIPELINE BOUND AT THIS STAGE, ordered by Type. See docs/schemas.md §106. */
  bindings: z.array(ComponentPipelineBindingSchema),
  /** The most recent change to touch this stage IN ANY pipeline — see `currents`. Retained because
   *  `/v1` is additive-only; it is the newest entry of `currents`. Rendering it against a particular
   *  pipeline would attribute one pipeline's release to another. **Read `currents`.** */
  current: ComponentPipelineCurrentSchema.nullable(),
  /** THE MOST RECENT CHANGE PER PIPELINE. See docs/schemas.md §107. */
  currents: z.array(ComponentPipelineCurrentSchema),
  /** WHAT MUST PASS to move a release INTO this stage — see `ComponentPipelineGateSchema`. */
  gate: ComponentPipelineGateSchema,
  /** WHAT IS WITHHOLDING THIS STAGE'S RELEASE RIGHT NOW. See docs/schemas.md §108. */
  hold: ComponentPipelineHoldSchema.nullable().optional(),
  /** The version staircase the design asks for. See docs/schemas.md §109. */
  version: z.string().nullable(),
  /** Dotted paths on THIS stage whose values are not observations. See `version`. */
  unknownFields: z.array(z.string())
});
export type ComponentPipelineStage = z.infer<typeof ComponentPipelineStageSchema>;

/** A DECLARED STAGE THE COMPONENT NEVER REACHES. See docs/schemas.md §110. */
export const ComponentPipelineUnplacedStageSchema = z.object({
  order: z.number().int(),
  /** Never null: an unplaced stage exists ONLY because a wave declares it. */
  wave: ComponentPipelineWaveSchema,
  deploymentTarget: z.object({
    id: z.string().uuid(),
    name: z.string(),
    environment: z.string().nullable(),
    region: z.string().nullable(),
    /** The substrate facet — same fields, same reading rules as `ComponentPipelineStageSchema
     *  .deploymentTarget`: the server builds ONE literal and pushes it into both arrays, so the two
     *  shapes must not drift. */
    substrate: z.string().nullable(),
    account: z.string().nullable(),
    cluster: z.string().nullable()
  }),
  /** WHOSE DOMAIN maintains this place. A stage this component never reaches is still somebody's to
   *  run, and saying so is what stops "not placed" reading as "nowhere". */
  maintainedBy: ComponentPipelineDomainSchema,
  /** WHICH OUTPOST this place is part of — the SAME literal the server pushes into `stages[]`
   *  (`ComponentPipelineTargetOutpostSchema`, §10.2); the two shapes must not drift. */
  outpost: ComponentPipelineTargetOutpostSchema,
  /** `<origin domain>-[<region>-]<environment>` (ADR-0026 D1), derived exactly as for a placed
   *  stage — the name is a property of the PLACE, not of this component being at it. */
  stageName: z.string().nullable()
});
export type ComponentPipelineUnplacedStage = z.infer<typeof ComponentPipelineUnplacedStageSchema>;

/** THE REGISTRY THIS COMPONENT PUBLISHES TO, AT THIS SITE. See docs/schemas.md §111. */
export const ComponentPipelineRegistrySchema = z.object({
  state: z.enum(["declared", "ambiguous", "none"]),
  /** The execution-system object's id (`declared` only). */
  executionSystemId: z.string().uuid().nullable(),
  /** Its `name` — READ from the object, never from the component. */
  name: z.string().nullable(),
  /** Its `properties.kind` (`gitea`, `harbor`, `ecr`, …) when it is a string; null otherwise. */
  kind: z.string().nullable(),
  /** Console base — `webUrl`, else `serverUrl`, trailing slash trimmed (`executionSystemConsoleBase`).
   *  Base only: no registry has a known deep-link shape here, and a guessed path is a lie. */
  url: z.string().nullable(),
  /** The edge's own `properties.repository` (the repository/path inside the registry, e.g.
   *  `acme/checkout-api`) when it is a string; null otherwise. */
  repository: z.string().nullable(),
  /** How many `publishes_to` edges the component has here — 0, 1, or the count behind `ambiguous`. */
  edgeCount: z.number().int()
});
export type ComponentPipelineRegistry = z.infer<typeof ComponentPipelineRegistrySchema>;

/** ONE SCAN VERDICT over ONE artifact digest. See docs/schemas.md §112. */
export const ComponentPipelineScanRunSummarySchema = z.object({
  /** The scan METHOD (`trivy` / `trivy-vm` / `openscap`) — the managed step's `gateRef.method`
   *  when the run carries one, else the evidence's own `scanner`. */
  method: z.string(),
  scanner: ScanMethodSchema,
  scannerVersion: z.string(),
  digest: z.string(),
  /** `evidence.digestMatch` — true iff the scanned digest equals the promoted one. Null only if
   *  the evidence omitted it (the schema requires it, so today never — kept nullable for an older
   *  evidence document). */
  digestMatch: z.boolean().nullable(),
  status: ControlOutcomeStatusSchema,
  counts: ScanSeverityCountsSchema.nullable(),
  /** The threshold the verdict was evaluated against, verbatim; null when the evidence omitted it. */
  threshold: ScanThresholdSchema.nullable(),
  /** The control run's `created_at` — when the verdict was recorded here. */
  evaluatedAt: z.string().datetime(),
  controlRunId: z.string().uuid(),
  managed: z.boolean()
});
export type ComponentPipelineScanRunSummary = z.infer<typeof ComponentPipelineScanRunSummarySchema>;

/** One export of this change to one peer, as stamped. See docs/schemas.md §113. */
export const ComponentPipelinePromotionExportSchema = z.object({
  peerDomainId: z.string(),
  /** The peer's `name` when a `federation_peers` row still exists for it here; null otherwise. */
  peerName: z.string().nullable(),
  exportedAt: z.string(),
  /** The Ed25519 bundle checksum — the same value `boundaryBundleChecksums[]` carries. */
  checksum: z.string(),
  manifest: PromotionManifestSchema,
  manifestSignature: z.string(),
  /** SHA-256 hex of the signing instance's cosign public-key PEM; null on a stamp written before
   *  the fingerprint was recorded. */
  keyFingerprint: z.string().nullable()
});
export type ComponentPipelinePromotionExport = z.infer<
  typeof ComponentPipelinePromotionExportSchema
>;

/** THE IMPORTED PROMOTION MANIFEST. See docs/schemas.md §114. */
export const ComponentPipelineImportedManifestSchema = z.object({
  manifest: PromotionManifestSchema,
  manifestSignature: z.string(),
  exporterDomainId: z.string(),
  exporterName: z.string().nullable(),
  importedFromDomain: z.string().nullable(),
  artifactCount: z.number().int().nonnegative()
});
export type ComponentPipelineImportedManifest = z.infer<
  typeof ComponentPipelineImportedManifestSchema
>;

/** The artifact this pipeline is about, and its facts. See docs/schemas.md §115. */
export const ComponentPipelineArtifactSchema = z.object({
  changeId: z.string().uuid(),
  changeName: z.string().nullable(),
  changeCreatedAt: z.string().datetime(),
  digests: z.array(z.string()),
  sbom: SbomRefSchema.nullable(),
  scans: z.array(ComponentPipelineScanRunSummarySchema),
  exportGate: z.enum(["pass", "fail", "not_run"]),
  signing: z.object({
    promotionExports: z.array(ComponentPipelinePromotionExportSchema),
    originSignatureRefs: z.array(z.string()),
    importedManifest: ComponentPipelineImportedManifestSchema.nullable().optional()
  }),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineArtifact = z.infer<typeof ComponentPipelineArtifactSchema>;

/** Which rung supplied the pipeline — the answer to "why does this component release this way?"
 *  (charter principle 6). `pipeline-resolution.ts` computes it; surfacing it here is what stops an
 *  inheritance surprise (someone attaches a topology to a SERVICE and every component changes). */
export const ComponentPipelineSourceSchema = z.object({
  topologyObjectId: z.string().uuid(),
  topologyName: z.string().nullable(),
  topologyVersion: z.number().int().nullable(),
  rung: z.enum(["component", "service", "organization"]),
  attachedToObjectId: z.string().uuid(),
  attachedToName: z.string().nullable()
});
export type ComponentPipelineSource = z.infer<typeof ComponentPipelineSourceSchema>;

/** THE OBSERVED CI RUN a change names. See docs/schemas.md §116. */
export const ComponentPipelineObservedRunSchema = z.object({
  sourceKind: z.string(),
  repo: z.string().nullable(),
  runId: z.string(),
  workflowName: z.string().nullable(),
  workflowPath: z.string().nullable(),
  url: z.string().nullable(),
  observedAt: z.string().datetime(),
  changeId: z.string().uuid()
});
export type ComponentPipelineObservedRun = z.infer<typeof ComponentPipelineObservedRunSchema>;

/** The deployment-target a correlated infrastructure change was matched THROUGH — null for a
 *  coupling-only match, which names no place at all (owner decision, 2026-08-24). */
export const ComponentPipelineCorrelatedInfraTargetSchema = z.object({
  objectId: z.string().uuid(),
  name: z.string().nullable()
});

/** ONE infrastructure change correlated to this component. See docs/schemas.md §117. */
export const ComponentPipelineCorrelatedInfraChangeSchema = z.object({
  changeObjectId: z.string().uuid(),
  name: z.string().nullable(),
  state: z.string(),
  type: z.string(),
  createdAt: z.string().datetime(),
  correlatedVia: z.object({
    route: z.enum(["placement", "hosted_on", "coupling"]),
    target: ComponentPipelineCorrelatedInfraTargetSchema.nullable()
  }),
  /** The `provides`/`requires` key this change satisfies for this component, or null when the
   *  match carries no coupling (a placement/hosted_on-only match). A `placement`/`hosted_on` match
   *  MAY still carry one, when both arms independently correlate the same change. */
  coupledKey: z.string().nullable()
});
export type ComponentPipelineCorrelatedInfraChange = z.infer<
  typeof ComponentPipelineCorrelatedInfraChangeSchema
>;

/** THE CORRELATED-INFRASTRUCTURE LANE. See docs/schemas.md §118. */
export const ComponentPipelineCorrelatedInfraSchema = z.object({
  changes: z.array(ComponentPipelineCorrelatedInfraChangeSchema)
});
export type ComponentPipelineCorrelatedInfra = z.infer<
  typeof ComponentPipelineCorrelatedInfraSchema
>;

/** A component's pipeline. See docs/schemas.md §119. */
export const ComponentPipelineResponseSchema = z.object({
  component: z.object({
    id: z.string().uuid(),
    urn: z.string(),
    name: z.string(),
    /** WHO MAINTAINS THIS COMPONENT (outpost-ui.md §9.3a) — same shape as a stage's `maintainedBy`.
     *  `isSelf: false` on an outpost means the commander (or another peer) is UPSTREAM of this
     *  domain's repos in the source lane; `isSelf: true` means this domain authored it. */
    maintainedBy: ComponentPipelineDomainSchema,
    /** ADR-0031 — a domain-local component has NO upstream: its repo is the source, and no
     *  commander appears ahead of it. Structurally consistent with `maintainedBy.isSelf` (a
     *  domain-local object never journaled, so it is always self-maintained). */
    domainLocal: z.boolean()
  }),
  /** Null when no rung supplies one — the component releases as a single anonymous wave. */
  pipeline: ComponentPipelineSourceSchema.nullable(),
  /** Where the journey came from, which decides how to read. See docs/schemas.md §120. */
  stageSource: z.enum(["topology", "placements"]),
  /** EVERY source rule that feeds this component — the head of its journey. Empty means no push to
   *  any repo can ever release this component, which is the source-side twin of an unplaced stage
   *  and just as worth saying out loud. */
  sources: z.array(ComponentPipelineSourceMappingSchema),
  /** The stages the component IS placed at. Ordered by `order`, which interleaves with
   *  `unplacedStages`. Includes any place it is placed at that no wave names — never dropped, since
   *  that would hide real state behind a document's omission. */
  stages: z.array(ComponentPipelineStageSchema),
  /** The declared stages it is NOT placed at. See docs/schemas.md §121. */
  unplacedStages: z.array(ComponentPipelineUnplacedStageSchema),
  /** THE REGISTRY at this site — see `ComponentPipelineRegistrySchema`. Optional on the wire because
   *  `/v1` is additive-only and this shipped after the response did; a server that emits it always
   *  emits an object (`state: "none"` is a value, not an omission). Null/absent = an older server. */
  registry: ComponentPipelineRegistrySchema.nullable().optional(),
  /** THE ARTIFACT and its change-scoped facts — see `ComponentPipelineArtifactSchema`. Optional on
   *  the wire (additive-only `/v1`); a server that emits it sends an object or `null` (null = no
   *  change of this component carries an artifact digest — "no artifact yet"). Absent = an older
   *  server. */
  artifact: ComponentPipelineArtifactSchema.nullable().optional(),
  /** THE OBSERVED CI RUN. See docs/schemas.md §122. */
  observedRun: ComponentPipelineObservedRunSchema.nullable().optional(),
  /** THE CORRELATED-INFRASTRUCTURE LANE. See docs/schemas.md §123. */
  correlatedInfra: ComponentPipelineCorrelatedInfraSchema.nullable().optional(),
  unknownFields: z.array(z.string())
});
export type ComponentPipelineResponse = z.infer<typeof ComponentPipelineResponseSchema>;
