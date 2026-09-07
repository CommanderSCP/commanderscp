/** M16.1 — THE UNIVERSAL BOUNDARY SEGMENT read model. See docs/coordination.md §49. */
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

/** How many artifacts the authorized set held. See docs/coordination.md §50. */
function authorizedArtifactCount(decision: Decision): number | null {
  const raw = decision.inputContext.authorizedArtifacts;
  return Array.isArray(raw) ? raw.length : null;
}

/** The boundary segment, or null if no boundary was crossed. See docs/coordination.md §51. */
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

  const hops: BoundaryTransferHop[] = transfers.map((t) => ({
    direction: t.direction,
    status: t.status,
    peerDomainId: t.peerDomainId,
    checksum: t.checksum ?? null,
    // drizzle/0087 — threaded straight from the ledger row; see BoundaryTransferHopSchema's doc.
    channel: t.channel ?? null,
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
      authorizedArtifactCount: null
    };
    unknownFields.push(VALIDATE_STATE_UNKNOWN);
  } else {
    // The receiving side reports its OWN verdict, and only its own. Latest verdict wins — a change
    // re-verified after remediation is described by its current outcome, and `listDecisionsForSubject`
    // already returns oldest-first.
    const verdicts = decisions.filter((d) => d.kind === PRE_DEPLOY_ARTIFACT_VERIFY_DECISION_KIND);
    const latest = verdicts[verdicts.length - 1];
    if (!latest) {
      // Received, no verdict recorded. Includes the deliberate case where the pre-deploy gate's
      // vacuous exits wrote nothing (metadata-only promotion): an honest "not yet verified", which
      // is exactly what we want that case to read as rather than a pass over zero artifacts.
      validate = {
        state: "not_yet_verified",
        decisionId: null,
        observedAt: null,
        authorizedArtifactCount: null
      };
    } else {
      const verified = latest.verdict === "allow";
      validate = {
        state: verified ? "verified" : "refused",
        decisionId: latest.id,
        observedAt: latest.createdAt,
        // ONLY on a pass. See docs/coordination.md §52.
        authorizedArtifactCount: verified ? authorizedArtifactCount(latest) : null
      };
    }
  }

  return { transfer, validate, unknownFields };
}
