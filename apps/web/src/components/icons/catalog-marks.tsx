import { createLucideIcon, type IconNode } from "lucide-react";

/**
 * THE CATALOG MARKS (owner direction, 2026-08-11): the service → assembly → component trio in the
 * same military-materiel language as the federation role insignia (federation-roles.tsx) — built
 * via `createLucideIcon`, hand-drawn on the 24px grid, air-gap-inert inline path data.
 *
 *   - SERVICE — a GUIDON: the swallow-tail unit standard. The service is the thing an organization
 *     owns end-to-end; everything beneath it rallies to this flag.
 *   - ASSEMBLY — a CRATE STACK: materiel grouped for movement. An assembly is a macro-component
 *     "built and released as a set" (GLOSSARY) — literally components stacked together.
 *   - COMPONENT — a single cross-braced AMMO CRATE: the unit that actually ships. Components are
 *     what releases move through the pipeline, and a crate is the thing that moves.
 *
 * The trio is ordinal on purpose: flag above stack above crate mirrors the containment ladder.
 * Path data is exported separately so `lib/graph-glyphs.ts` can rasterize the SAME drawings into
 * Cytoscape node glyphs — one source of truth per mark, never two drawings that drift.
 */

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

export const ServiceGuidon = createLucideIcon("ServiceGuidon", SERVICE_GUIDON_PATHS);
export const AssemblyStack = createLucideIcon("AssemblyStack", ASSEMBLY_STACK_PATHS);
export const ComponentCrate = createLucideIcon("ComponentCrate", COMPONENT_CRATE_PATHS);
