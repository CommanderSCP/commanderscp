import { useQuery } from "@tanstack/react-query";
import { client } from "./client";
import { federationSelfKey } from "./query-client";

/** Measured single-writer gating for the web write controls. See docs/web.md §130. */
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

/** The one place foreign-origin is decided, as a predicate. See docs/web.md §131. */
export function isForeignOriginObject(
  originDomainId: string | null | undefined,
  ownDomainId: string | undefined
): boolean {
  if (!originDomainId || !ownDomainId) return false;
  return originDomainId !== ownDomainId;
}

/** THE MOVE GATE. See docs/web.md §132. */
export function isMoveBlocked(
  currentContainsEdge: { originDomainId: string } | undefined,
  ownDomainId: string | undefined
): boolean {
  return isForeignOriginObject(currentContainsEdge?.originDomainId, ownDomainId);
}

/** THE MERGE GATE. See docs/web.md §133. */
export function isMergeLoserBlocked(
  loser: { originDomainId: string },
  ownDomainId: string | undefined
): boolean {
  return isForeignOriginObject(loser.originDomainId, ownDomainId);
}

/** The props a write control spreads to disable itself + explain why. See docs/web.md §134. */
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

/** The honest provenance marker. See docs/web.md §135. */
export function ForeignOriginNotice({
  originDomainId
}: {
  originDomainId: string;
}): React.JSX.Element {
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
