import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * §2.12 table treatment: the wrapper carries the surface (`rounded-lg border`) and horizontal
 * scrolling, the header row is a `bg-army-50` band of eyebrow-type `th`s, rows divide with
 * `divide-y` and hover `bg-army-50/60`. Routes never restyle these pieces individually.
 */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      // Army-50 header band (owner, 2026-08-11): the tables are where "bars" carry the theme's green
      // undertone; the khaki tint stays far enough from the amber-50 unknown pills to not read as
      // a warning strip.
      className={cn("bg-army-50 [&_tr]:border-b [&_tr]:border-army-200", className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-slate-200", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-army-50/60", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        // Eyebrow type (§1.3) — slate-500, never slate-400.
        "px-3 py-2.5 text-left align-middle text-xs font-medium uppercase tracking-wide text-slate-500",
        className
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2.5 align-middle text-sm", className)} {...props} />;
}
