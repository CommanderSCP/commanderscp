import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * The soft-tint status system (design spec §1.5/§2.2) — six tones, no solid saturated fills.
 *
 * `unknown` is the ONLY sanctioned rendering of the honesty pill ("unobservable where an operator
 * should notice"): its literal `text-amber-700` and `border-dashed` classes are test-pinned
 * (`service-board-honesty.test.tsx`) and must never be renamed. Structurally-expected absence is
 * NOT a badge — it renders as `—` in `text-slate-400` with a `title=""` tooltip (spec §1.5).
 *
 * The legacy names (`default`/`secondary`/`destructive`/`outline`/`info`/`success`) are deprecated
 * ALIASES onto tones so untouched call sites keep compiling mid-migration; they are deleted at the
 * end of group E (spec §2.2).
 */
const badgeVariants = cva(
    // whitespace-nowrap: a rounded-full pill that wraps to two or three lines renders as an egg
  // (owner bug report, 2026-08-11 — the outposts table). A badge is a label; if its text is long
  // enough to wrap, the copy is wrong, not the layout.
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border font-medium transition-colors",
  {
    variants: {
      variant: {
        neutral: "border-transparent bg-slate-100 text-slate-700",
        info: "border-blue-200 bg-blue-50 text-blue-700",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-800",
        danger: "border-red-200 bg-red-50 text-red-700",
        unknown: "border-dashed border-amber-300 bg-amber-50 text-amber-700",
        // Deprecated aliases (spec §2.2) — same rendering as the tone they map to.
        default: "border-transparent bg-slate-100 text-slate-700",
        secondary: "border-transparent bg-slate-100 text-slate-700",
        destructive: "border-red-200 bg-red-50 text-red-700",
        outline: "border-transparent bg-slate-100 text-slate-700"
      },
      size: {
        // The only size (spec §2.2): `sm`, default.
        sm: "px-2 py-0.5 text-xs"
      }
    },
    defaultVariants: { variant: "default", size: "sm" }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  /** Optional leading lucide icon, rendered at `size-3.5` per spec §1.6. */
  icon?: LucideIcon;
}

export function Badge({ className, variant, size, icon: Icon, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {Icon && <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />}
      {children}
    </div>
  );
}
