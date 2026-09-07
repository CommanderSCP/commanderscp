import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * §2.8 — the one zero-result treatment. Copy rule 5: the message is "No ⟨noun⟩ yet." with a
 * specific noun; "Nothing." is banned.
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  message: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function EmptyState({
  icon: Icon,
  message,
  action,
  className,
  "data-testid": testId
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn("flex flex-col items-center justify-center gap-3 py-10 text-center", className)}
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-slate-100">
        <Icon className="size-5 text-slate-400" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="text-sm text-slate-700">{message}</p>
      {action}
    </div>
  );
}
