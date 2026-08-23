import { createLucideIcon, type IconNode } from "lucide-react";

/**
 * THE FEDERATION ROLE SYMBOLS (owner direction, 2026-08-11): minimalist, military-flavoured marks
 * for the three service roles of ADR-0004 — commander / outpost / retrans. Built through
 * `createLucideIcon` so they are first-class lucide citizens: same stroke conventions, same
 * `size-*`/`strokeWidth` props, drop-in wherever a `LucideIcon` is accepted (Badge `icon`, NavIcon,
 * EmptyState). Hand-drawn on the 24px grid; inline path data, so the air-gap posture is unchanged.
 *
 * The vocabulary (design spec §1.6 extension):
 *   - COMMANDER — a five-pointed star over a base bar: the general-officer star, the single most
 *     legible "command" mark there is, grounded by the bar so it reads as an insignia rather than
 *     a rating/favourite star. (A figure/portrait was considered and rejected: unreadable at 14px,
 *     and the star IS the military symbol for command.)
 *   - OUTPOST — a crenellated fort tower with a door: the field fortification, distinct at a
 *     glance from every rounded lucide glyph around it.
 *   - RETRANS — an antenna mast with signal arcs on BOTH sides: receive on one flank, resend on
 *     the other — the arcs literally state "retransmission", which one-sided broadcast glyphs
 *     (RadioTower, Antenna) do not.
 */

/** Path data exported for `lib/graph-glyphs.ts` — one drawing per mark, shared between the React
 *  icon and the Cytoscape node glyph so the two can never drift. */
export const COMMANDER_STAR_PATHS: IconNode = [
  [
    "path",
    {
      d: "M12 2.5 14.35 7.85 20.2 8.45 15.85 12.4 17.1 18.15 12 15.2 6.9 18.15 8.15 12.4 3.8 8.45 9.65 7.85Z",
      key: "star"
    }
  ],
  ["path", { d: "M7 21.5h10", key: "bar" }]
];

export const OUTPOST_FORT_PATHS: IconNode = [
  ["path", { d: "M4 21h16", key: "ground" }],
  // Battlement walk: wall up, three merlons (tops y=5) with two notches (y=7), wall down.
  ["path", { d: "M6 21V5h3v2h2V5h2v2h2V5h3v16", key: "tower" }],
  ["path", { d: "M10.5 21v-3.5a1.5 1.5 0 0 1 3 0V21", key: "door" }]
];

export const RETRANS_MAST_PATHS: IconNode = [
  ["circle", { cx: "12", cy: "5.5", r: "1.75", key: "head" }],
  ["path", { d: "M12 7.25V21", key: "mast" }],
  ["path", { d: "M12 14 8 21", key: "leg-l" }],
  ["path", { d: "M12 14 16 21", key: "leg-r" }],
  // Paired arcs, one per flank — the receive/resend statement.
  ["path", { d: "M8.6 8.4A4.5 4.5 0 0 1 8.6 2.6", key: "wave-l" }],
  ["path", { d: "M15.4 8.4A4.5 4.5 0 0 0 15.4 2.6", key: "wave-r" }]
];

export const CommanderStar = createLucideIcon("CommanderStar", COMMANDER_STAR_PATHS);
export const OutpostFort = createLucideIcon("OutpostFort", OUTPOST_FORT_PATHS);
export const RetransMast = createLucideIcon("RetransMast", RETRANS_MAST_PATHS);
