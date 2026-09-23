import type { ObservedMember } from "@scp/schemas";

/**
 * Compile a host-reaching run's Ansible inventory from OBSERVED membership (D25(a), M27.6b).
 *
 * "Inventory is derived from the product, never authored." This function is the whole of why a
 * tenant cannot name the hosts a run reaches: the runner reads a file the server wrote from
 * `infrastructure_members` rows, `run.sh` refuses to start without it, and `params_to_vars.py`
 * refuses the entire `ansible_*` parameter namespace (M27.2) so a parameter cannot reconfigure the
 * connection either.
 *
 * THE INVENTORY IS A SECOND INJECTION SURFACE, and it is not the same one M27.2 closed. Membership
 * is reported by an authenticated subject, but "authenticated" is not "trusted to emit inventory
 * syntax": an INI inventory is line-oriented, so a member id containing a newline could open an
 * `[all:vars]` section and set `ansible_python_interpreter` to anything — reaching code execution
 * without ever touching a tenant parameter. Every field is therefore validated against a strict
 * charset and a violation REFUSES the whole compile rather than escaping or dropping one member: a
 * run against a silently-shortened fleet is worse than a run that did not start.
 */

/** Conservative on purpose. Hostnames, IPv4/IPv6 literals and provider ids all fit; anything that
 *  could terminate a line, open a section, or start a comment does not. */
const SAFE_FIELD = /^[A-Za-z0-9._:\-[\]]+$/;

export class InventoryCompilationError extends Error {}

function assertSafe(kind: "memberId" | "address", value: string): void {
  if (!SAFE_FIELD.test(value)) {
    // The offending value is NOT echoed in full — it is attacker-influenced and this message
    // lands in logs and Decisions. The member id is enough to find the row.
    throw new InventoryCompilationError(
      `refusing to compile an inventory: ${kind} contains characters that are not safe in an ` +
        `inventory file (${value.length} chars, first offending index ` +
        `${[...value].findIndex((c) => !SAFE_FIELD.test(c))})`
    );
  }
}

/**
 * An Ansible INI inventory naming every observed member under `[all]`.
 *
 * The member id is the inventory hostname and the address is `ansible_host`, rather than using the
 * address as the name: a run's logs and evidence then name the STABLE provider id, so the record of
 * what was changed survives the host being readdressed.
 */
export function compileInventory(members: ObservedMember[]): string {
  for (const member of members) {
    assertSafe("memberId", member.memberId);
    assertSafe("address", member.address);
  }
  // Sorted, so the same observed set yields byte-identical inventories across runs — otherwise
  // every run's evidence differs from the last for no reason anyone can act on.
  const lines = [...members]
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
    .map((m) => `${m.memberId} ansible_host=${m.address}`);
  return ["[all]", ...lines, ""].join("\n");
}

/**
 * The addresses a run may reach — the input to the per-run positive network allowlist (M27.6b).
 *
 * Derived from the SAME membership the inventory is compiled from, deliberately: two derivations
 * could disagree, and the shape of that disagreement is an inventory naming a host the network
 * layer forbids (a run that hangs) or, far worse, an allowlist wider than the inventory.
 */
export function egressAllowlistFor(members: ObservedMember[]): string[] {
  for (const member of members) assertSafe("address", member.address);
  return [...new Set(members.map((m) => m.address))].sort();
}
