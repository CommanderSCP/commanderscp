import { describe, expect, it } from "vitest";
import type { SyncJournalEntry, SyncScope } from "@scp/schemas";
import {
  entryMatchesScope,
  filterByScope,
  isDomainLocalEntry,
  scopeCarriesChangeObjects
} from "./scope-filter.js";

/** A domain-local entry matches no sync scope, either way. See docs/federation.md §519. */

const ALL_MODES: SyncScope[] = [
  { mode: "full" },
  { mode: "policies_only" },
  { mode: "changes_only" },
  { mode: "status_only" },
  { mode: "custom", labelSelector: { tier: "gold" } }
];

function entry(payload: Record<string, unknown>, kind = "object_upsert"): SyncJournalEntry {
  return {
    id: "0198f2a0-0000-7000-8000-000000000001",
    orgId: "0198f2a0-0000-7000-8000-000000000002",
    originDomainId: "0198f2a0-0000-7000-8000-000000000003",
    sequence: 1,
    entryKind: kind,
    payload,
    contentHash: "sha256:abc",
    baseRevision: null,
    conflict: null,
    prevHash: "sha256:prev",
    rowHash: "sha256:row",
    signature: "sig"
  } as unknown as SyncJournalEntry;
}

describe("ADR-0031 §3: domain-local entries match no sync scope", () => {
  it("is withheld from EVERY scope mode — including `full`", () => {
    const local = entry({ typeId: "component", urn: "urn:scp:o:component:vpc", domainLocal: true });
    for (const scope of ALL_MODES) {
      expect(
        entryMatchesScope(local, scope),
        `mode ${scope.mode} leaked a domain-local entry`
      ).toBe(false);
    }
  });

  it("`full` is the case that matters most — it is the scope an operator widens to when data is missing", () => {
    // Called out separately from the loop above so that a regression here fails with a test name
    // that says what broke. A clause reachable only from the NARROW modes would be invisible until
    // someone widened a peer to debug a sync problem, which is precisely the moment the guarantee
    // is being relied on and the worst moment to discover it was conditional.
    expect(entryMatchesScope(entry({ domainLocal: true }), { mode: "full" })).toBe(false);
  });

  it("withholds every ENTRY KIND, not just object upserts", () => {
    // The tombstone is the easy one to miss: it "carries no data", but its `urn` is
    // `urn:scp:<org>:<type>:<name>` — the object's NAME in plain text — and its arrival would tell a
    // peer that something it was never shown has now been deleted.
    for (const kind of [
      "object_upsert",
      "object_tombstone",
      "relationship_upsert",
      "relationship_tombstone",
      "change_status",
      "policy_upsert",
      "approval_evidence",
      "audit_segment",
      "key_rotation"
    ]) {
      expect(
        entryMatchesScope(entry({ domainLocal: true }, kind), { mode: "full" }),
        `entry kind ${kind} leaked`
      ).toBe(false);
    }
  });

  it("REGRESSION CONTROL: an ordinary entry is completely unaffected at every mode", () => {
    // Without this the clause could pass by withholding everything, which would silently break
    // federation rather than scope it.
    const policy = entry({ typeId: "policy" }, "policy_upsert");
    expect(entryMatchesScope(policy, { mode: "full" })).toBe(true);
    expect(entryMatchesScope(policy, { mode: "policies_only" })).toBe(true);
    expect(entryMatchesScope(policy, { mode: "status_only" })).toBe(false); // pre-existing behaviour

    const change = entry({ typeId: "change" }, "object_upsert");
    expect(entryMatchesScope(change, { mode: "changes_only" })).toBe(true);
    expect(entryMatchesScope(change, { mode: "full" })).toBe(true);
  });

  it("an absent flag and an explicit `false` both mean 'federates normally'", () => {
    expect(entryMatchesScope(entry({ typeId: "policy" }, "policy_upsert"), { mode: "full" })).toBe(
      true
    );
    expect(
      entryMatchesScope(entry({ typeId: "policy", domainLocal: false }, "policy_upsert"), {
        mode: "full"
      })
    ).toBe(true);
  });

  it("matches on the BOOLEAN `true` only — no coercion in a boundary predicate", () => {
    // Documented behaviour, not an accident, and directional. See docs/federation.md §520.
    for (const notTrue of ["true", 1, {}, [], "yes"]) {
      expect(
        isDomainLocalEntry(entry({ domainLocal: notTrue })),
        `${JSON.stringify(notTrue)}`
      ).toBe(false);
    }
    expect(isDomainLocalEntry(entry({ domainLocal: true }))).toBe(true);
  });

  it("filterByScope drops the domain-local entries and keeps the rest, preserving order", () => {
    const entries = [
      entry({ typeId: "policy", n: 1 }, "policy_upsert"),
      entry({ typeId: "component", n: 2, domainLocal: true }),
      entry({ typeId: "policy", n: 3 }, "policy_upsert")
    ];
    const kept = filterByScope(entries, { mode: "full" });
    expect(kept.map((e) => (e.payload as { n: number }).n)).toEqual([1, 3]);
  });

  it("does NOT change what `scopeCarriesChangeObjects` reports about a peer", () => {
    // That helper probes with a locality-free synthetic entry. See docs/federation.md §521.
    expect(scopeCarriesChangeObjects({ mode: "full" })).toBe(true);
    expect(scopeCarriesChangeObjects({ mode: "changes_only" })).toBe(true);
    expect(scopeCarriesChangeObjects({ mode: "status_only" })).toBe(false);
    expect(scopeCarriesChangeObjects({ mode: "policies_only" })).toBe(false);
  });
});
