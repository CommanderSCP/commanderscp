import * as React from "react";
import { CommanderStar, OutpostFort } from "../icons/federation-roles";
import { cn } from "../../lib/utils";

/**
 * The brand mark (design spec §3.3): an army-olive tile holding the instance's insignia in white.
 *
 * SITE-SHAPED (outpost-ui.md §9, owner 2026-08-14): the commander site wears the COMMANDER STAR —
 * the official logo — and the outpost site wears the OUTPOST FORT. Same drawings as the role badges
 * (icons/federation-roles.tsx) and the two favicons (public/favicon*.svg): one insignia per role,
 * three surfaces, zero drift.
 *
 * `role` is the INSTALL-TIME instance role from `/auth/me` and is therefore POST-AUTH ONLY. The
 * login page passes nothing and gets the star on every instance, deliberately: telling an
 * unauthenticated visitor "this box is an outpost" is topology disclosure a CDS-adjacent deployment
 * must not make (the same rule the role chip has always followed). `sm` (size-7 tile) sits beside
 * the sidebar wordmark; `lg` (size-10) is the centered login mark. Stroke width per §1.6.
 */
export function BrandMark({
  size = "sm",
  role
}: {
  size?: "sm" | "lg";
  role?: "commander" | "outpost" | "retrans";
}): React.JSX.Element {
  const large = size === "lg";
  const Insignia = role === "outpost" ? OutpostFort : CommanderStar;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-army-600",
        large ? "size-10" : "size-7"
      )}
      aria-hidden="true"
      data-insignia={role === "outpost" ? "outpost" : "commander"}
    >
      <Insignia
        className={cn("text-white", large ? "size-5" : "size-4")}
        strokeWidth={large ? 1.75 : 2}
      />
    </span>
  );
}

/**
 * Swap the browser-tab icon to match the site — called by the shell once the role is known.
 * Idempotent; a no-op when the link already points at the right file. Static default in
 * index.html is the commander star (see the favicon files' own comments for why the outpost
 * variant is never the pre-auth default).
 */
export function applySiteFavicon(role: "commander" | "outpost" | "retrans" | undefined): void {
  if (typeof document === "undefined") return;
  const href = role === "outpost" ? "/favicon-outpost.svg" : "/favicon.svg";
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
