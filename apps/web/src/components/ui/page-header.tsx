import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn, focusRing } from "../../lib/utils";

type RouterLinkProps = React.ComponentProps<typeof Link>;

export interface PageHeaderProps {
  /** The page h1 — §1.3 page-title type, and the ONLY h1 a route may render (§2.1). */
  title: React.ReactNode;
  /** §1.3 page-description type, under the title. */
  description?: React.ReactNode;
  /** Right-aligned action slot (primary Buttons live here). */
  actions?: React.ReactNode;
  /** Route path for the back link above the title — replaces every `← X` literal (§2.1). */
  backTo?: RouterLinkProps["to"];
  /** Path params for `backTo` when the route has dynamic segments. */
  backParams?: Record<string, string>;
  backLabel?: React.ReactNode;
  /** Optional row of Badges/fragments under the description (§2.1). */
  meta?: React.ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backParams,
  backLabel,
  meta
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {backTo !== undefined && (
        <Link
          to={backTo}
          // The non-generic `ComponentProps<typeof Link>` extraction keeps only the updater-fn arm
          // of the params union; the object form is valid at runtime, so cast across it.
          params={backParams as unknown as RouterLinkProps["params"]}
          className={cn(
            "mb-1 inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-slate-500 transition-colors hover:text-slate-900",
            focusRing
          )}
        >
          <ArrowLeft className="size-4" strokeWidth={2} aria-hidden="true" />
          {backLabel}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description !== undefined && <p className="text-sm text-slate-500">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {meta !== undefined && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">{meta}</div>
      )}
    </div>
  );
}
