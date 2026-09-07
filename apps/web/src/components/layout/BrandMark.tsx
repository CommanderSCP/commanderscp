import * as React from "react";
import { CommanderStar, OutpostFort } from "../icons/federation-roles";
import { cn } from "../../lib/utils";

/** The brand mark (design spec §3.3). See docs/web.md §63. */
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

/** Swap the browser-tab icon to match the site. See docs/web.md §64. */
export function applySiteFavicon(role: "commander" | "outpost" | "retrans" | undefined): void {
  if (typeof document === "undefined") return;
  const href = role === "outpost" ? "/favicon-outpost.svg" : "/favicon.svg";
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
