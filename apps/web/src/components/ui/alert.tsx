import * as React from "react";
import { CircleAlert, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * The one callout treatment (design spec §2.3) — every hand-rolled `border-red-300 bg-red-50 …`
 * block converges here, starting with `error-boundary.tsx` and `query-error.tsx`. Tints follow
 * §1.5 with the §2.3 `text-*-800` text weight.
 */
export type AlertTone = "info" | "warning" | "danger" | "neutral";

const TONE_CLASSES: Record<AlertTone, string> = {
  info: "border-blue-200 bg-blue-50 text-blue-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-800",
  neutral: "border-slate-200 bg-slate-50 text-slate-800"
};

const TONE_ICONS: Record<AlertTone, LucideIcon | null> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
  neutral: null
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone: AlertTone;
  /** Optional bold first line. (ReactNode, not the HTML tooltip attribute.) */
  title?: React.ReactNode;
  /** Overrides the tone's default icon; pass `null` to render none. */
  icon?: LucideIcon | null;
}

export function Alert({
  tone,
  title,
  icon,
  className,
  children,
  ...props
}: AlertProps): React.JSX.Element {
  const Icon = icon === undefined ? TONE_ICONS[tone] : icon;
  return (
    <div className={cn("rounded-lg border p-3 text-sm", TONE_CLASSES[tone], className)} {...props}>
      <div className="flex gap-2">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0" strokeWidth={2} aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          {title !== undefined && <p className="font-medium">{title}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}
