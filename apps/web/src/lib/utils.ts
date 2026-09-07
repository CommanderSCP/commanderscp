import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui's standard `cn` helper — merges Tailwind classes, last one wins on conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** The ONE focus treatment. See docs/web.md §146. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-army-600 focus-visible:ring-offset-2";
