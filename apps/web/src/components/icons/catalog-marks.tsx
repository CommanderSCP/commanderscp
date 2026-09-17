import { createLucideIcon, type IconNode } from "lucide-react";

/** THE CATALOG MARKS. See docs/web.md §57. */

export const SERVICE_GUIDON_PATHS: IconNode = [
  ["path", { d: "M6 22V3.5", key: "pole" }],
  ["path", { d: "M4 22h4", key: "base" }],
  // Swallow-tail: hoist at the pole, fly end notched back toward it.
  ["path", { d: "M6 4.5h12l-4 3.75 4 3.75H6Z", key: "flag" }]
];

export const ASSEMBLY_STACK_PATHS: IconNode = [
  ["rect", { x: "4", y: "13", width: "16", height: "8", rx: "1", key: "bottom" }],
  ["rect", { x: "7.5", y: "4", width: "9", height: "7", rx: "1", key: "top" }],
  ["path", { d: "M12 13v8", key: "seam" }]
];

export const COMPONENT_CRATE_PATHS: IconNode = [
  ["rect", { x: "4.5", y: "6", width: "15", height: "13", rx: "1", key: "crate" }],
  ["path", { d: "M4.5 6.5 19.5 18.5", key: "brace-a" }],
  ["path", { d: "M19.5 6.5 4.5 18.5", key: "brace-b" }]
];

// A ranging reticle: outer ring, a small centre ring, and four short cardinal ticks standing off
// the outer ring — never a full crosshair, which would read busy at 14-16px. Owner, 2026-09-11.
export const TARGET_RETICLE_PATHS: IconNode = [
  ["circle", { cx: "12", cy: "12", r: "7", key: "outer-ring" }],
  ["circle", { cx: "12", cy: "12", r: "1.5", key: "centre-ring" }],
  ["path", { d: "M12 2.5v1.7", key: "tick-n" }],
  ["path", { d: "M12 19.8v1.7", key: "tick-s" }],
  ["path", { d: "M2.5 12h1.7", key: "tick-w" }],
  ["path", { d: "M19.8 12h1.7", key: "tick-e" }]
];

export const ServiceGuidon = createLucideIcon("ServiceGuidon", SERVICE_GUIDON_PATHS);
export const AssemblyStack = createLucideIcon("AssemblyStack", ASSEMBLY_STACK_PATHS);
export const ComponentCrate = createLucideIcon("ComponentCrate", COMPONENT_CRATE_PATHS);
export const TargetReticle = createLucideIcon("TargetReticle", TARGET_RETICLE_PATHS);
