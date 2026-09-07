import * as React from "react";
import { Check, CircleAlert } from "lucide-react";
import { cn } from "../../lib/utils";

/** §2.11 — one-line MUTATION feedback. See docs/web.md §110. */
export interface NoticeProps extends React.HTMLAttributes<HTMLParagraphElement> {
  tone: "success" | "danger";
}

export function Notice({ tone, className, children, ...props }: NoticeProps): React.JSX.Element {
  const Icon = tone === "success" ? Check : CircleAlert;
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-sm",
        tone === "success" ? "text-emerald-700" : "text-red-700",
        className
      )}
      {...props}
    >
      <Icon className="size-4 shrink-0" strokeWidth={2} aria-hidden="true" />
      {children}
    </p>
  );
}
