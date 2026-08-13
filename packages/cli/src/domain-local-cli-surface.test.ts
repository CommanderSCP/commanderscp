import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./cli.js";

/**
 * M20 (ADR-0031) — THE CLI HALF OF THE DOMAIN-LOCAL SURFACE.
 *
 * Charter principle 3 is API → SDK → CLI → IaC → UI, and a capability that stops at the SDK is a
 * parity hole. Two things need a witness here, and neither is about wording for its own sake:
 *
 *  1. **Every typed registry gets the flag.** `--domain-local` is added inside ONE factory
 *     (`registerTypedResourceCrud`) that generates the command set for every registered type, so a
 *     regression would silently drop it from all of them at once. Asserting across the whole list —
 *     derived from the program itself rather than retyped — is what makes "every registry" a claim
 *     rather than a hope.
 *
 *  2. **Publish is a VERB, and its help says the thing that cannot be undone.** `publish` is
 *     one-way: federation has no un-send. An operator meets that fact either in the help text or by
 *     discovering it afterwards, so the word "one-way" being present is a real requirement, not
 *     decoration. Equally, there must be NO `unpublish`/`--no-domain-local` anywhere — the absence
 *     is the guarantee, and an absence is exactly what nobody notices regressing.
 */

function findCommand(root: Command, path: string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    current = current?.commands.find((c) => c.name() === name);
    if (current === undefined) return undefined;
  }
  return current;
}

/** The typed-registry commands, identified by having BOTH `register` and `upsert` — the shape only
 *  `registerTypedResourceCrud` produces. Derived, so a newly registered type is covered the day it
 *  is added instead of the day someone remembers to extend a hardcoded list. */
function typedRegistryCommands(program: Command): Command[] {
  return program.commands.filter(
    (c) =>
      c.commands.some((s) => s.name() === "register") &&
      c.commands.some((s) => s.name() === "upsert")
  );
}

describe("scp <type> — the domain-local operator surface (ADR-0031)", () => {
  const program = buildProgram();
  const registries = typedRegistryCommands(program);

  it("there ARE typed registries to check — the derivation cannot pass by finding nothing", () => {
    expect(registries.length).toBeGreaterThanOrEqual(5);
    expect(registries.map((c) => c.name())).toContain("service");
    expect(registries.map((c) => c.name())).toContain("component");
  });

  it("EVERY typed registry's `register` accepts --domain-local, and says it needs federation:write", () => {
    for (const registry of registries) {
      const register = findCommand(registry, ["register"]);
      expect(register, `${registry.name()} has no register command`).toBeDefined();
      const option = register!.options.find((o) => o.long === "--domain-local");
      expect(option, `${registry.name()} register is missing --domain-local`).toBeDefined();
      // The permission is the surprising part — `object:write` is not enough — so it belongs in the
      // help rather than in a 403 the operator has to interpret.
      expect(option!.description).toMatch(/federation:write/i);
    }
  });

  it("EVERY typed registry's `upsert` accepts --domain-local, so IaC (`scp apply`) has parity", () => {
    for (const registry of registries) {
      const upsert = findCommand(registry, ["upsert"]);
      expect(upsert, `${registry.name()} has no upsert command`).toBeDefined();
      expect(
        upsert!.options.find((o) => o.long === "--domain-local"),
        `${registry.name()} upsert is missing --domain-local`
      ).toBeDefined();
    }
  });

  it("EVERY typed registry has a `publish` VERB whose help states it is ONE-WAY", () => {
    for (const registry of registries) {
      const publish = findCommand(registry, ["publish"]);
      expect(publish, `${registry.name()} has no publish command`).toBeDefined();
      // Not a wording nit: an operator who does not learn this from `--help` learns it from an
      // irreversible action. `one-way` is the phrase, matched case-insensitively.
      expect(publish!.description()).toMatch(/one-way/i);
    }
  });

  it("there is NO un-publish door anywhere in the CLI — the absence IS the guarantee", () => {
    // Federation has no un-send, so shared → domain-local must stay inexpressible. A future
    // `unpublish` command, or a `--no-domain-local` flag on any verb, would be a door to a state the
    // system cannot deliver — and would be easy to add without anyone noticing, which is why this is
    // asserted rather than assumed.
    for (const registry of registries) {
      expect(
        registry.commands.map((c) => c.name()),
        `${registry.name()} exposes an un-publish command`
      ).not.toContain("unpublish");
      for (const sub of registry.commands) {
        const negations = sub.options
          .map((o) => o.long)
          .filter((long): long is string => typeof long === "string")
          .filter((long) => /^--no-domain-local$/.test(long));
        expect(
          negations,
          `${registry.name()} ${sub.name()} exposes ${negations.join(", ")}`
        ).toEqual([]);
      }
    }
  });

  it("`update` cannot express locality at all — immutability is structural in the CLI too", () => {
    // Mirrors the server, where `UpdateObjectRequestSchema` has no `domainLocal` and no UPDATE
    // statement names the column. A CLI flag here would produce a request the server refuses, which
    // is a worse operator experience than the capability simply not existing.
    for (const registry of registries) {
      const update = findCommand(registry, ["update"]);
      if (!update) continue;
      expect(
        update.options.find((o) => o.long === "--domain-local"),
        `${registry.name()} update exposes --domain-local`
      ).toBeUndefined();
    }
  });
});
