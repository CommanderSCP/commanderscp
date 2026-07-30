import { describe, expect, it } from "vitest";
import type {
  Campaign,
  FederationStatusResponse,
  InstanceScanFloor,
  ScanDbStatus
} from "@scp/schemas";
import {
  campaignDetailRow,
  federationStatusRow,
  instanceScanFloorRow,
  scanDbStatusRow
} from "./cli.js";

/**
 * THE PINS FOR THE CLI HALF OF THE `isAbsent` CENSUS (review round 4, Y2).
 *
 * WHY THIS FILE EXISTS AT ALL. Round 3 replaced `=== null` with `isAbsent(...)` at eleven CLI sites,
 * and the PR body reported all of them as mutation-proven. A lens reverted them ONE AT A TIME and
 * found TEN SURVIVORS: only `formatReconcileResultLines` (already exported, already tested) went
 * red. The other ten lived either in a module-private function (`printFederationStatus`,
 * `campaignDetailRow`) or inline in a Commander `.action()` closure (the scan-floor and scan-db
 * mappers), so NO test could reach them — the guards were correct and completely unheld.
 *
 * The fix was structural: those mappers are now exported functions rather than closures, and this
 * file calls each one with the key ABSENT. Each assertion below has been mutation-proven by
 * reverting its `isAbsent(...)` to `=== null` and watching this file go red.
 *
 * WHAT "ABSENT" MEANS, and why `=== null` is not enough (see `isAbsent`'s own doc in `cli.ts`): the
 * generated SDK does no runtime response validation, so a key a server OMITS arrives as `undefined`
 * whatever `.nullable()` says. Every fixture below therefore DELETES the key rather than setting it
 * to `null` — `null` is the case that already worked.
 */

/** Delete one key from an otherwise-valid value: what an older/newer server actually puts on the
 *  wire, which no type in this repo can rule out at runtime. */
function without<T, K extends keyof T>(value: T, key: K): T {
  const copy: T = { ...value };
  delete copy[key];
  return copy;
}

const PEER_ID = "0e0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

function baseCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    orgId: "22222222-3333-4444-8555-666666666666",
    urn: "urn:scp:campaign:demo",
    name: "demo",
    description: null,
    targets: [],
    topologyObjectId: null,
    topologyVersion: 3,
    status: "proposed",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

type PeerStatus = FederationStatusResponse["peers"][number];

function basePeerStatus(overrides: Partial<PeerStatus> = {}): PeerStatus {
  return {
    peer: {
      id: PEER_ID,
      name: "amer-prod",
      role: "outpost",
      baseUrl: "https://outpost.example.net",
      syncScope: { mode: "full" },
      publicKey: "AAAA",
      pokeMode: false,
      pairedAt: "2026-07-01T00:00:00.000Z"
    },
    lastAppliedSequence: 12,
    lastSyncedAt: null,
    trustTier: null,
    trustTierProvenance: null,
    transportMode: "dialable",
    lastExportedThroughSequence: null,
    lastExportedAt: null,
    lastExportedBundleChecksum: null,
    lastSyncedBundleChecksum: null,
    pendingExportEntryCount: 4,
    unknownFields: [],
    recentTransfers: [],
    ...overrides
  } as PeerStatus;
}

function baseFloor(overrides: Partial<InstanceScanFloor> = {}): InstanceScanFloor {
  return {
    tier: "platform",
    origin: "local",
    maxCritical: 0,
    maxHigh: 1,
    maxMedium: 2,
    maxLow: 3,
    note: null,
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function baseScanDbStatus(overrides: Partial<ScanDbStatus> = {}): ScanDbStatus {
  return {
    cacheConfigured: true,
    present: true,
    source: "refreshed",
    ageHours: 4.25,
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextUpdate: null,
    schemaVersion: 2,
    expectedSchemaVersion: 2,
    schemaCompatible: true,
    staleness: "fresh",
    thresholdFired: "none",
    activeSoftMaxAgeHours: 24,
    activeHardMaxAgeHours: 168,
    detail: "ok",
    ...overrides
  } as ScanDbStatus;
}

// -------------------------------------------------------------------------------------
// cli.ts:205 — campaignDetailRow.topologyVersion
// -------------------------------------------------------------------------------------
describe("campaignDetailRow: an absent topologyVersion is blank, never the word `undefined`", () => {
  it("prints an empty cell when the key is OMITTED (not merely null)", () => {
    const row = campaignDetailRow(without(baseCampaign(), "topologyVersion"));
    expect(row.topologyVersion).toBe("");
    // THE MUTANT: `=== null` lets `undefined` through to `String(...)`, printing a version that
    // does not exist next to a campaign's pinned topology.
    expect(row.topologyVersion).not.toContain("undefined");
  });

  it("still prints a real version", () => {
    expect(campaignDetailRow(baseCampaign({ topologyVersion: 7 })).topologyVersion).toBe("7");
    expect(campaignDetailRow(baseCampaign({ topologyVersion: null })).topologyVersion).toBe("");
    // 0 is a VERSION, not an absence — the guard must not be a falsiness check
    expect(campaignDetailRow(baseCampaign({ topologyVersion: 0 })).topologyVersion).toBe("0");
  });
});

// -------------------------------------------------------------------------------------
// cli.ts:275 / :295 / :301 / :302 — federationStatusRow
// -------------------------------------------------------------------------------------
describe("federationStatusRow: never invents a sync position or a backlog", () => {
  it(":275 an OMITTED lastAppliedSequence reads `never synced`, not `seq undefined`", () => {
    const row = federationStatusRow(without(basePeerStatus(), "lastAppliedSequence"));
    expect(row.syncedThrough).toBe("never synced");
    expect(row.syncedThrough).not.toContain("undefined");
  });

  it(":275 sequence 0 is a POSITION and must not read as never synced", () => {
    expect(federationStatusRow(basePeerStatus({ lastAppliedSequence: 0 })).syncedThrough).toBe(
      "seq 0"
    );
  });

  it(":295 an OMITTED pendingExportEntryCount reads `?`, never `undefined pending`", () => {
    const row = federationStatusRow(without(basePeerStatus(), "pendingExportEntryCount"));
    // `?` is the declared-unknown marker; the forbidden output is a COUNT that has no source, and
    // in particular anything an operator could read as "nothing pending".
    expect(row.pendingExport).toBe("?");
    expect(row.pendingExport).not.toContain("undefined");
    expect(row.pendingExport).not.toBe("0 pending");
  });

  it(":295 a real backlog of 0 still reads as an observed zero, not as unknown", () => {
    expect(federationStatusRow(basePeerStatus({ pendingExportEntryCount: 0 })).pendingExport).toBe(
      "0 pending"
    );
  });
});

describe("federationStatusRow: a trust tier is an assertion, and its provenance travels with it", () => {
  it(":301 an OMITTED trustTier reads `?` — never a tier, and never the word `undefined`", () => {
    const row = federationStatusRow(without(basePeerStatus(), "trustTier"));
    expect(row.trustTier).toBe("?");
    expect(row.trustTier).not.toContain("undefined");
    expect(row.trustTier).not.toContain("commercial");
  });

  it(":302 A HAND-TYPED TIER IS NEVER PRINTED BARE — the `unknownFields` clause is load-bearing", () => {
    // THE MOST CONSEQUENTIAL MUTANT IN THIS FILE. `trustTierProvenance` is itself a field an older
    // server omits, so provenance-only detection is not enough: the server ALSO declares the tier in
    // `unknownFields`, and dropping the `|| (p.unknownFields ?? []).includes("trustTier")` OR makes
    // `scp federation status` print a hand-typed `il5` as though the commander had asserted it —
    // the exact fabrication the web `TrustTierCell` exists to prevent, reproduced on the CLI.
    const row = federationStatusRow(
      basePeerStatus({
        trustTier: "il5",
        // provenance ABSENT — the only signal left is the unknown-field declaration
        trustTierProvenance: null,
        unknownFields: ["trustTier"]
      })
    );
    expect(row.trustTier).toBe("il5 (unverified)");
    expect(row.trustTier).not.toBe("il5");
  });

  it(":302 the same holds when `trustTierProvenance` is not on the wire at all", () => {
    const row = federationStatusRow(
      without(
        basePeerStatus({ trustTier: "il5", unknownFields: ["trustTier"] }),
        "trustTierProvenance"
      )
    );
    expect(row.trustTier).toBe("il5 (unverified)");
  });

  it("an explicit `unverified` provenance is suffixed even with an empty unknownFields", () => {
    const row = federationStatusRow(
      basePeerStatus({ trustTier: "il5", trustTierProvenance: "unverified", unknownFields: [] })
    );
    expect(row.trustTier).toBe("il5 (unverified)");
  });

  it("a DECLARED tier prints bare — the suffix must distinguish, not decorate everything", () => {
    const row = federationStatusRow(
      basePeerStatus({ trustTier: "il5", trustTierProvenance: "declared", unknownFields: [] })
    );
    expect(row.trustTier).toBe("il5");
  });

  it("an OMITTED recentTransfers counts 0 instead of aborting the whole table", () => {
    const row = federationStatusRow(without(basePeerStatus(), "recentTransfers"));
    expect(row.recentTransfers).toBe("0");
  });
});

// -------------------------------------------------------------------------------------
// cli.ts:2253-2256 — instanceScanFloorRow
// -------------------------------------------------------------------------------------
describe("instanceScanFloorRow: an unset ceiling is `-`, and `-` is not 0", () => {
  for (const [key, column] of [
    ["maxCritical", "maxCritical"],
    ["maxHigh", "maxHigh"],
    ["maxMedium", "maxMedium"],
    ["maxLow", "maxLow"]
  ] as const) {
    it(`an OMITTED ${key} renders \`-\`, never \`undefined\``, () => {
      const row = instanceScanFloorRow(without(baseFloor(), key));
      expect(row[column]).toBe("-");
      expect(row[column]).not.toContain("undefined");
    });
  }

  it("an authored ceiling of 0 stays 0 — the strictest floor is not an absence", () => {
    const row = instanceScanFloorRow(
      baseFloor({ maxCritical: 0, maxHigh: 0, maxMedium: 0, maxLow: 0 })
    );
    expect([row.maxCritical, row.maxHigh, row.maxMedium, row.maxLow]).toEqual(["0", "0", "0", "0"]);
  });
});

// -------------------------------------------------------------------------------------
// cli.ts:2437 — scanDbStatusRow.ageHours
// -------------------------------------------------------------------------------------
describe("scanDbStatusRow: an unknown DB age must not kill the command", () => {
  it("an OMITTED ageHours renders `(unknown)` instead of throwing on `.toFixed`", () => {
    // THE MUTANT HERE DOES NOT MISPRINT, IT CRASHES: `=== null` lets `undefined` reach
    // `.toFixed(1)`, so `scp scan-db status` dies with a TypeError instead of reporting a status —
    // and an unknown age is exactly the state an operator is running the command to discover.
    expect(() => scanDbStatusRow(without(baseScanDbStatus(), "ageHours"))).not.toThrow();
    expect(scanDbStatusRow(without(baseScanDbStatus(), "ageHours")).ageHours).toBe("(unknown)");
  });

  it("a real age still prints to one decimal, and 0 is an age", () => {
    expect(scanDbStatusRow(baseScanDbStatus({ ageHours: 4.25 })).ageHours).toBe("4.3");
    expect(scanDbStatusRow(baseScanDbStatus({ ageHours: 0 })).ageHours).toBe("0.0");
    expect(scanDbStatusRow(baseScanDbStatus({ ageHours: null })).ageHours).toBe("(unknown)");
  });
});
