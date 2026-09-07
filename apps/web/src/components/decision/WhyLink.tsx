import { Link } from "@tanstack/react-router";
import { cn, focusRing } from "../../lib/utils";

/** The shared "Why?" link (design spec §2.13). See docs/web.md §35. */
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
