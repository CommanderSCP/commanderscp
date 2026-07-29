import { useQuery } from "@tanstack/react-query";
import { client } from "./client";
import { federationSelfKey } from "./query-client";

/**
 * M16.3 P2 — MEASURED single-writer-authority gating for `apps/web` write controls.
 *
 * THE RULE THIS MODULE ENFORCES ON ITSELF: a control is disabled here ONLY where
 * `apps/server/src/federation/foreign-origin-writes.integration.test.ts` MEASURED the server
 * refusing that exact write against a genuinely foreign-origin object, and every surviving
 * `disabled` names the case that measured it. A UI that blocks a write the server would accept is
 * a regression, not caution — the first cut of this module disabled Detach/Repurpose/Assign/Move/
 * Merge on the strength of a comment asserting "the server refuses this write on a read-only
 * replica regardless", which was untrue for most of them, and broke the documented multi-region
 * workflow (DESIGN.md §12.6 / BUILD_AND_TEST.md M15.6: an outpost binding its OWN local Argo CD to
 * a deployment-target that is commander-origin from the outpost's point of view).
 *
 * WHAT THE SERVER ACTUALLY REFUSES — the ONLY three things gated anywhere in the app:
 *   1. Mutating/deleting the OBJECT ITSELF — `graph/objects-repo.ts`'s `updateObject`/`deleteObject`
 *      ("read-only replica ... cannot be mutated locally"). Measured by that test's two CONTROL
 *      cases. `apps/web` offers no rename/delete control on a registry detail page, so this
 *      surfaces only as the `ForeignOriginNotice` badge below.
 *   2. Deleting a foreign-origin RELATIONSHIP — `graph/relationships-repo.ts`'s
 *      `deleteRelationship`. Reached by MOVING a component whose current `contains` edge is a
 *      replica (`components-repo.ts`'s `setComponentService` soft-deletes the old edge first).
 *      The decisive origin is the EDGE's, never the component's — an ASSIGN (no edge yet) is a
 *      pure `createRelationship`, which never consults its endpoints' origins and succeeds.
 *      Measured: "MOVE across a FOREIGN-ORIGIN contains edge 409s".
 *   3. Merging in a foreign-origin LOSER — `coordination/component-merge-repo.ts` soft-deletes the
 *      loser via `deleteObject` (case 1). The SURVIVOR's origin is irrelevant: the only write
 *      against it is `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings`.
 *      Measured: "merge 409s when the LOSER is foreign-origin".
 *
 * NOT gated, because measured ALLOWED: PUT/DELETE/PATCH `/executors/:idOrUrn/binding` (a binding is
 * per-(org,target,type) LOCAL config — `db/schema.ts`'s `executor_bindings` has no
 * `origin_domain_id` column at all, and `routes/executors.ts` checks only `object:write` RBAC on
 * the target); assigning a foreign-origin component to a service; moving it across a
 * locally-originated edge; merging INTO a foreign-origin survivor; and accept/rollback/cancel on a
 * change (the transition verbs write the `changes` state-machine row and never route through
 * `updateObject`, so they answer a foreign-origin change identically to a local one).
 *
 * HOW THE UI LEARNS "OWN DOMAIN": `GET /federation/self` (SDK: `client.federation.self()`) returns
 * `{domainId, name, role, publicKey}` for THIS instance — an SDK-reachable mechanism that already
 * existed (M6/M9.3) but was never consumed by the web app.
 */
export function useOwnDomainId(): { domainId: string | undefined; isLoading: boolean } {
  const q = useQuery({
    queryKey: federationSelfKey(),
    queryFn: () => client.federation.self(),
    // This instance's own domain id is immutable for the life of the deployment (self-repo.ts's
    // module doc: created once, lazily, and never reassigned by a later `scp federation init`) —
    // no reason to ever refetch/garbage-collect it mid-session.
    staleTime: Infinity,
    gcTime: Infinity
  });
  return { domainId: q.data?.domainId, isLoading: q.isLoading };
}

/**
 * Pure predicate — the ONE place "is this row foreign-origin" is decided, applied to whichever row
 * the server actually guards: an OBJECT for cases 1/3 above, a RELATIONSHIP for case 2 (both wire
 * shapes carry `originDomainId` — `packages/schemas/src/graph.ts`). `ownDomainId === undefined`
 * (still loading, or the `federation/self` call errored) is treated as "not (yet) known to be
 * foreign", so missing data can never fabricate a block on a write the server would accept.
 */
export function isForeignOriginObject(
  originDomainId: string | null | undefined,
  ownDomainId: string | undefined
): boolean {
  if (!originDomainId || !ownDomainId) return false;
  return originDomainId !== ownDomainId;
}

/**
 * THE MOVE GATE — `registry-detail.tsx`'s ComponentServiceCard.
 *
 * Takes the component's CURRENT `contains` edge and NOTHING ELSE, because the edge is the only row
 * the server guards here: `components-repo.ts`'s `setComponentService` soft-deletes it before
 * creating the new one, and `deleteRelationship` 409s on a foreign-origin edge. `undefined` (no
 * edge yet) is an ASSIGN — a pure `createRelationship`, which never consults its endpoints' origins
 * — so it is never blocked. Deliberately does NOT accept the component: the first cut gated on the
 * component's own origin, which blocked two writes the server accepts (ASSIGN on a foreign
 * component, MOVE across a local edge) and missed the one it refuses. Measured in
 * `apps/server/src/federation/foreign-origin-writes.integration.test.ts`.
 */
export function isMoveBlocked(
  currentContainsEdge: { originDomainId: string } | undefined,
  ownDomainId: string | undefined
): boolean {
  return isForeignOriginObject(currentContainsEdge?.originDomainId, ownDomainId);
}

/**
 * THE MERGE GATE — `registry-detail.tsx`'s MergeComponentCard.
 *
 * Takes the LOSER candidate and NOTHING ELSE. `component-merge-repo.ts` soft-deletes the loser via
 * `deleteObject` (409 on a replica); the only write against the SURVIVOR is
 * `repointExecutorBindingTarget`, an unguarded UPDATE of `executor_bindings`, so the survivor's
 * origin is irrelevant. Both halves measured in the same integration test.
 */
export function isMergeLoserBlocked(
  loser: { originDomainId: string },
  ownDomainId: string | undefined
): boolean {
  return isForeignOriginObject(loser.originDomainId, ownDomainId);
}

/**
 * The props a write control spreads to disable itself + explain why.
 *
 * `refusal` is a required parameter and is intended to state the concrete server refusal this gate
 * mirrors, naming the repo function that performs it — every CURRENT call site does this (see
 * `registry-detail.tsx`). TypeScript enforces only that some string is supplied at each call site,
 * not that its content names anything real (`replicaGuard(true, "")` compiles) — the discipline of
 * citing a measured refusal is convention pinned by `replica-origin.test.tsx`'s examples, not a
 * compile-time guarantee. This is still the whole correction over the previous signature, which
 * took no argument at all and emitted one blanket "commander-origin config can only be changed at
 * its origin" for five controls, four of which the server happily accepted.
 *
 * A pure function (no hooks), so it's directly unit-testable via `renderToStaticMarkup` — the same
 * idiom `service-board-honesty.test.tsx` uses for `isUnknown`/`UnknownHere`.
 */
export function replicaGuard(
  foreign: boolean,
  refusal: string
): { disabled: boolean; title?: string } {
  return foreign
    ? {
        disabled: true,
        title:
          `${refusal} It is authoritatively owned by another federation domain ` +
          `(single-writer authority) and can only be changed at its origin.`
      }
    : { disabled: false };
}

/** The honest provenance marker — deliberately the SAME dashed-amber-border idiom
 *  `service-board.tsx`'s `UnknownHere` uses, so an operator reads one visual language for "this
 *  instance is not the authority here" everywhere in the app rather than a bespoke one per feature.
 *  Its title states ownership plus the ONE refusal measured for the object itself (that
 *  integration test's two CONTROL cases: PATCH and DELETE both 409) — deliberately NOT a blanket
 *  "nothing works here", because local config against this object (executor bindings, service
 *  assignment) demonstrably still does. */
export function ForeignOriginNotice({ originDomainId }: { originDomainId: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800"
      title={`Authoritatively owned by domain ${originDomainId} — a read-only replica here (single-writer authority). Its own fields cannot be edited or deleted locally; local config such as executor bindings is unaffected.`}
      data-testid="foreign-origin-notice"
    >
      read-only replica
    </span>
  );
}
