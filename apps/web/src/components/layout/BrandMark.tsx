import * as React from "react";
import { CommanderStar } from "../icons/federation-roles";
import { cn } from "../../lib/utils";

/**
 * The one brand mark (design spec §3.3): an army-olive tile holding the COMMANDER STAR in white —
 * the official logo (owner decision 2026-08-11), replacing the placeholder `Waypoints` glyph. The
 * SAME drawing as the commander role badge (icons/federation-roles.tsx) and the favicon
 * (public/favicon.svg): one insignia, three surfaces, zero drift. `sm` (size-7 tile) sits beside
 * the sidebar wordmark; `lg` (size-10) is reused centered on /login (§3.4). Stroke width follows
 * §1.6: 2 at 16px, 1.75 at 20px.
 */
export function BrandMark({ size = "sm" }: { size?: "sm" | "lg" }): React.JSX.Element {
  const large = size === "lg";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-army-600",
        large ? "size-10" : "size-7"
      )}
      aria-hidden="true"
    >
      <CommanderStar
        className={cn("text-white", large ? "size-5" : "size-4")}
        strokeWidth={large ? 1.75 : 2}
      />
    </span>
  );
}
