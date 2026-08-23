import * as React from "react";
import { cn } from "../../lib/utils";
import { SectionLabel } from "./section-label";

/**
 * §2.7 — the one dt/dd treatment (outpost-detail, outposts, federation-status, registry-detail
 * Properties). `tooltip` renders as `title=""` on the pair — the sanctioned home for a full
 * honesty sentence whose visible form is a fragment (copy rule 1).
 */
export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Full-sentence tooltip on the pair (`title` attribute). */
  tooltip?: string;
  /** Mono value type (§1.3) — URNs, ids, versions. */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: KeyValueItem[];
  columns?: 1 | 2;
  className?: string;
}

export function KeyValueList({
  items,
  columns = 1,
  className
}: KeyValueListProps): React.JSX.Element {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-8 gap-y-3",
        columns === 2 && "sm:grid-cols-2",
        className
      )}
    >
      {items.map((item, index) => (
        <div key={index} title={item.tooltip}>
          <SectionLabel as="dt">{item.label}</SectionLabel>
          <dd
            className={cn(
              "mt-0.5",
              item.mono ? "break-all font-mono text-xs text-slate-600" : "text-sm text-slate-700"
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
