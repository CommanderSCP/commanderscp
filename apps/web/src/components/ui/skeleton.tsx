import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * §2.9 — replaces every text-only "Loading…" app-wide. One line of layout-matching skeleton per
 * surface; never reproduce a full layout in skeleton form.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-slate-200", className)} {...props} />;
}

export function SkeletonRows({ n = 3 }: { n?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** Card-shaped placeholder: a card shell with a label bar and a value bar. */
export function SkeletonCard(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-hidden="true">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="mt-3 h-8 w-1/2" />
    </div>
  );
}
