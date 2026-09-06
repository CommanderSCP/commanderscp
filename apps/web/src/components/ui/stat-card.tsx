import * as React from "react";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { cn, focusRing } from "../../lib/utils";
import { Card, CardContent } from "./card";
import { SectionLabel } from "./section-label";

type RouterLinkProps = React.ComponentProps<typeof Link>;

/**
 * §2.5 — one stat tile for dashboard registry tiles, identity count cards, and the service-board
 * summary stats. `value` is optional on purpose: a count that was never fetched shows a tile
 * without a number, not a fabricated "0" (§4A).
 */
export interface StatCardProps {
  /** Eyebrow label (§1.3). */
  label: React.ReactNode;
  /** Emphasis value (§1.3, `tabular-nums`). Omit when the figure is not known. */
  value?: React.ReactNode;
  icon?: LucideIcon;
  /** Route path — makes the whole card a Link with hover + focus treatments. */
  to?: RouterLinkProps["to"];
  /** Path params for `to` when the route has dynamic segments. */
  params?: Record<string, string>;
  badge?: React.ReactNode;
  /** Caption-type footnote (§1.3). */
  hint?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  to,
  params,
  badge,
  hint,
  className,
  "data-testid": testId
}: StatCardProps): React.JSX.Element {
  const card = (
    <Card
      size="compact"
      data-testid={to === undefined ? testId : undefined}
      className={cn(
        to !== undefined && "transition-colors hover:border-slate-300 hover:bg-slate-50",
        className
      )}
    >
      {/* No CardHeader, so the compact content pad needs its top edge restored. */}
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-2">
          <SectionLabel>{label}</SectionLabel>
          {Icon && (
            <Icon
              className="size-5 shrink-0 text-slate-400"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          )}
        </div>
        {value !== undefined && (
          <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
        )}
        {badge !== undefined && <div className="mt-1">{badge}</div>}
        {hint !== undefined && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      </CardContent>
    </Card>
  );

  if (to === undefined) return card;
  return (
    <Link
      to={to}
      // Same cast as PageHeader: the non-generic Link props extraction drops the object-params
      // arm of the union; the object form is what TanStack accepts at runtime.
      params={params as unknown as RouterLinkProps["params"]}
      data-testid={testId}
      className={cn("block rounded-lg", focusRing)}
    >
      {card}
    </Link>
  );
}
