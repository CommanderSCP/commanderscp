import type { ChangeState } from "@scp/sdk";
import type { BadgeProps } from "../components/ui/badge";

/** Change `state` -> Badge variant. See docs/web.md §116. */
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
