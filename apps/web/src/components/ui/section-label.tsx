import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * The canonical eyebrow (design spec §1.3/§2.6) — `slate-500`, never `slate-400`. Replaces every
 * copy-pasted eyebrow string; authored in sentence case, uppercased by CSS (copy rule 8).
 */
export interface SectionLabelProps extends React.HTMLAttributes<HTMLElement> {
  /** Element to render — `dt` inside KeyValueList, heading tags where semantics call for one. */
  as?: "div" | "span" | "dt" | "h2" | "h3";
}

export function SectionLabel({
  as: Tag = "div",
  className,
  ...props
}: SectionLabelProps): React.JSX.Element {
  return (
    <Tag
      className={cn("text-xs font-medium uppercase tracking-wide text-slate-500", className)}
      {...props}
    />
  );
}
