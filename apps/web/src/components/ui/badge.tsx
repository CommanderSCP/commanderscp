import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-slate-900 text-white",
        secondary: "border-transparent bg-slate-100 text-slate-900",
        destructive: "border-transparent bg-red-600 text-white",
        outline: "border-slate-300 text-slate-900",
        // Added for M3 Change `state`/wave-status color-coding (routes/change-list.tsx,
        // change-detail.tsx) — "in progress" and "success" have no equivalent among the four
        // variants above, so these two extend the existing primitive rather than introduce a new
        // styling approach.
        info: "border-transparent bg-blue-600 text-white",
        success: "border-transparent bg-green-600 text-white"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
