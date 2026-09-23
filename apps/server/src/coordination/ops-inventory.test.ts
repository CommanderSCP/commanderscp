import { describe, expect, it } from "vitest";
import {
  InventoryCompilationError,
  compileInventory,
  egressAllowlistFor
} from "./ops-inventory.js";

describe("compileInventory", () => {
  const members = [
    { memberId: "i-002", address: "10.0.0.2" },
    { memberId: "i-001", address: "10.0.0.1" }
  ];

  it("names the STABLE provider id as the host and the address as ansible_host", () => {
    // Not the address as the name: a run's logs and evidence then name the id, so the record of
    // what was changed survives the host being readdressed.
    expect(compileInventory(members)).toBe(
      "[all]\ni-001 ansible_host=10.0.0.1\ni-002 ansible_host=10.0.0.2\n"
    );
  });

  it("is byte-identical for the same observed set regardless of report order", () => {
    // Otherwise every run's evidence differs from the last for no reason anyone can act on.
    expect(compileInventory(members)).toBe(compileInventory([...members].reverse()));
  });

  it("an empty fleet compiles to an inventory with no hosts, not to an error", () => {
    // A group scaled to zero is a real state. The run then has nothing to do, which is correct —
    // failing here would make "no hosts" indistinguishable from "could not read membership".
    expect(compileInventory([])).toBe("[all]\n");
  });

  describe("REFUSES inventory injection — a second surface, not the one M27.2 closed", () => {
    // Membership is reported by an authenticated subject, but authenticated is not "trusted to emit
    // inventory syntax". An INI inventory is line-oriented, so a newline in a member id opens a new
    // directive — reaching code execution without touching a tenant parameter at all.
    const attacks: [string, { memberId: string; address: string }][] = [
      [
        "a newline opening an [all:vars] section",
        { memberId: "i-1\n[all:vars]\nansible_python_interpreter", address: "10.0.0.1" }
      ],
      [
        "a newline in the ADDRESS, which lands after ansible_host=",
        { memberId: "i-1", address: "10.0.0.1\nevil ansible_host=10.9.9.9" }
      ],
      [
        "a space introducing a second token",
        { memberId: "i-1 ansible_user=root", address: "10.0.0.1" }
      ],
      ["an equals sign setting a variable", { memberId: "i=1", address: "10.0.0.1" }],
      ["a comment character", { memberId: "i-1#", address: "10.0.0.1" }]
    ];
    it.each(attacks)("refuses %s", (_label, member) => {
      expect(() => compileInventory([member])).toThrow(InventoryCompilationError);
    });

    it("refuses the WHOLE compile, never just the offending member", () => {
      // A run against a silently-shortened fleet is worse than a run that did not start: the
      // missing hosts look converged.
      expect(() =>
        compileInventory([
          { memberId: "i-ok", address: "10.0.0.1" },
          { memberId: "bad\nid", address: "10.0.0.2" }
        ])
      ).toThrow(InventoryCompilationError);
    });

    it("does not echo the offending value back into the message", () => {
      // It is attacker-influenced and this lands in logs and Decisions.
      try {
        compileInventory([{ memberId: "i-1\n[all:vars]", address: "10.0.0.1" }]);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain("all:vars");
        expect((err as Error).message).toContain("memberId");
      }
    });
  });

  it("accepts the address shapes a real fleet actually has", () => {
    // IPv4, IPv6 and DNS names — the guard must not be so strict it refuses valid estates.
    const real = [
      { memberId: "i-abc123", address: "10.0.0.1" },
      { memberId: "vm-01.prod", address: "2001:db8::1" },
      { memberId: "node_3", address: "host-3.internal.example.com" }
    ];
    expect(() => compileInventory(real)).not.toThrow();
  });
});

describe("egressAllowlistFor", () => {
  it("is derived from the SAME membership the inventory is", () => {
    // Two derivations could disagree, and the shape of that disagreement is either a run that hangs
    // or — far worse — an allowlist wider than the inventory.
    const members = [
      { memberId: "i-002", address: "10.0.0.2" },
      { memberId: "i-001", address: "10.0.0.1" }
    ];
    expect(egressAllowlistFor(members)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("deduplicates hosts that share an address", () => {
    const members = [
      { memberId: "i-001", address: "10.0.0.1" },
      { memberId: "i-002", address: "10.0.0.1" }
    ];
    expect(egressAllowlistFor(members)).toEqual(["10.0.0.1"]);
  });

  it("refuses an unsafe address rather than allowlisting it", () => {
    expect(() => egressAllowlistFor([{ memberId: "i-1", address: "10.0.0.1 0.0.0.0/0" }])).toThrow(
      InventoryCompilationError
    );
  });
});
