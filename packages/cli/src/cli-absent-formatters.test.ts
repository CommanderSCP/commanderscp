import { describe, expect, it } from "vitest";
import type {
  Campaign,
  FederationPeer,
  FederationStatusResponse,
  InstanceScanExclusionAdmission,
  InstanceScanFloor,
  OutpostConfig,
  OutpostConfigReconcileResult,
  ScanDbStatus
} from "@scp/schemas";
import {
  campaignDetailRow,
  federationStatusRow,
  formatReconcileResultLines,
  instanceScanExclusionAdmissionRow,
  instanceScanFloorRow,
  outpostConfigRow,
  peerRow,
  printFederationStatus,
  scanDbOutcomeRow,
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
 * WHAT "ABSENT" MEANS, and why `=== null` is not enough (see `isAbsent`'s own doc in `cli.ts`): an
 * omitted key arrives as `undefined` whatever `.nullable()` says. For an `.optional()` field that is
 * CONTRACT-LEGAL and ADR-0023's response validation passes it through untouched, so these guards are
 * the only thing; for a required field the SDK now rejects the body at the boundary instead and they
 * are defence in depth. Either way the formatters are called DIRECTLY here, which is the only level
 * at which the guard itself — as opposed to the boundary in front of it — can be pinned. Every
 * fixture below therefore DELETES the key rather than setting it to `null` — `null` is the case that
 * already worked.
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
    deadline: null,
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

function baseAdmission(
  overrides: Partial<InstanceScanExclusionAdmission> = {}
): InstanceScanExclusionAdmission {
  return {
    tier: "platform",
    class: "no_fix_available",
    origin: "local",
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
// M25.6a — campaignDetailRow.deadline / .adoptionSignal
// -------------------------------------------------------------------------------------
describe("campaignDetailRow: an absent deadline is blank, never the word `undefined`", () => {
  it("prints empty cells when the key is OMITTED (an older server, or a client ahead of one)", () => {
    const row = campaignDetailRow(without(baseCampaign(), "deadline"));
    expect(row.deadline).toBe("");
    expect(row.adoptionSignal).toBe("");
    // THE MUTANT: `=== null` lets `undefined` through to `.at`, which throws — so the operator's
    // whole `scp campaign status` call dies rather than printing a campaign with no deadline.
    expect(row.deadline).not.toContain("undefined");
  });

  it("prints a real deadline, and blanks the optional signal without blanking the instant", () => {
    const at = "2026-12-31T23:59:59.000Z";
    expect(campaignDetailRow(baseCampaign({ deadline: { at } })).deadline).toBe(at);
    expect(campaignDetailRow(baseCampaign({ deadline: { at } })).adoptionSignal).toBe("");
    expect(
      campaignDetailRow(baseCampaign({ deadline: { at, adoptionSignal: "dependency" } }))
        .adoptionSignal
    ).toBe("dependency");
    expect(campaignDetailRow(baseCampaign({ deadline: null })).deadline).toBe("");
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
// instanceScanExclusionAdmissionRow — M22.9's twin of the block above, and it shipped with NO test
// at all. A filterless `grep -rna 'instanceScanExclusionAdmissionRow'` over `--include='*.ts'`
// found the formatter referenced ONLY by `cli.ts` itself, while its sibling `instanceScanFloorRow`
// three lines up was covered here — the round-4 finding recurring on the next feature: the lift-out
// happened, the pin did not, so deleting the whole M22.9 command block left this package green.
// -------------------------------------------------------------------------------------
describe("instanceScanExclusionAdmissionRow: an absent audit column must not read as authored", () => {
  it("an OMITTED note renders empty, never the literal `undefined`", () => {
    // The severe direction is specific: `note` is the operator's stated REASON for opening a
    // loosening across every org on the deployment, and this row is where an auditor reads it. A
    // fabricated `undefined` sitting in that column is a value somebody appears to have written.
    const row = instanceScanExclusionAdmissionRow(without(baseAdmission(), "note"));
    expect(row.note).toBe("");
    expect(row.note).not.toContain("undefined");
  });

  it("an OMITTED updatedAt renders `-`, so `when` is never fabricated either", () => {
    const row = instanceScanExclusionAdmissionRow(without(baseAdmission(), "updatedAt"));
    expect(row.updatedAt).toBe("-");
    expect(row.updatedAt).not.toContain("undefined");
  });

  it("an authored note survives verbatim — the guard must distinguish, not blank everything", () => {
    const row = instanceScanExclusionAdmissionRow(
      baseAdmission({
        note: "CISA waiver 2026-07",
        class: "approved_override",
        tier: "trust_domain"
      })
    );
    expect(row.note).toBe("CISA waiver 2026-07");
    expect(row.class).toBe("approved_override");
    expect(row.tier).toBe("trust_domain");
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

// -------------------------------------------------------------------------------------
// ROUND 5 (Z2/Z3/Z4) — THE CLI TWINS OF GUARDS THE WEB SIDE ALREADY TOOK.
//
// Each of the three below is the SAME required-not-optional field, off the SAME endpoint, as a
// web-side site fixed in an earlier round; each was left bare on the CLI half, and each lived in a
// MODULE-PRIVATE function so no test could have caught it. `peerRow` and `outpostConfigRow` are now
// exported for that reason — round 4's Y2 finding restated: a guard no test can invoke is a guard
// nothing holds in place.
// -------------------------------------------------------------------------------------

function basePeer(overrides: Partial<FederationPeer> = {}): FederationPeer {
  return {
    id: PEER_ID,
    name: "amer-prod",
    role: "outpost",
    baseUrl: "https://outpost.example.net",
    syncScope: { mode: "full" },
    publicKey: "AAAA",
    cosignPublicKey: null,
    deliveryTarget: null,
    pokeMode: false,
    pairedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  } as FederationPeer;
}

function baseOutpostConfig(overrides: Partial<OutpostConfig> = {}): OutpostConfig {
  return {
    objectId: "33333333-4444-4555-8666-777777777777",
    urn: `urn:scp:outpost:${PEER_ID}`,
    name: "amer-prod",
    peerDomainId: PEER_ID,
    trustTier: null,
    originDomainId: "aa11bb22-cc33-4d44-8e55-ff6677889900",
    originIsSelf: true,
    provenance: null,
    revision: 1,
    version: 1,
    unknownFields: ["trustTier"],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  } as OutpostConfig;
}

function baseReconcile(
  overrides: Partial<OutpostConfigReconcileResult> = {}
): OutpostConfigReconcileResult {
  return {
    config: baseOutpostConfig(),
    adoptedObjectId: null,
    removedShadowObjectIds: [],
    removedLocalObjectIds: [],
    ...overrides
  } as OutpostConfigReconcileResult;
}

// cli.ts — peerRow.syncScope (Z2)
describe("peerRow: a peer whose response omits `syncScope` must not kill `scp federation peers`", () => {
  it("prints `?` instead of throwing on `.mode`", () => {
    // THE MUTANT: `p.syncScope.mode` throws `TypeError: Cannot read properties of undefined
    // (reading 'mode')` while building the FIRST row, so the command prints NO table at all — not a
    // degraded one. `syncScope` is required-not-optional on `FederationPeerSchema` and the generated
    // BEFORE ADR-0023 the SDK validated no response; this is the same field `outpost-settings.tsx`
    // guards on the web. These cases drive the FORMATTER directly, which is where the guard lives.
    const peer: Partial<FederationPeer> = basePeer();
    delete peer.syncScope;
    expect(() => peerRow(peer as FederationPeer)).not.toThrow();
    expect(peerRow(peer as FederationPeer).syncScope).toBe("?");
  });

  it("never SUBSTITUTES a default scope — `?` is not `full`", () => {
    const peer: Partial<FederationPeer> = basePeer();
    delete peer.syncScope;
    // "full" would tell the operator this peer exports everything on no evidence at all.
    expect(peerRow(peer as FederationPeer).syncScope).not.toBe("full");
  });

  it("still prints a real mode, and the other columns, when the server sends one", () => {
    const row = peerRow(basePeer({ syncScope: { mode: "status_only" } }));
    expect(row.syncScope).toBe("status_only");
    expect(row.name).toBe("amer-prod");
    expect(row.poke).toBe("poll");
  });
});

// cli.ts — outpostConfigRow.unknownFields (Z3)
describe("outpostConfigRow: an omitted `unknownFields` must not kill six commands", () => {
  it("prints `-` instead of throwing on `.join`", () => {
    // THE MUTANT: `o.unknownFields.join(", ")` throws `TypeError: … reading 'join'`. `unknownFields`
    // is required-not-optional on `OutpostConfigSchema`; its web twin took `?? []` last round.
    const config: Partial<OutpostConfig> = baseOutpostConfig();
    delete config.unknownFields;
    expect(() => outpostConfigRow(config as OutpostConfig)).not.toThrow();
    expect(outpostConfigRow(config as OutpostConfig).notObservable).toBe("-");
  });

  it("still lists the real not-observable fields when the server sends them", () => {
    expect(outpostConfigRow(baseOutpostConfig()).notObservable).toBe("trustTier");
    expect(outpostConfigRow(baseOutpostConfig({ unknownFields: [] })).notObservable).toBe("-");
  });

  it("§10.5 `binding`: `hq` for a self-bound record (the HQ outpost, formerly 'co-located'), `field` for a peer-bound one (a field outpost), `?` when an older server does not say", () => {
    expect(outpostConfigRow(baseOutpostConfig({ peerIsSelf: true })).binding).toBe("hq");
    expect(outpostConfigRow(baseOutpostConfig({ peerIsSelf: false })).binding).toBe("field");
    const config: Partial<OutpostConfig> = baseOutpostConfig();
    delete config.peerIsSelf;
    // Absence is NOT "field": an older server that never resolved the flag has made no statement.
    expect(outpostConfigRow(config as OutpostConfig).binding).toBe("?");
  });
});

// cli.ts — formatReconcileResultLines removal buckets (Z4)
describe("formatReconcileResultLines: the report of a DESTRUCTIVE verb must survive a missing key", () => {
  for (const key of ["removedShadowObjectIds", "removedLocalObjectIds"] as const) {
    it(`an OMITTED ${key} still produces a report instead of throwing`, () => {
      // THE MUTANT: bare `.length` throws, and the operator — who has just run a destructive,
      // downstream-propagating reconcile — is told NOTHING about the deletes that already happened
      // and already journaled.
      const result: Partial<OutpostConfigReconcileResult> = baseReconcile();
      delete result[key];
      expect(() =>
        formatReconcileResultLines(result as OutpostConfigReconcileResult)
      ).not.toThrow();
      expect(formatReconcileResultLines(result as OutpostConfigReconcileResult)[0]).toContain(
        "Adopted:"
      );
    });
  }

  it("an omitted shadow bucket still reports the LOCAL deletes, with their own wording", () => {
    const result: Partial<OutpostConfigReconcileResult> = baseReconcile({
      removedLocalObjectIds: ["44444444-5555-4666-8777-888888888888"]
    });
    delete result.removedShadowObjectIds;
    const lines = formatReconcileResultLines(result as OutpostConfigReconcileResult);
    // the propagating-tombstone wording is the whole point of the two buckets being separate
    expect(lines.join("\n")).toContain("WILL propagate to the outpost");
    expect(lines.join("\n")).toContain("44444444-5555-4666-8777-888888888888");
    expect(lines.join("\n")).not.toContain("unverified shadow(s)");
  });

  it("an omitted local bucket still reports the SHADOW cleanup, with its own wording", () => {
    const result: Partial<OutpostConfigReconcileResult> = baseReconcile({
      removedShadowObjectIds: ["55555555-6666-4777-8888-999999999999"]
    });
    delete result.removedLocalObjectIds;
    const lines = formatReconcileResultLines(result as OutpostConfigReconcileResult);
    expect(lines.join("\n")).toContain("unverified shadow(s)");
    expect(lines.join("\n")).toContain("invisible to the outpost");
    expect(lines.join("\n")).not.toContain("WILL propagate to the outpost");
  });
});

// cli.ts — printFederationStatus.peers (Z5)
describe("printFederationStatus: an omitted `peers` list must not kill `scp federation status`", () => {
  /** Capture stdout for one call. */
  function capture(fn: () => void): string {
    const out: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return out.join("\n");
  }

  const selfBlock = {
    self: {
      domainId: "aa11bb22-cc33-4d44-8e55-ff6677889900",
      name: "hq",
      role: "commander" as const,
      publicKey: "AAAA",
      cosignPublicKey: null
    }
  };

  it("prints the empty reading instead of throwing on `peers.length`", () => {
    // THE MUTANT: `status.peers.length` throws `TypeError: … reading 'length'`, so the command
    // reports NOTHING — not even the self identity it already printed two lines earlier.
    // `outposts.tsx` has read this field as `data?.peers ?? []` since round 3; this was the twin.
    const response = { ...selfBlock } as unknown as FederationStatusResponse;
    let text = "";
    expect(() => {
      text = capture(() => printFederationStatus(response, "table"));
    }).not.toThrow();
    expect(text).toContain("No paired peers.");
    // and the self line above it survives
    expect(text).toContain("Self: hq");
  });

  it("still prints the peer table when the server sends the list", () => {
    const response = {
      ...selfBlock,
      peers: [basePeerStatus()]
    } as unknown as FederationStatusResponse;
    const text = capture(() => printFederationStatus(response, "table"));
    expect(text).toContain("amer-prod");
    expect(text).not.toContain("No paired peers.");
  });
});

// cli.ts — scanDbOutcomeRow (Z5): the twin ONE COMMAND OVER of `scanDbStatusRow`
describe("scanDbOutcomeRow: `scp scan-db refresh`/`load` must not print `undefined` for a DB age", () => {
  it("an OMITTED ageHours reads `(unknown)`, never the literal `undefined`", () => {
    // THE FABRICATION: `String(r.status.ageHours)` — the exact read `scanDbStatusRow` already
    // guards, left bare in the two `.action()` closures one command over. `undefined` in the age
    // column of a SECURITY cache is not a null result, it is a wrong one.
    const row = scanDbOutcomeRow({
      refreshed: true,
      status: without(baseScanDbStatus(), "ageHours"),
      detail: "ok"
    } as never);
    expect(row.ageHours).toBe("(unknown)");
    expect(row.ageHours).not.toContain("undefined");
    expect(row.ageHours).not.toBe("0");
  });

  it("an OMITTED `status` object reports the outcome instead of throwing over it", () => {
    // Same shape as Z4: the refresh ALREADY HAPPENED; only the telling of it died.
    const outcome = { refreshed: true, detail: "swapped" } as never;
    expect(() => scanDbOutcomeRow(outcome)).not.toThrow();
    const row = scanDbOutcomeRow(outcome);
    expect(row.refreshed).toBe("true");
    expect(row.source).toBe("(unknown)");
    expect(row.ageHours).toBe("(unknown)");
  });

  it("keeps the two verbs' column names distinct — `refreshed` and `loaded` are different claims", () => {
    const refreshed = scanDbOutcomeRow({
      refreshed: false,
      status: baseScanDbStatus(),
      detail: "no-op"
    } as never);
    const loaded = scanDbOutcomeRow({
      loaded: true,
      status: baseScanDbStatus(),
      detail: "verified"
    } as never);
    expect(refreshed.refreshed).toBe("false");
    expect(refreshed.loaded).toBeUndefined();
    expect(loaded.loaded).toBe("true");
    expect(loaded.refreshed).toBeUndefined();
    // a real age still prints
    expect(loaded.ageHours).toBe("4.25");
    expect(loaded.source).toBe("refreshed");
  });
});
