import { z } from "zod";
import { UrnSchema } from "./graph.js";
import { ArtifactClassSchema, ExecutorTypeSchema, type ExecutorType } from "./executors.js";
import { Sha256DigestSchema, TestBundleRefSchema } from "./supply-chain.js";

/** `@scp/schemas` — pipeline BEHAVIOUR contract. See docs/schemas.md §333. */

// Canonical D24 vocabularies. See docs/schemas.md §334.

/** D24's infra-kind taxonomy. See docs/schemas.md §335. */
export const InfraKindSchema = z.enum(["cluster", "instanceGroup", "database", "bucket", "queue"]);
export type InfraKind = z.infer<typeof InfraKindSchema>;

/** `ArtifactClassSchema` / `ArtifactClass` MOVED to `executors.ts`. See docs/schemas.md §336. */
export { ArtifactClassSchema, type ArtifactClass } from "./executors.js";

/** D12/D24's target class. See docs/schemas.md §337. */
export const RolloutTargetClassSchema = InfraKindSchema.extract(["cluster", "instanceGroup"]);
export type RolloutTargetClass = z.infer<typeof RolloutTargetClassSchema>;

/** D24's artifact-class × infra-kind compatibility matrix. See docs/schemas.md §338. */
export const ARTIFACT_INFRA_COMPATIBILITY: Record<ExecutorType, readonly InfraKind[]> = {
  image: ["cluster"],
  chart: ["cluster"],
  rpm: ["instanceGroup"],
  deb: ["instanceGroup"],
  "vm-image": ["instanceGroup"],
  configuration: ["cluster", "instanceGroup"],
  npm: [],
  maven: [],
  python: [],
  go: [],
  infrastructure: []
};

/** The infra kinds `type` may legally be placed at, per `ARTIFACT_INFRA_COMPATIBILITY`. Total over
 *  `ExecutorType` — never throws, never falls back to a default; an unplaceable type (`npm`,
 *  `infrastructure`, …) returns an empty array rather than `undefined`. */
export function compatibleInfraKinds(type: ExecutorType): readonly InfraKind[] {
  return ARTIFACT_INFRA_COMPATIBILITY[type];
}

/** Whether `type` may be placed at an infra product of `kind` — the plan-time hard-check D24
 *  requires ("an L1/hand-written manifest cannot bypass what the types prevent"). */
export function isPlacementCompatible(type: ExecutorType, kind: InfraKind): boolean {
  return ARTIFACT_INFRA_COMPATIBILITY[type].includes(kind);
}

// Workflow identity (D11, D15b, D23)

/** What a test hook points at, never a bare template name. See docs/schemas.md §339. */
export const WorkflowRefSchema = z.object({
  /** The pipeline's repo, in the same spelling the pipeline's source mapping uses (D18: always
   *  explicit, never inferred from "the repo the manifest shipped in"). */
  repo: z.string().min(1),
  branch: z.string().min(1),
  /** Path to the WorkflowTemplate / CronWorkflow definition WITHIN `repo`. */
  path: z.string().min(1),
  /** Which template inside `path`, when the file declares more than one. */
  templateName: z.string().min(1).optional()
});
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;

/** Those two schemas live in the supply-chain module. See docs/schemas.md §340. */

/** What a hook's run is actually pinned to, once captured. See docs/schemas.md §341. */
export const CapturedWorkflowRefSchema = WorkflowRefSchema.extend({
  commitSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/, "commitSha must be a 40-character lowercase hex git SHA"),
  bundle: TestBundleRefSchema
});
export type CapturedWorkflowRef = z.infer<typeof CapturedWorkflowRefSchema>;

// Hook kinds and manifest entries (D11, D21)

export const PipelineHookKindSchema = z.enum([
  "postMerge",
  "postDeploy",
  "continuous",
  "bakeAlarms"
]);
export type PipelineHookKind = z.infer<typeof PipelineHookKindSchema>;

/** Every hook carries these. See docs/schemas.md §342. */
const HookBaseFields = {
  componentUrn: UrnSchema,
  hookId: z.string().min(1).max(200),
  /** Where the workflow lives. Absent only on `bakeAlarms`, which triggers nothing. */
  workflow: WorkflowRefSchema
};

/** POST-MERGE — gates entry to WAVE 1. See docs/schemas.md §343. */
export const ManifestPostMergeHookSchema = z.object({
  kind: z.literal("postMerge"),
  ...HookBaseFields
});

/** Post-deploy gates promotion out of a wave. See docs/schemas.md §344. */
export const ManifestPostDeployHookSchema = z.object({
  kind: z.literal("postDeploy"),
  ...HookBaseFields,
  /** Stage name (operator data, D6 — SCP never enforces the vocabulary). ABSENT = every wave. */
  stage: z.string().min(1).optional()
});

/** Continuous: a canary probe whose latest result holds. See docs/schemas.md §345. */
export const ManifestContinuousHookSchema = z.object({
  kind: z.literal("continuous"),
  ...HookBaseFields,
  /** The cron cadence Argo Workflows runs this probe on. Descriptive: SCP does not schedule it. */
  everySeconds: z.number().int().positive(),
  /** REQUIRED. Evidence older than this is ABSENT, not stale-pass and not fail (see above). */
  maxAgeSeconds: z.number().int().positive()
});

/** Bake alarms: a quiet window that must pass alarm-free. See docs/schemas.md §346. */
export const ManifestBakeAlarmsHookSchema = z.object({
  kind: z.literal("bakeAlarms"),
  componentUrn: UrnSchema,
  hookId: z.string().min(1).max(200),
  /** How long the target must stay alarm-free after its deploy before the wave may exit. */
  quietWindowSeconds: z.number().int().positive(),
  stage: z.string().min(1).optional()
});

export const ManifestPipelineHookSchema = z.discriminatedUnion("kind", [
  ManifestPostMergeHookSchema,
  ManifestPostDeployHookSchema,
  ManifestContinuousHookSchema,
  ManifestBakeAlarmsHookSchema
]);
export type ManifestPipelineHook = z.infer<typeof ManifestPipelineHookSchema>;

// Rollout (D12, D15c)

/** The authority split, declared by the plugin and read. See docs/schemas.md §347. */
export const RolloutAuthoritySchema = z.enum(["authoritative", "triggerParams", "verified"]);
export type RolloutAuthority = z.infer<typeof RolloutAuthoritySchema>;

/** D15(c): the strategy IS the class, so the wire carries a discriminant, never a strategy string
 *  the server has to interpret. D16(3): percentages are plain numbers on self-describing props
 *  (CDK's `minHealthyPercent` pattern) and durations are seconds — never `"25%"`, never `"5m"`. */
export const RolloutStrategySchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("canary"),
    steps: z
      .array(
        z.object({
          weightPercent: z.number().int().min(0).max(100),
          pauseSeconds: z.number().int().nonnegative().optional()
        })
      )
      .min(1)
  }),
  z.object({
    strategy: z.literal("rolling"),
    batchPercent: z.number().int().min(1).max(100),
    pauseBetweenSeconds: z.number().int().nonnegative().optional()
  })
]);
export type RolloutStrategy = z.infer<typeof RolloutStrategySchema>;

/** Identity is `(componentUrn, targetClass)` — D12 keys the declaration by the CLASS of target, so
 *  one component legitimately declares a canary for its clusters and a rolling batch for its
 *  instance groups. */
export const ManifestRolloutSchema = z.object({
  componentUrn: UrnSchema,
  targetClass: RolloutTargetClassSchema,
  rollout: RolloutStrategySchema
});
export type ManifestRollout = z.infer<typeof ManifestRolloutSchema>;

// Convergence (D25)

/** When a configuration pipeline places at a product. See docs/schemas.md §348. */
export const ManifestConvergenceSchema = z.object({
  componentUrn: UrnSchema,
  targetUrn: UrnSchema,
  converge: z.boolean(),
  /** REQUIRED, and not defaulted on the wire. `z.default()` would emit a JSON Schema that is
   *  simultaneously `required` and carries a default, which is the worst of both readings for a
   *  hand-authored (L1) manifest. D8's rule already settles it: inference at synth, explicitness at
   *  apply — the construct picks `changedSubset`, the manifest always says which. */
  scope: z.enum(["changedSubset", "fullGroup"])
});
export type ManifestConvergence = z.infer<typeof ManifestConvergenceSchema>;

// Wave-document gates (§14 resolution 5) — vocabulary and entry shape only.

/** The gate kinds a wave document's native `gates` field may name. See docs/schemas.md §349. */
export const WaveGateKindSchema = z.enum(["postDeployTest", "bakeAlarms"]);
export type WaveGateKind = z.infer<typeof WaveGateKindSchema>;

export const WaveGateSchema = z.object({
  kind: WaveGateKindSchema,
  /** Narrows to one declared hook by its `hookId`; absent = every hook of this kind that applies to
   *  the wave (which, per `stage` being absent on the hook, is the default form). */
  hookId: z.string().min(1).max(200).optional()
});
export type WaveGate = z.infer<typeof WaveGateSchema>;

// Evidence (D21(b), D23, §14 resolution 8)

/** WHAT A PIECE OF EVIDENCE IS ABOUT. See docs/schemas.md §350. */
export const PipelineEvidenceSubjectSchema = z
  .object({
    componentUrn: UrnSchema,
    /** The deployment-target this evidence describes. Required even for `postMerge`, whose run is
     *  not target-specific, because the AUTHORIZATION is scoped at the target (see the submit
     *  request below) and an evidence row nobody can attribute is an evidence row nobody can
     *  revoke. */
    targetUrn: UrnSchema,
    artifactDigest: Sha256DigestSchema.optional(),
    commitSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/, "commitSha must be a 40-character lowercase hex git SHA")
      .optional()
  })
  .refine((s) => s.artifactDigest !== undefined || s.commitSha !== undefined, {
    message:
      "evidence must be bound to an artifact digest or a built commit — unbound evidence would be read as covering whatever deploys next"
  });
export type PipelineEvidenceSubject = z.infer<typeof PipelineEvidenceSubjectSchema>;

/** A concluded test run. NOTE THE OUTCOME VOCABULARY. See docs/schemas.md §351. */
export const TestRunEvidenceSchema = z.object({
  kind: z.literal("testRun"),
  hook: PipelineHookKindSchema,
  hookId: z.string().min(1).max(200),
  /** Pinned to the built commit and the digest-pinned bundle that actually ran (D23). */
  workflow: CapturedWorkflowRefSchema,
  /** The executor-side run identity (an Argo Workflows run name), for the operator's back-link. */
  runId: z.string().min(1).max(500),
  outcome: z.enum(["passed", "failed"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
});
export type TestRunEvidence = z.infer<typeof TestRunEvidenceSchema>;

/** ALARM STATE OVER A NAMED WINDOW. See docs/schemas.md §352. */
export const AlarmStateEvidenceSchema = z.object({
  kind: z.literal("alarmState"),
  hookId: z.string().min(1).max(200),
  /** The window this report actually covers. A gate satisfies its `quietWindowSeconds` only from
   *  reports whose covered window spans it — a shorter window is a shorter look, not a pass. */
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  /** EMPTY = an affirmative "nothing fired in that window". Absent evidence is not this. */
  alarms: z.array(
    z.object({
      name: z.string().min(1).max(500),
      severity: z.enum(["warning", "critical"]),
      firedAt: z.string().datetime()
    })
  )
});
export type AlarmStateEvidence = z.infer<typeof AlarmStateEvidenceSchema>;

export const PipelineEvidenceSchema = z.discriminatedUnion("kind", [
  TestRunEvidenceSchema,
  AlarmStateEvidenceSchema
]);
export type PipelineEvidence = z.infer<typeof PipelineEvidenceSchema>;

/** The push door's request body. See docs/schemas.md §353. */
export const SubmitPipelineEvidenceRequestSchema = z.strictObject({
  subject: PipelineEvidenceSubjectSchema,
  evidence: PipelineEvidenceSchema
});
export type SubmitPipelineEvidenceRequest = z.infer<typeof SubmitPipelineEvidenceRequestSchema>;

/** The push door's receipt. See docs/schemas.md §354. */
export const SubmitPipelineEvidenceResponseSchema = z.object({
  evidenceId: z.string().uuid(),
  kind: z.enum(["testRun", "alarmState"]),
  /** ALWAYS `pushed` on this route — a constant, not a field the request could steer. */
  source: z.literal("pushed"),
  producerSubjectId: z.string().uuid(),
  /** The resolved subject coordinates the row was keyed by, so a reporter can see that its URNs
   *  landed where it meant them to rather than discovering weeks later that its evidence was filed
   *  against a different placement. */
  componentObjectId: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  recordedAt: z.string().datetime()
});
export type SubmitPipelineEvidenceResponse = z.infer<typeof SubmitPipelineEvidenceResponseSchema>;

// Freshness — the Decision `inputContext` shape (§14 build verification 2)

/** WHAT A HOOK'S DECISION RECORDS, AND WHY `now` IS NOT IN IT. See docs/schemas.md §355. */
export const HookFreshnessContextSchema = z.object({
  hook: PipelineHookKindSchema,
  hookId: z.string().min(1).max(200),
  maxAgeSeconds: z.number().int().positive(),
  /** `null` = no evidence has ever arrived for this (hook, target, binding). Distinct from evidence
   *  that arrived and failed, and distinct from evidence that arrived and went stale. */
  latestEvidence: z
    .object({
      evidenceId: z.string().uuid(),
      outcome: z.enum(["passed", "failed"]),
      completedAt: z.string().datetime(),
      artifactDigest: Sha256DigestSchema.nullable(),
      commitSha: z.string().nullable()
    })
    .nullable(),
  /** `completedAt + maxAgeSeconds`, as data. `null` when there is no evidence to age. NEVER `now`,
   *  and never a value the engine re-derives from the clock at write time — see the doc above. */
  staleAfter: z.string().datetime().nullable()
});
export type HookFreshnessContext = z.infer<typeof HookFreshnessContextSchema>;

/** The per-target hold entry a `continuous` hook produces. See docs/schemas.md §356. */
export const ContinuousTestHoldSchema = z.object({
  hookId: z.string().min(1).max(200),
  reason: z.enum(["no_evidence", "stale", "failed"]),
  summary: z.string(),
  /** The boundary the engine applied, carried for the same reason `endsAt` is carried on a freeze
   *  hold: the client's own clock contextualizes it, and `now` never crosses this seam. */
  staleAfter: z.string().datetime().nullable(),
  lastReportedAt: z.string().datetime().nullable()
});
export type ContinuousTestHold = z.infer<typeof ContinuousTestHoldSchema>;

// Artifact-class verification (D13)

/** A pipeline declares its artifact class, then it is verified. See docs/schemas.md §357. */
export const ArtifactClassVerificationSchema = z.object({
  /** What the pipeline declared it produces — `source_mappings.type` at propose time. */
  declared: ExecutorTypeSchema,
  /** What build evidence says was actually produced. `null` = nothing to check yet. */
  observed: ArtifactClassSchema.nullable(),
  evidenceSource: z.enum(["buildReport"]).nullable(),
  verdict: z.enum(["match", "mismatch", "unverified"])
});
export type ArtifactClassVerification = z.infer<typeof ArtifactClassVerificationSchema>;

// Infrastructure membership (team-pipeline-iac D25(a), M27.6)

/** One observed member of an infrastructure product. See docs/schemas.md §360. */
export const ObservedMemberSchema = z.strictObject({
  /** The PROVIDER's identifier — an EC2 instance id, a VM name. This is the identity, because an
   *  instance keeps it across a reboot that changes its address. */
  memberId: z.string().min(1).max(400),
  /** Where a runner would connect. */
  address: z.string().min(1).max(400)
});
export type ObservedMember = z.infer<typeof ObservedMemberSchema>;

/**
 * A membership report is the product's CURRENT FULL SET, never a delta.
 *
 * A delta protocol would let one dropped or reordered message leave a host in the inventory that no
 * longer exists — and for a host-reaching runner that means connecting to an address which may by
 * then belong to someone else. `members` is therefore the whole truth as observed, and the server
 * replaces what it held.
 *
 * An EMPTY array is meaningful and accepted: a fleet scaled to zero must stop converging its last
 * known hosts, which "absent means unchanged" would prevent.
 */
export const ReportInfrastructureMembersRequestSchema = z.strictObject({
  members: z.array(ObservedMemberSchema).max(10_000)
});
export type ReportInfrastructureMembersRequest = z.infer<
  typeof ReportInfrastructureMembersRequestSchema
>;

/** What changed, so a caller can see what a report did. See docs/schemas.md §361. */
export const InfrastructureMembershipDiffSchema = z.strictObject({
  added: z.array(ObservedMemberSchema),
  removed: z.array(ObservedMemberSchema),
  /** Same member, new address — one host to re-apply to, not one leaving and another arriving. */
  readdressed: z.array(
    z.strictObject({
      memberId: z.string(),
      from: z.string(),
      to: z.string()
    })
  )
});
export type InfrastructureMembershipDiff = z.infer<typeof InfrastructureMembershipDiffSchema>;

export const InfrastructureMembersViewSchema = z.strictObject({
  productObjectId: z.string().uuid(),
  members: z.array(ObservedMemberSchema)
});
export type InfrastructureMembersView = z.infer<typeof InfrastructureMembersViewSchema>;

// ---------------------------------------------------------------------------------------------
// SSH CA enrolment and issuance evidence (M27.9, ADR-0051). See docs/schemas.md §189.
// ---------------------------------------------------------------------------------------------

/** WHAT ENROLLING A DOMAIN ASKS FOR. One field, and it is the precondition rather than the
 *  credential: ADR-0051's recovery paragraph is a circularity — an estate whose only route in is
 *  SCP's CA cannot recover from that CA being compromised — so a CA cannot come into existence
 *  without a recorded way in that does not depend on it. The keypair is MINTED server-side and is
 *  deliberately not in this request: a caller-supplied public key could name a private half SCP
 *  does not hold. */
export const EnrolTrustDomainRequestSchema = z.strictObject({
  breakGlass: z
    .string()
    .min(1)
    .describe(
      "How an operator reaches these hosts WITHOUT this CA: an out-of-band console, a jump host " +
        "outside the trust domain, a hardware KVM. Non-empty, or the enrolment is refused."
    )
});
export type EnrolTrustDomainRequest = z.infer<typeof EnrolTrustDomainRequestSchema>;

/** The enrolment, plus the two files an operator must install for it to mean anything.
 *
 *  THE FILES ARE RETURNED, not merely described. An enrolment whose CA public key the operator
 *  cannot get hold of has changed nothing on any host — the "built, never installed" shape one
 *  layer out — so the response carries the exact `TrustedUserCAKeys` content and the exact sudoers
 *  fragment, generated from the same catalog the runner executes. */
export const TrustDomainEnrolmentSchema = z.strictObject({
  domainId: z.string().uuid(),
  authorityId: z.string().uuid(),
  breakGlass: z.string(),
  enrolledAt: z.string(),
  /** `ssh-ed25519 AAAA...` — the CA public half, for `TrustedUserCAKeys` on every host. */
  caPublicKey: z.string(),
  /** The literal file content, ready to write. */
  trustedUserCaKeysFile: z.string()
  // NO `sudoersFragment`, and its absence is a DECISION rather than an omission (owner, 2026-09-23,
  // amending ADR-0051 D4). M27.8 generated one naming the catalog's commands, and wiring enrolment
  // up showed those are commands Ansible never invokes: `become: true` runs
  //     sudo -H -S -n -u root /bin/sh -c 'echo BECOME-SUCCESS-... ; /usr/bin/python3 .../AnsiballZ_*.py'
  // so the fragment grants nothing a run calls, and the rule that would work grants `/bin/sh` with
  // the module path under the connecting account's own writable `~/.ansible/tmp`. The certificate's
  // principal is therefore `root`, stated plainly, and the restricted-sudoers control is deleted
  // rather than kept in a form that only reads as one. What bounds a run is unchanged: the signed
  // closed catalog, the modules deleted from the image, non-templatable parameters, a minutes-TTL
  // certificate and the per-run egress allowlist.
});
export type TrustDomainEnrolment = z.infer<typeof TrustDomainEnrolmentSchema>;

/** One certificate SCP recorded issuing (ADR-0051 D5). */
export const SshCertificateIssuanceSchema = z.strictObject({
  serial: z.string(),
  keyId: z.string(),
  authorityName: z.string(),
  principals: z.array(z.string()),
  targetHosts: z.array(z.string()),
  /** The OpenSSH `source-address` the certificate CARRIES (M28.2), or null when it carries none. */
  sourceAddress: z.string().nullable(),
  issuedAt: z.string(),
  expiresAt: z.string()
});
export type SshCertificateIssuance = z.infer<typeof SshCertificateIssuanceSchema>;

/** SERIALS A HOST ACCEPTED, offered for reconciliation. Read from the host's own `sshd` log; the
 *  question this answers is "did SCP issue this?", and a `no` is the forgery signal. */
export const ReconcileSshSerialsRequestSchema = z.strictObject({
  serials: z.array(z.string().min(1)).min(1).max(1000)
});
export type ReconcileSshSerialsRequest = z.infer<typeof ReconcileSshSerialsRequestSchema>;

/** One serial's verdict. `unrecognised` is the whole point of the surface.
 *
 *  THIS IS THE ONLY THING THAT BOUNDS CA COMPROMISE. Short TTLs provably do not: `sshd` honours the
 *  validity interval INSIDE the certificate, which an attacker holding the signing key chooses
 *  (ADR-0051's blast-radius analysis). Detection is the control. */
export const SshSerialVerdictSchema = z.strictObject({
  serial: z.string(),
  unrecognised: z.boolean(),
  keyId: z.string().nullable(),
  authorityName: z.string().nullable(),
  issuedAt: z.string().nullable()
});
export type SshSerialVerdict = z.infer<typeof SshSerialVerdictSchema>;

export const SshSerialReconciliationSchema = z.strictObject({
  verdicts: z.array(SshSerialVerdictSchema),
  /** How many of the offered serials SCP has no record of issuing. Carried so a caller cannot
   *  report "reconciled" by reading a 200 and never inspecting the array. */
  unrecognisedCount: z.number().int()
});
export type SshSerialReconciliation = z.infer<typeof SshSerialReconciliationSchema>;

export const SshCertificateIssuanceListSchema = z.strictObject({
  issuances: z.array(SshCertificateIssuanceSchema)
});
export type SshCertificateIssuanceList = z.infer<typeof SshCertificateIssuanceListSchema>;

// ---------------------------------------------------------------------------------------------
// Host ops through Argo Workflows — the one-time redemption (M28.2, ADR-0054).
// ---------------------------------------------------------------------------------------------

/** WHAT A `scp-ops-v1` RUNNER POD SENDS. Two fields, and neither can widen the run.
 *
 *  `token` is the single-use secret the pod unsealed with the operator's key; it names ONE
 *  redemption row, whose bound reconcile already derived. `publicKey` is the key the pod generated
 *  for itself — the certificate is issued over it, so the private half never leaves the pod and
 *  never exists in SCP. There is deliberately no field for hosts, a role, principals or a validity:
 *  anything the request could name is something a Workflow editor could choose. */
export const OpsRunRedemptionRequestSchema = z.strictObject({
  token: z.string().min(1).max(512),
  publicKey: z
    .string()
    .min(1)
    .max(1024)
    .describe("The pod's own ephemeral public key, `ssh-ed25519 AAAA...`.")
});
export type OpsRunRedemptionRequest = z.infer<typeof OpsRunRedemptionRequestSchema>;

/** WHAT THE POD GETS BACK — the same bound Mode C's `deriveOpsRunMaterial` produces, plus a
 *  certificate over the pod's own key. The runner writes these to the same `/work/in` files the
 *  Mode C orchestrator stages, so one reader reads one shape. */
export const OpsRunMaterialSchema = z.strictObject({
  runId: z.string().uuid(),
  opsRole: z.string(),
  opsInventory: z.string(),
  opsEgressAllowlist: z.array(z.string()),
  opsPrincipals: z.array(z.string()),
  /** The role's OWN arguments, as data — the runner marks every string `!unsafe` (M27.2). */
  roleArguments: z.record(z.string(), z.unknown()),
  /** `ssh-ed25519-cert-v01@openssh.com AAAA...` over `publicKey`. */
  certificate: z.string(),
  serial: z.string(),
  keyId: z.string(),
  expiresAt: z.string(),
  /** The `source-address` critical option the certificate carries, or null when it carries none. */
  sourceAddress: z.string().nullable()
});
export type OpsRunMaterial = z.infer<typeof OpsRunMaterialSchema>;
