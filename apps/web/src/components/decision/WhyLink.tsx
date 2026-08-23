import { Link } from "@tanstack/react-router";
import { cn, focusRing } from "../../lib/utils";

/**
 * The shared "Why?" link (design spec §2.13) — the explainability affordance beside any blocked
 * action. It always lands on the `#decision-<id>` row of a change's Decisions timeline (never a
 * separate page — every Decision that could block a change is already in that list).
 *
 * MODULE CONTRACT for later adopters (campaign-detail.tsx): same-page use passes only
 * `decisionId` (anchor + smooth scroll, default testid `why-link`); cross-page use adds `changeId`
 * (router Link with the decision hash) and its own `data-testid` when a page pins one.
 */
export function WhyLink({
  decisionId,
  changeId,
  "data-testid": testId = "why-link"
}: {
  decisionId: string;
  /** When set, navigates to that change's detail page; otherwise anchors within this page. */
  changeId?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  const className = cn("rounded font-medium text-red-700 underline hover:text-red-900", focusRing);
  if (changeId) {
    return (
      <Link
        to="/changes/$id"
        params={{ id: changeId }}
        hash={`decision-${decisionId}`}
        className={className}
        data-testid={testId}
      >
        Why?
      </Link>
    );
  }
  return (
    <a
      href={`#decision-${decisionId}`}
      className={className}
      data-testid={testId}
      // Highlighting is the target row's job (it checks the mutation error's decision id); the
      // smooth scroll here is what makes "Why?" visibly land somewhere.
      onClick={() => {
        document
          .getElementById(`decision-${decisionId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }}
    >
      Why?
    </a>
  );
}
