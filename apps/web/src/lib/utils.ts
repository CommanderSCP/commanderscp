import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's standard `cn` helper — merges Tailwind classes, last one wins on conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The ONE focus treatment (design spec §2.10). Applied by every interactive primitive (Button,
 * Input, Select, nav links, PageHeader back links, StatCard links) and by any inline link a route
 * renders itself. Indigo is the accent (spec standing decisions) — focus is one of its four
 * sanctioned homes, so no other ring color may appear anywhere.
 */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-army-600 focus-visible:ring-offset-2";
