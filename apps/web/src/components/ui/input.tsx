import * as React from "react";
import { cn, focusRing } from "../../lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // §2.12: rounded-md + border-slate-300 (interactive controls get the darker border, §1.2)
        // + the shared focus ring (§2.10).
        "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";
