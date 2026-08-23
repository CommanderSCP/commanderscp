import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { cn, focusRing } from "../../lib/utils";

/**
 * `default` is the army-olive accent (design spec §2.12; olive since 2026-08-11) — it lands on every primary action (Sign in,
 * New, Create Campaign, Accept). Status colors never appear here; `destructive` is the only
 * exception and stays red. Every variant carries the shared focus ring (§2.10).
 */
const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    focusRing
  ),
  {
    variants: {
      variant: {
        default: "bg-army-700 text-white hover:bg-army-600",
        destructive: "bg-red-600 text-white hover:bg-red-700",
        outline: "border border-slate-300 bg-white text-slate-900 hover:bg-slate-100",
        ghost: "text-slate-900 hover:bg-slate-100",
        link: "text-slate-900 underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Optional leading lucide icon at `size-4` (spec §2.12/§1.6). */
  icon?: LucideIcon;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, icon: Icon, children, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props}>
      {Icon && <Icon className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />}
      {children}
    </button>
  )
);
Button.displayName = "Button";
