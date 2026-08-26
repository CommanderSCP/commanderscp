import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";
import {
  ScanFindingRetentionClassSchema,
  ScanFindingSchema,
  ScanFindingsRecordSchema
} from "./supply-chain.js";

/**
 * M4 Governance Engine wire contract (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Policies and
 * Controls themselves are ordinary graph objects (typed-registry resources — `GraphObjectSchema`
 * already covers them, same as `release-topology`); this file only carries the projection-table
 * resources that have no graph-object equivalent: control run evidence, approval quorum, and
 * freezes.
 */

export const ControlOutcomeStatusSchema = z.enum([
  "pass",
  "fail",
  "warning",
  "skipped",
  "timed_out",
  "expired"
]);
export type ControlOutcomeStatus = z.infer<typeof ControlOutcomeStatusSchema>;

export const ControlRunSchema = z.object({
  id: z.string().uuid(),
  controlObjectId: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  status: ControlOutcomeStatusSchema,
  evidence: z.record(z.string(), z.unknown()),
  detail: z.string().nullable(),
  decisionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  /**
   * M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED. Both columns have existed on `control_runs`
   * since M4; neither has ever been projected onto the wire.
   *
   * That was survivable while a change had at most ONE run per control: `latestControlRun` was keyed
   * `(orgId, changeObjectId, controlObjectId)`, so the single row WAS the change's answer and naming
   * the crossing added nothing. M22.0a changed that — the cache key now carries gate identity, so a
   * change legitimately carries a run per crossing (the `validating -> accepted` lifecycle edge, then
   * one per wave boundary), and M22.7 adds forced re-runs on top. An operator reading
   * `GET /changes/{id}/control-runs` today sees several rows with the same control and status and no
   * way to tell which one let production through.
   *
   * OPTIONAL ON THE WIRE, NOT NULLABLE, and the distinction is the oasdiff rule this repo has
   * already paid for once: making an EXISTING required response field optional is a breaking change,
   * so these are added as new optional fields beside the required ones rather than by re-shaping
   * anything. The columns are `NOT NULL`, so a live server always sends them; the optionality exists
   * for older generated clients, never as a licence to omit them.
   */
  gateKind: z.enum(["lifecycle_edge", "wave_boundary"]).optional(),
  /** `{fromState,toState}` for a lifecycle edge, `{waveIndex,topologyObjectId}` for a wave boundary.
   *  Free-form on purpose: it is the gate's own identity object, and pinning a closed union here
   *  would make adding a third gate kind a wire-breaking change. */
  gateRef: z.record(z.string(), z.unknown()).optional()
});
export type ControlRun = z.infer<typeof ControlRunSchema>;
export const ControlRunListResponseSchema = cursorPageResponseSchema(ControlRunSchema);
export type ControlRunListResponse = z.infer<typeof ControlRunListResponseSchema>;

export const ControlRunIdParamSchema = z.object({ id: z.string().uuid() });
export type ControlRunIdParam = z.infer<typeof ControlRunIdParamSchema>;

/** M22.9 — one `scan_findings` row on the wire. `ScanFindingSchema` unchanged (it is what the parser
 *  produced and what an exclusion clause matches on) plus the two things only the WRITE knows:
 *  `ordinal`, which is the finding's identity because it has no other one, and the ADR-0024 §D1
 *  retention class the row was written at. */
export const PersistedScanFindingSchema = ScanFindingSchema.extend({
  ordinal: z.number().int().nonnegative(),
  /** `E` = an EXCLUDED finding, i.e. accepted-risk evidence recording what an operator chose to
   *  tolerate; `O` = ordinary telemetry. Projected because past `SCAN_EXCLUSION_EVIDENCE_CAP` (100)
   *  the run's `evidence.exclusions.applied` list stops enumerating and only these rows still say
   *  WHICH findings were tolerated (ADR-0033 D10, charter principle 6). */
  retentionClass: ScanFindingRetentionClassSchema
});
export type PersistedScanFinding = z.infer<typeof PersistedScanFindingSchema>;

/**
 * M22.9 — `GET /control-runs/{id}/findings`.
 *
 * `findingsRecord` IS REQUIRED AND NULLABLE, and that is the whole contract, not a style choice.
 * Every marker state except `full` — `truncated`, `unsupported`, and ABSENT — refuses every
 * exclusion for that scan ("you cannot except what you did not record", ADR-0033 §7), so a response
 * that hands back a bare array is one a consumer can use without ever learning that the set it is
 * looking at is not the set the scanner produced. Required-and-nullable rather than optional so
 * `null` POSITIVELY says "no marker was recorded"; an omitted optional field would be
 * indistinguishable from a client too old to know the key, which is the ambiguity this field exists
 * to remove.
 */
export const ControlRunFindingsResponseSchema = cursorPageResponseSchema(
  PersistedScanFindingSchema
).extend({
  findingsRecord: ScanFindingsRecordSchema.nullable()
});
export type ControlRunFindingsResponse = z.infer<typeof ControlRunFindingsResponseSchema>;

/** `POST /controls/{idOrUrn}/bindings` — binds a Control graph object to a ControlPlugin instance
 *  (DESIGN §10.2: "ControlPlugin implementations are bindings"). */
export const CreateControlBindingRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional()
});
export type CreateControlBindingRequest = z.infer<typeof CreateControlBindingRequestSchema>;

export const ControlBindingSchema = z.object({
  id: z.string().uuid(),
  controlObjectId: z.string().uuid(),
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown()
});
export type ControlBinding = z.infer<typeof ControlBindingSchema>;

// -------------------------------------------------------------------------------------------
// Approvals (DESIGN §10.2 — N-of-M quorum)
// -------------------------------------------------------------------------------------------

export const ApprovalRequestStatusSchema = z.enum(["pending", "satisfied"]);

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  changeObjectId: z.string().uuid(),
  policyObjectId: z.string().uuid(),
  policyVersion: z.number().int(),
  effectIndex: z.number().int(),
  requiredCount: z.number().int(),
  fromRole: z.string(),
  scopeObjectId: z.string().uuid(),
  status: ApprovalRequestStatusSchema,
  createdAt: z.string().datetime(),
  satisfiedAt: z.string().datetime().nullable(),
  voteCount: z.number().int()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalRequestListQuerySchema = CursorPageQuerySchema.extend({
  changeId: z.string().optional()
});
export type ApprovalRequestListQuery = z.infer<typeof ApprovalRequestListQuerySchema>;
export const ApprovalRequestListResponseSchema = cursorPageResponseSchema(ApprovalRequestSchema);
export type ApprovalRequestListResponse = z.infer<typeof ApprovalRequestListResponseSchema>;

export const ApprovalIdParamSchema = z.object({ id: z.string().uuid() });

export const AttestationSchema = z.object({
  record: z.object({
    approverSubjectId: z.string(),
    approverIdpSubject: z.string().nullable(),
    approvedObjectUrn: z.string(),
    approvedObjectContentHash: z.string(),
    decisionId: z.string().uuid().nullable(),
    timestamp: z.string().datetime()
  }),
  signature: z.string(),
  publicKey: z.string()
});
export type Attestation = z.infer<typeof AttestationSchema>;

export const ApprovalVoteSchema = z.object({
  id: z.string().uuid(),
  approvalRequestId: z.string().uuid(),
  voterObjectId: z.string().uuid(),
  decisionId: z.string().uuid().nullable(),
  attestation: AttestationSchema,
  votedAt: z.string().datetime()
});
export type ApprovalVote = z.infer<typeof ApprovalVoteSchema>;

/** `POST /approvals/{id}/votes` — no body beyond an optional IdP-subject hint (attestation
 *  richness); the voter is always the authenticated caller — you can never cast a vote on
 *  someone else's behalf. */
export const CastApprovalVoteRequestSchema = z.object({
  voterIdpSubject: z.string().optional()
});
export type CastApprovalVoteRequest = z.infer<typeof CastApprovalVoteRequestSchema>;

// -------------------------------------------------------------------------------------------
// Freezes (DESIGN §10.3)
// -------------------------------------------------------------------------------------------

export const FreezeSchema = z.object({
  id: z.string().uuid(),
  scopeObjectId: z.string().uuid(),
  name: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string(),
  createdByActorId: z.string().uuid(),
  createdAt: z.string().datetime(),
  /** M25.2 / owner decision D5 — does this freeze park the WHOLE wave, or only the targets it
   *  covers? `false` (the default) is per-target admission: a freeze over one region holds that
   *  region and its siblings ship. `true` restores pre-M25.2 all-or-nothing behaviour, for the
   *  coupled case where half-applied is worse than not-applied.
   *
   *  A REQUIRED response property, which is additive and oasdiff-safe (the standing rule is never
   *  to make an EXISTING required field optional). Required rather than optional deliberately: the
   *  column is `NOT NULL DEFAULT false`, so every row has an answer, and an operator asking "will
   *  this freeze stop the whole release?" must not have to distinguish absent from false. */
  atomic: z.boolean(),
  /** M25.1 — when this freeze was RETRACTED, or `null` while it still stands. A lifted freeze is
   *  no longer in force whatever `endsAt` says, and it is still returned by `GET /freezes/{id}` and
   *  `GET /freezes` FOREVER: a `gate`/`freeze_admission` Decision cites `freeze.id` in its
   *  `inputContext`, and "what was this freeze that blocked me?" must stay answerable (charter
   *  principle 6). LIFTED IS A FIELD, NOT AN ABSENCE — read it, don't infer it from a 404.
   *
   *  REQUIRED AND NULLABLE, exactly like `name` above: every row has an answer to "was this
   *  retracted", and `null` is that answer for the overwhelming majority. Adding a required
   *  response property is additive and oasdiff-safe (the rule is never to make an EXISTING required
   *  field optional). */
  liftedAt: z.string().datetime().nullable(),
  /** The actor object that lifted it, or `null`. */
  liftedByActorId: z.string().uuid().nullable(),
  /** Why it was lifted — mandatory and non-empty whenever `liftedAt` is set, `null` otherwise. A
   *  lift is a governance LOOSENING that applies to everyone at once; `freeze:override` already
   *  refuses to bypass a freeze for a single change without a reason, and retracting one outright
   *  cannot be held to a lower standard. */
  liftReason: z.string().nullable(),
  /** M25.7 / owner decision D6 — the id of this freeze's `freeze` GRAPH OBJECT, or `null` when this
   *  freeze does not federate (the default, and every freeze authored before M25.7).
   *
   *  READ, NEVER INFERRED. A client must not compute "does this federate?" from anything else —
   *  not from the presence of a peer, not from the actor's permissions. This is the column
   *  `governance/freeze-object.ts` writes, and it is also what tells an operator staring at a
   *  freeze on an OUTPOST whether it is one they can lift: a non-null `objectId` on a freeze whose
   *  object is a read-only replica means `DELETE`/`PATCH` will refuse with a 409 and the remedy is
   *  `freeze:override`.
   *
   *  REQUIRED AND NULLABLE, exactly like `liftedAt` and `name`: every row has an answer, and adding
   *  a required response property is additive and oasdiff-safe (the standing rule is never to make
   *  an EXISTING required field optional). */
  objectId: z.string().uuid().nullable()
});
export type Freeze = z.infer<typeof FreezeSchema>;

export const CreateFreezeRequestSchema = z.object({
  scopeObjectId: z.string().min(1), // id or URN — resolved server-side
  name: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1),
  /** M25.2 / owner decision D5 — opt this freeze OUT of per-target admission (see `FreezeSchema`).
   *
   *  OPTIONAL, defaulting to `false` server-side, which is a request widening and therefore
   *  oasdiff-safe. It exists because D5 is a change that newly PERMITS and applies RETROACTIVELY to
   *  every freeze already authored: the day per-target admission ships, an operator who freezes a
   *  service during an incident gets three quarters of a release instead of none. `atomic: true` is
   *  the escape hatch that decision was taken on the strength of, so it ships in the SAME increment
   *  as the loosening rather than in the one after it — a mitigation that lands later is a window
   *  in which the mitigation does not exist. */
  atomic: z.boolean().optional(),
  /** M25.7 / owner decision D6 (ADR-0043) — ALSO GIVE THIS FREEZE A GRAPH OBJECT, so it rides the
   *  federation journal to this org's peers and BLOCKS there too.
   *
   *  DEFAULTS TO `false`, AND THAT IS THE POINT. Federation is a new REACH — a freeze declared here
   *  becomes a freeze that stops releases in another security domain — and a new reach never
   *  defaults on. Omitted, the request is byte-identical to a pre-M25.7 one and so is everything
   *  that happens to it.
   *
   *  GATED ON `federation:write`, NOT `freeze:write`. Declaring a freeze that binds another security
   *  domain is categorically different from describing your own estate; ADR-0022 drew exactly this
   *  line for commander-authored outpost config and this is the same act. `freeze:write` at the
   *  freeze's own scope is still required as well — this permission is added, never substituted.
   *  The same pair is demanded on `DELETE` and `PATCH` for any freeze that HAS an object, because
   *  both verbs re-publish it: extending or lifting a federating freeze reaches the other domain
   *  just as declaring it did.
   *
   *  IT REACHES `full`-SCOPE PEERS ONLY, AND THE DROP IS SILENT (ADR-0043 §5a). A federating freeze
   *  rides an `object_upsert`, and `federation/scope-filter.ts` admits that entry kind under `full`
   *  and under `changes_only` — the latter only for `typeId: "change"`, which this is not. A peer
   *  paired `policies_only`, `changes_only`, `status_only`, or with a non-empty `custom` label
   *  selector (a freeze object carries no labels) never receives it; the export filter records
   *  nothing and the receiver never sees it, so NEITHER instance can report that the freeze was
   *  withheld and this request still answers 201. Scope is evaluated per bundle at EXPORT time, so
   *  re-scoping a peer later changes the answer for freezes already authored. Read
   *  `GET /v1/federation/peers`' `syncScope` before relying on a freeze reaching a given outpost.
   *
   *  A PLATFORM-TIER FREEZE HAS NO EQUIVALENT AND CANNOT. `POST /v1/instance/freezes` carries no
   *  such field: the sync journal is org-scoped at every layer and `instance_freezes` has no
   *  `org_id`. See ADR-0040 and GLOSSARY's "platform-tier freeze". */
  federate: z.boolean().optional(),
  /** ADR-0031 — this freeze's graph object NEVER LEAVES THIS SECURITY DOMAIN, in either direction,
   *  even under a peer paired at `full` scope.
   *
   *  For the OUTPOST-declared case: an outpost that wants its freeze to be a first-class graph
   *  object locally, and to be structurally incapable of travelling upward to the commander. Only
   *  meaningful with `federate: true` (without an object there is nothing to withhold), and the
   *  route refuses the combination `domainLocal` without `federate` rather than silently ignoring
   *  it — a locality declaration that no-ops is a field that lies.
   *
   *  Locality is DECLARED, never inferred, and declaring it is a `federation:write` act
   *  (`federation/domain-local.ts`). Immutable after create, structurally: only the INSERT names
   *  the column. */
  domainLocal: z.boolean().optional()
});
export type CreateFreezeRequest = z.infer<typeof CreateFreezeRequestSchema>;

export const FreezeIdParamSchema = z.object({ id: z.string().uuid() });
export const FreezeListResponseSchema = cursorPageResponseSchema(FreezeSchema);
export type FreezeListResponse = z.infer<typeof FreezeListResponseSchema>;

/**
 * M25.1 — the body of `DELETE /api/v1/freezes/{id}`.
 *
 * A BODY ON A DELETE, following `DeleteSourceMappingRequestSchema` (the shipped precedent on
 * `DELETE /change-sources/{sourceKind}/mappings`), because the reason is MANDATORY and a free-text
 * governance justification does not belong in a query string.
 *
 * `reason` IS REQUIRED, and that is the whole schema. Lifting a freeze retracts a protection for
 * EVERYONE covered by it — a strictly wider blast radius than `freeze:override`, which lets one
 * change past and leaves the freeze standing, and which has refused to work without a reason since
 * M4 (DESIGN §10.3). A loosening with no recorded reason is exactly what that refusal exists to
 * prevent.
 *
 * AND THAT RADIUS ARGUMENT IS ALSO THE PERMISSION (M25.9 / owner ruling D1(a-ii), 2026-08-25). This
 * verb takes `freeze:write` at the freeze's own scope, plus the Owner-only `freeze:override` at that
 * same scope whenever the acting subject is not the freeze's `created_by_actor_id` — the wider verb
 * can no longer cost the narrower permission. Lifting YOUR OWN freeze stays `freeze:write` alone, so
 * declaring a freeze is never an entrance with no exit for the role that declared it. The same pair
 * governs a SHORTENING via {@link UpdateFreezeWindowRequestSchema}, or the retraction would be one
 * PATCH away.
 */
export const LiftFreezeRequestSchema = z.object({
  reason: z.string().min(1)
});
export type LiftFreezeRequest = z.infer<typeof LiftFreezeRequestSchema>;

/**
 * M25.1 — the body of `PATCH /api/v1/freezes/{id}`: move `endsAt`, in either direction.
 *
 * SHORTENING is a LOOSENING (governance stops protecting sooner) and EXTENDING is a TIGHTENING.
 * Both need `freeze:write` at the freeze's own scope and both require a reason; the server records
 * which direction it was, together with the old and new instants, in the audit event and the
 * Decision — "who made governance weaker, and when" is the question an audit log is read with.
 *
 * AND THE DIRECTION IS ALSO AN AUTHORIZATION INPUT (M25.9 / owner ruling D1(a-ii), 2026-08-25). A
 * SHORTENING ends the protection early for everyone the freeze covers — the same act as `DELETE
 * /freezes/{id}` with a different record — so it additionally demands the Owner-only
 * `freeze:override` at the freeze's own scope whenever the acting subject is not the freeze's
 * `created_by_actor_id`. Gating the lift alone would leave the retraction one PATCH away. EXTENDING
 * takes nothing from anyone the freeze covers and stays `freeze:write` even on another actor's
 * freeze, and so does re-sending the `endsAt` a freeze already has. The direction is computed under
 * the row lock, against the window in force rather than the one the client last read.
 *
 * `startsAt` IS DELIBERATELY NOT EDITABLE. Moving the start of an open window is either a no-op or
 * a rewriting of history ("this freeze was in force from a time it was not"), and `endsAt` is the
 * whole of the escape hatch M25.1 exists to provide. Shortening `endsAt` to a past instant is
 * allowed and is NOT re-labelled a lift: same effect on admission, different and truthful record,
 * and reversible where a lift is not.
 */
export const UpdateFreezeWindowRequestSchema = z.object({
  endsAt: z.string().datetime(),
  reason: z.string().min(1)
});
export type UpdateFreezeWindowRequest = z.infer<typeof UpdateFreezeWindowRequestSchema>;

// -------------------------------------------------------------------------------------------
// `scp policy evaluate` (BUILD_AND_TEST.md §8 M4 item 7) — a dry-run gate evaluation against a
// change's CURRENT state, without attempting any transition. Reuses the exact same
// governance/gate-orchestrator.ts logic the real lifecycle-edge/wave-boundary gates run, so its
// output is by construction identical in shape to what a real block's Decision would show.
// -------------------------------------------------------------------------------------------

export const PolicyEvaluateRequestSchema = z.object({
  changeId: z.string().min(1) // id or URN
});
export type PolicyEvaluateRequest = z.infer<typeof PolicyEvaluateRequestSchema>;

export const PolicyEvaluateResponseSchema = z.object({
  verdict: z.enum(["allow", "block"]),
  reasonTree: z.record(z.string(), z.unknown()),
  inputContext: z.record(z.string(), z.unknown())
});
export type PolicyEvaluateResponse = z.infer<typeof PolicyEvaluateResponseSchema>;

// ===========================================================================================
// M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S WIRE CONTRACT (drizzle/0086,
// docs/proposals/campaigns-rework.md §2, owner decision D1).
//
// THE DELIBERATE TWIN of `InstanceScanFloor*` (supply-chain.ts) and
// `InstanceScanExclusionAdmission*`: same instance scope, same DESIGN §4.2 `org_id` exception,
// same two audiences and two credentials — tenant-facing READ (charter principle 6: a change
// blocked by a freeze must be able to name it), operator-only WRITE gated on
// `SCP_OPERATOR_TOKEN`, no RBAC permission anywhere on the write side.
//
// THESE ARE ON THE WIRE. `supply-chain.ts`'s M22.8 note is worth repeating here because it
// corrects a claim that was once made wrongly in this repo: `/instance/scan-floors` and
// `/instance/scan-floors/{tier}` are published in `openapi.v1.json`, and so will these be.
// Editing any of the schemas below after they ship is an oasdiff-gated API change, not a
// refactor.
// ===========================================================================================

/**
 * WHERE a platform freeze applies — a STAGE COORDINATE, never an object id.
 *
 * `freezes.scopeObjectId` names a graph object and the containment walk decides coverage. That is
 * structurally unavailable above org: object ids are per-org rows, `containmentChain` is
 * org-filtered on every join, and there is no object every tenant shares — one id would name at
 * most one tenant's object. So a platform freeze addresses the coordinate SCP already defines and
 * already reads (M15.6 / ADR-0017 §3): `properties.environment` (+ optional `properties.region`)
 * on a `deployment-target`.
 *
 * `allEnvironments` IS THE EXPLICIT DEPLOYMENT-WIDE FORM, and an omitted `environment` is NOT it.
 * The proposal sketched `match_environment IS NULL` = everything; that was changed deliberately.
 * A deployment-wide freeze stops every release for every tenant on the instance — the widest
 * governance act this surface can express — and reaching it by OMITTING a field means a client
 * that drops empty strings, a typo'd key, or a partially filled form authors maximum blast radius
 * with no error anywhere. This repo already refuses to let a LOOSENING default on; the widest
 * TIGHTENING gets the same treatment for the same reason. Send `allEnvironments: true` and mean it.
 *
 * `allEnvironments: true` is also the only form that covers a target declaring no coordinate at
 * all (a legacy component-shaped wave target, or a stage whose deployment-target sets no
 * `environment`). An environment-addressed freeze reaches the stages that SAY they are that
 * environment — ADR-0031's rule that locality is declared, never inferred.
 */
export const InstanceFreezeMatchSchema = z
  .object({
    /** Deployment-wide. Mutually exclusive with `environment` (refused 400, and by a DB CHECK). */
    allEnvironments: z.boolean().optional(),
    /** A `deployment-target`'s `properties.environment`, e.g. `"prod"`. With no `region`, this
     *  matches EVERY region of that environment — including a stage that declares no region.
     *
     *  TRIMMED BEFORE `min(1)`, AND THE TRIM IS A CORRECTNESS FIX, NOT TIDINESS (M25.3 review
     *  finding 3). `readStageCoordinate` trims what the GRAPH declares, and `instanceFreezeCovers`
     *  compares the two with `!==`. Stored untrimmed, `" prod"` therefore matches NOTHING while the
     *  PUT returns 200 and `GET /v1/instance/freezes` lists the row cleanly — a freeze an operator
     *  believes is in force and which holds nothing, which is the exact failure mode a freeze must
     *  never have. The DB CHECK cannot close this: `length(btrim(...)) > 0` TESTS a value, it does
     *  not STORE one, so `" prod"` passes it. Trimming here is one barrier ahead of the table and
     *  covers every writer that goes through the API, which is all of them.
     *
     *  `.trim()` before `.min(1)` also makes an all-whitespace value a 400 naming the addressing
     *  rule rather than a row that silently matches nothing. It changes no emitted JSON Schema
     *  (`z.toJSONSchema` still yields `{"type":"string","minLength":1}`), so it is not an API
     *  change — verified against the generated document, not inferred. */
    environment: z.string().trim().min(1).optional(),
    /** Narrows `environment` to one `properties.region`, e.g. `"amer"`. A target that declares no
     *  region does NOT match a region-narrowed freeze: it has not said it is that region.
     *  Trimmed for exactly the reason `environment` is — same comparison, same silent no-match. */
    region: z.string().trim().min(1).optional()
  })
  .refine((m) => (m.allEnvironments === true) !== (m.environment !== undefined), {
    message:
      "exactly one addressing form: allEnvironments: true (the whole deployment), or environment (optionally narrowed by region). An absent environment is NOT deployment-wide — say allEnvironments: true and mean it."
  })
  .refine((m) => m.region === undefined || m.environment !== undefined, {
    message:
      "region requires environment — a region without an environment is a coordinate with no origin"
  });
// BOTH REFINEMENTS ARE ENFORCED AT RUNTIME AND NEITHER APPEARS IN `openapi.v1.json`, which is
// worth stating because the generated spec is what a reader inspects. `app.ts` installs
// fastify-type-provider-zod's `validatorCompiler`, so request bodies are validated by the ZOD
// schema itself and a body with neither addressing form (or with both) is a 400 naming the rule.
// A cross-field constraint is not expressible in JSON Schema, so the emitted document shows three
// independent optional properties; the DB CHECK `instance_freezes_match_ck` is the second barrier
// behind it, for any writer that ever reaches the table without passing this schema.
export type InstanceFreezeMatch = z.infer<typeof InstanceFreezeMatchSchema>;

/** One instance-scoped freeze — the API projection of `instance_freezes` (no `orgId`: it binds
 *  EVERY org on the deployment). */
export const InstanceFreezeSchema = z.object({
  /** A real uuid, and the SAME id the gate's block Decision and the service board carry. It does
   *  NOT resolve through `GET /v1/freezes/{id}`, which is org-scoped — the block Decision states
   *  its `tier` so a reader knows to come here instead. */
  id: z.string().uuid(),
  /** The operator slug: the `PUT`/`DELETE` path segment, and the name a remedy sentence quotes. */
  key: z.string().min(1),
  name: z.string().nullable(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string(),
  match: z.object({
    allEnvironments: z.boolean(),
    environment: z.string().nullable(),
    region: z.string().nullable()
  }),
  /** Owner decision D5, identical semantics to `FreezeSchema.atomic` one tier down. */
  atomic: z.boolean(),
  /** Whether ANY tenant role may override this freeze. `false` (the default) means none can,
   *  however privileged — not an org-root Owner. `true` means the OPERATOR has admitted tenant
   *  override for this freeze, and an actor holding `freeze:override` AT THE ORG ROOT may then
   *  override it with the same mandatory reason. Two independent authorities, both required. */
  overridable: z.boolean(),
  note: z.string().nullable(),
  /** When it was RETRACTED, or null while it stands. Lifted rows are returned FOREVER: a
   *  `gate`/`freeze_admission` Decision cites this id and "what was this freeze that blocked me?"
   *  must stay answerable (charter principle 6). LIFTED IS A FIELD, NOT AN ABSENCE. */
  liftedAt: z.string().datetime().nullable(),
  liftReason: z.string().nullable(),
  updatedAt: z.string().datetime()
});
export type InstanceFreeze = z.infer<typeof InstanceFreezeSchema>;

export const InstanceFreezeListResponseSchema = z.object({
  items: z.array(InstanceFreezeSchema)
});
export type InstanceFreezeListResponse = z.infer<typeof InstanceFreezeListResponseSchema>;

export const InstanceFreezeKeyParamSchema = z.object({ key: z.string().min(1).max(200) });

/**
 * Operator-authored write body for `PUT /v1/instance/freezes/{key}` — a full replace of the row
 * at that key, never a partial merge, the same posture `PutInstanceScanFloorRequest` takes.
 *
 * `overridable` DEFAULTS TO FALSE and that default is the floor property. Nothing an org can
 * author subtracts from a platform freeze — the merge across tiers is a UNION — so the ONLY place
 * tenant relief exists is this bit, and a loosening never defaults on.
 */
export const PutInstanceFreezeRequestSchema = z.object({
  name: z.string().max(200).nullish(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().min(1).max(2000),
  match: InstanceFreezeMatchSchema,
  atomic: z.boolean().optional(),
  overridable: z.boolean().optional(),
  note: z.string().max(500).nullish()
});
export type PutInstanceFreezeRequest = z.infer<typeof PutInstanceFreezeRequestSchema>;

/**
 * The body of `DELETE /v1/instance/freezes/{key}` — the SOFT retraction.
 *
 * A body on a DELETE, following `LiftFreezeRequestSchema` and `DeleteSourceMappingRequestSchema`,
 * because the reason is mandatory and a free-text governance justification does not belong in a
 * query string. Retracting a platform freeze un-protects every org on the deployment at once —
 * a strictly wider blast radius than the org-tier lift this rule already applies to.
 */
export const LiftInstanceFreezeRequestSchema = z.object({
  reason: z.string().min(1).max(2000)
});
export type LiftInstanceFreezeRequest = z.infer<typeof LiftInstanceFreezeRequestSchema>;
