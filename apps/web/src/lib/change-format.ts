import type { ChangeState } from "@scp/sdk";
import type { BadgeProps } from "../components/ui/badge";

/**
 * Change `state` -> Badge variant (components/ui/badge.tsx).
 *
 * Lives here rather than on a page because the Changes LIST page was removed (the nav cleanup of
 * 2026-08-10) while four surfaces still colour a change state: change detail, the change pipeline,
 * the service board and the component pipeline. A shared formatter in `lib/` is the honest home for
 * something no single page owns.
 */
export function stateBadgeVariant(state: ChangeState): BadgeProps["variant"] {
  switch (state) {
    case "proposed":
    case "evaluated":
    case "coordinated":
      return "outline";
    case "waiting":
      // M12 P4B: parked on a cross-change prerequisite — a deliberate hold, neither in-flight
      // (`info`) nor failed (`destructive`). `secondary` reads as a neutral pause; Phase 4's richer
      // "Waiting on" UI can introduce a dedicated amber variant if the badge palette grows one.
      return "secondary";
    case "executing":
    case "validating":
      return "info";
    case "accepted":
      return "success";
    case "cancelled":
    case "rolled_back":
      return "destructive";
    default:
      return "secondary";
  }
}
