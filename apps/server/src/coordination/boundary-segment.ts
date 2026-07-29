/**
 * M16.1 — THE UNIVERSAL BOUNDARY SEGMENT read model (ADR-0011; vocabulary fixed by ADR-0021 D6).
 *
 * A boundary SEGMENT composed of two boundary PHASES — *transferred* and *validated*. It is not a
 * "stage" (a deployment PLACE) and not a "wave" (the set of stages advanced at once). It DRIVES
 * NOTHING: this module only reads two ledgers this instance already writes and reports what it
 * genuinely observed, plus an explicit unknown for everything it did not.
 *
 * ## The two inputs
 *
 * 1. TRANSFER — `bundle_transfers`, joined to this change by the bundle checksum stamped on its
 *    `sourceRef` (M16.1 I1, `federation/boundary-bundle-ref.ts`; the ledger itself has no change
 *    column).
 * 2. VALIDATE — this instance's own M17.4(b) pre-deploy artifact-verify Decisions for the change
 *    (`pre-deploy-artifact-verify`). Since M16.1 I2 a PASSING verify persists an `allow` Decision,
 *    which is what makes `verified` truthfully renderable at all.
 *
 * ## The three honesty rules this file exists to enforce
 *
 * **R1 — an exporting instance can only ever say "exported".** `bundle_transfers` is INSERT-only:
 * there is no `update(bundleTransfers)` anywhere in the tree, and every `submitted`/`confirmed` row
 * is written by a *later hop's own database* (a retrans's onward drop writes `submitted`; a
 * receiver's import writes `confirmed`). So in the COMMANDER's own database an export row is and
 * stays `created`. Rendering "submitted" or "confirmed" from the exporting side would be
 * fabrication; the handoff is declared unknown instead (`transfer.handoff`).
 *
 * **R2 — the exporting instance has NO data path to the receiver's validation outcome.** Federation
 * journal entry kinds are graph/lifecycle-shaped (none is verification-shaped), `change_status`
 * payloads carry lifecycle only, and imported `audit_segment` entries are discarded. Adding a
 * verification-outcome journal kind was REJECTED (it is a bundle-format change). The commander
 * therefore reports `not_reported` — "outcome not reported back" — and names `validate.state` in
 * `unknownFields`. {@link buildBoundarySegment} makes `verified` STRUCTURALLY UNREACHABLE on that
 * side rather than merely unlikely.
 *
 * **R3 — silence is never a pass.** A received change with no verdict is `not_yet_verified`, and a
 * change that never crossed a boundary yields `null` (no segment) rather than an empty green one.
 * In particular a metadata-only promotion records no verdict by design (the pre-deploy gate's
 * vacuous exits write nothing — see `pre-deploy-gate.ts`), and that absence surfaces here as
 * `not_yet_verified`, never as `verified`.
 */
import type {
  BoundarySegment,
  BoundaryTransferHop,
  BoundaryTransferPhase,
  BoundaryValidatePhase,
  Decision
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { boundaryBundleChecksumsOf } from "../federation/boundary-bundle-ref.js";
import { listTransfersByChecksums } from "../federation/bundle-transfers-repo.js";
import { listDecisionsForSubject } from "./decisions-repo.js";
import { PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND } from "./pre-deploy-gate.js";

/** The `unknownFields` path for "we cannot see whether the peer received the bundle" (R1). */
export const TRANSFER_HANDOFF_UNKNOWN = "transfer.handoff";
/** The `unknownFields` path for "the receiving outpost's verdict is not reported back here" (R2). */
export const VALIDATE_STATE_UNKNOWN = "validate.state";

/** The minimal change shape this read model needs — satisfied by a `ChangeRow` and by the API's
 *  `Change` alike, so the route can pass whichever it already holds without converting. */
export interface BoundarySegmentChange {
  objectId?: string;
  id?: string;
  sourceRef: Record<string, unknown> | null;
  importedFromDomain: string | null;
}

function changeObjectIdOf(change: BoundarySegmentChange): string {
  const id = change.objectId ?? change.id;
  if (!id) throw new Error("buildBoundarySegment: change has neither objectId nor id");
  return id;
}

/** How many authorized artifacts a pre-deploy verdict covered, read defensively out of its opaque
 *  `inputContext`. `null` — never 0 — when the shape is not what we expect, so a client can tell
 *  "no count available" from "a verdict over zero artifacts". */
function authorizedArtifactCount(decision: Decision): number | null {
  const raw = decision.inputContext.authorizedArtifacts;
  return Array.isArray(raw) ? raw.length : null;
}

/**
 * The boundary segment for one change, or `null` when the change never crossed a domain boundary
 * (a domain-local change — ADR-0013's exemption; the proposal's "domain-local changes have a
 * shorter pipeline"). `null` means ABSENT, deliberately not a fabricated empty pass.
 *
 * Reads only; writes nothing; drives nothing.
 */
export async function buildBoundarySegment(
  tx: TenantTx,
  orgId: string,
  change: BoundarySegmentChange
): Promise<BoundarySegment | null> {
  const checksums = boundaryBundleChecksumsOf(change.sourceRef);
  const isReceivingSide = change.importedFromDomain !== null;

  // Never crossed a boundary: no bundle carried it and it was not imported from a peer. There is no
  // segment to render — not an empty one.
  if (checksums.length === 0 && !isReceivingSide) return null;

  const changeObjectId = changeObjectIdOf(change);
  const [transfers, decisions] = await Promise.all([
    listTransfersByChecksums(tx, orgId, checksums),
    listDecisionsForSubject(tx, orgId, changeObjectId)
  ]);

  // ---------------------------------------------------------------------------------------------
  // Phase 1 — TRANSFERRED.
  // ---------------------------------------------------------------------------------------------
  const hops: BoundaryTransferHop[] = transfers.map((t) => ({
    direction: t.direction,
    status: t.status,
    peerDomainId: t.peerDomainId,
    checksum: t.checksum ?? null,
    observedAt: t.createdAt
  }));
  const importHops = hops.filter((h) => h.direction === "import");
  const exportHops = hops.filter((h) => h.direction === "export");

  const transferState: BoundaryTransferPhase["state"] =
    importHops.length > 0 ? "received" : exportHops.length > 0 ? "exported" : "not_observed";
  const transfer: BoundaryTransferPhase = {
    state: transferState,
    hops,
    observedAt: hops.length > 0 ? hops[hops.length - 1]!.observedAt : null
  };

  const unknownFields: string[] = [];
  // R1. An export row can only ever be `created` in THIS database, so the far side's receipt is
  // unobservable here. Declared whenever this instance exported the bundle — including at a retrans
  // that also imported it, whose ONWARD hop is just as unobservable as a commander's.
  if (exportHops.length > 0) unknownFields.push(TRANSFER_HANDOFF_UNKNOWN);

  // ---------------------------------------------------------------------------------------------
  // Phase 2 — VALIDATED.
  // ---------------------------------------------------------------------------------------------
  let validate: BoundaryValidatePhase;
  if (!isReceivingSide) {
    // R2 — STRUCTURAL. This branch is taken for every change this instance did not receive from a
    // peer (the commander's own promoted change, always). It is the ONLY place the exporting side
    // can reach, and it cannot produce `verified`: the outcome literally is not reported back.
    // `boundary-segment.integration.test.ts` asserts this over the whole two-domain fixture.
    validate = {
      state: "not_reported",
      decisionId: null,
      observedAt: null,
      verifiedArtifactCount: null
    };
    unknownFields.push(VALIDATE_STATE_UNKNOWN);
  } else {
    // The receiving side reports its OWN verdict, and only its own. Latest verdict wins — a change
    // re-verified after remediation is described by its current outcome, and `listDecisionsForSubject`
    // already returns oldest-first.
    const verdicts = decisions.filter(
      (d) => d.kind === PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND
    );
    const latest = verdicts[verdicts.length - 1];
    if (!latest) {
      // Received, no verdict recorded. Includes the deliberate case where the pre-deploy gate's
      // vacuous exits wrote nothing (metadata-only promotion): an honest "not yet verified", which
      // is exactly what we want that case to read as rather than a pass over zero artifacts.
      validate = {
        state: "not_yet_verified",
        decisionId: null,
        observedAt: null,
        verifiedArtifactCount: null
      };
    } else {
      validate = {
        state: latest.verdict === "allow" ? "verified" : "refused",
        decisionId: latest.id,
        observedAt: latest.createdAt,
        verifiedArtifactCount: authorizedArtifactCount(latest)
      };
    }
  }

  return { transfer, validate, unknownFields };
}
