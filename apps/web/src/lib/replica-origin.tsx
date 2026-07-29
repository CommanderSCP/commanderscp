import { useQuery } from "@tanstack/react-query";
import { client } from "./client";
import { federationSelfKey } from "./query-client";

/**
 * M16.3 P2 — the single-writer-authority census fix: a component/service/deployment-target/domain
 * held as a READ-ONLY REPLICA of another domain's commander-origin config (`originDomainId !==
 * this instance's own domain id`, `graph/objects-repo.ts`'s module doc — "single-writer authority
 * enforced by originDomainId alone") must never OFFER a write control the server already refuses
 * (`updateObject`/`deleteObject`/`createRelationship`/`deleteRelationship`'s "read-only replica...
 * cannot be mutated locally" guard). Before this, `apps/web/src/routes/registry-detail.tsx` had
 * ZERO occurrences of `originDomainId`/`readOnly`/`isReplica` and rendered Detach/Repurpose/Assign
 * unconditionally on ANY object, foreign-origin or not.
 *
 * HOW THE UI LEARNS "OWN DOMAIN": `GET /federation/self` (SDK: `client.federation.self()`) already
 * returns `{domainId, name, role, publicKey}` for THIS instance — an SDK-reachable mechanism that
 * already existed (M6/M9.3) but was never consumed by the web app. `useOwnDomainId` below is the
 * one hook that reads it; every gated write control in `registry-detail.tsx`/`change-detail.tsx`
 * shares this SAME comparison rather than inventing a second "am I foreign" idiom, mirroring how
 * `service-board.tsx`'s `isUnknown`/`UnknownHere` is the ONE honesty idiom for observability
 * (`service-board.tsx:41-58`) rather than a per-field bespoke check.
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
 * Pure predicate — the ONE place "is this object foreign-origin" is decided, so every write
 * control below (and its test) shares the identical rule. `ownDomainId === undefined` (still
 * loading, or the `federation/self` call errored) is treated as "not (yet) known to be foreign" —
 * callers that need a fail-closed loading state should additionally gate on
 * `useOwnDomainId().isLoading` themselves (mirrors how `registry-detail.tsx` already renders a
 * full-page "Loading…" state before any control renders at all, so in practice this resolves
 * before a user can interact with anything).
 */
export function isForeignOriginObject(
  originDomainId: string | null | undefined,
  ownDomainId: string | undefined
): boolean {
  if (!originDomainId || !ownDomainId) return false;
  return originDomainId !== ownDomainId;
}

/**
 * The props a write control (Button/Select/etc.) spreads to disable itself + explain why, for a
 * foreign-origin object. A pure function (no hooks) so it's directly unit-testable —
 * `registry-detail-replica-honesty.test.tsx` renders the result via `renderToStaticMarkup`, the
 * same idiom `service-board-honesty.test.tsx` uses for `isUnknown`/`UnknownHere`.
 */
export function replicaGuard(foreign: boolean): { disabled: boolean; title?: string } {
  return foreign
    ? {
        disabled: true,
        title:
          "Read-only replica — this object is authoritatively owned by another federation domain " +
          "(single-writer authority). Commander-origin config can only be changed at its origin."
      }
    : { disabled: false };
}

/** The honest "read-only replica" marker — deliberately the SAME dashed-amber-border idiom
 *  `service-board.tsx`'s `UnknownHere` uses for an unobservable field, so an operator learns to
 *  read one visual language for "this instance cannot act here" everywhere in the app, rather than
 *  a second bespoke one per feature. */
export function ForeignOriginNotice({ originDomainId }: { originDomainId: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800"
      title={`Authoritatively owned by domain ${originDomainId} — a read-only replica here (single-writer authority); it cannot be mutated locally.`}
      data-testid="foreign-origin-notice"
    >
      read-only replica
    </span>
  );
}
