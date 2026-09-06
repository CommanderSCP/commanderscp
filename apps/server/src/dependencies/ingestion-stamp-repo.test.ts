import { describe, expect, it } from "vitest";
import {
  mergeIngestionStamp,
  type DependencyIngestionStamp,
  type IngestionStampManifest,
  type MergedIngestionStamp,
  type RecordIngestionStampInput
} from "./ingestion-stamp-repo.js";

/**
 * M21.7 — THE STAMP MERGE (ADR-0032 §4, drizzle/0065).
 *
 * `mergeIngestionStamp` is where the table's whole correctness argument lives, so it is pure and it
 * is asserted here without a database. The behaviour against real Postgres — that the ingestion
 * actually calls it, with the repository it read — is pinned in
 * `inventory-ingestion.integration.test.ts`; these are the rules themselves.
 *
 * TWO DEFECTS SHAPED THIS FUNCTION, both of which turned "this component's manifests could not be
 * read" into "this component genuinely declares nothing":
 *
 *  1. A refusal for a repository the component is NOT MAPPED TO overwrote a good stamp with
 *     `unreadable`. A pass that reached no provider holds no evidence about any manifest.
 *  2. The row is per COMPONENT but ingestion is per (COMPONENT, REPOSITORY). A successful
 *     `acme/charts` pass replaced the whole row and erased a failed `acme/widgets` read.
 */
describe("mergeIngestionStamp — the row is per component, the evidence is per repository", () => {
  const WIDGETS = "acme/widgets";
  const CHARTS = "acme/charts";
  const T2 = "2026-08-16T12:00:00.000Z";
  const T1 = "2026-08-16T11:00:00.000Z";
  const T3 = "2026-08-16T13:00:00.000Z";

  const entry = (
    repo: string,
    path: string,
    outcome: IngestionStampManifest["outcome"],
    rows: number,
    at: string
  ): IngestionStampManifest => ({ repo, path, outcome, rows, at });

  const stored = (
    over: Partial<DependencyIngestionStamp> & Pick<DependencyIngestionStamp, "lastAttemptAt">
  ): DependencyIngestionStamp => ({
    orgId: "org",
    componentObjectId: "component",
    source: "loop",
    outcome: "ok",
    detail: null,
    rowsWritten: 0,
    manifests: [],
    createdAt: T1,
    ...over
  });

  /** A fold that is expected to WRITE. `mergeIngestionStamp` returns `null` for "this pass changes
   *  nothing"; the two tests that expect that call it directly. */
  const fold = (
    storedRow: DependencyIngestionStamp | null,
    passInput: RecordIngestionStampInput
  ): MergedIngestionStamp => {
    const merged = mergeIngestionStamp(storedRow, passInput);
    expect(merged, "this pass was expected to write a row").not.toBeNull();
    return merged as MergedIngestionStamp;
  };

  const pass = (
    over: Omit<Partial<RecordIngestionStampInput>, "lastAttemptAt"> & { lastAttemptAt: string }
  ): RecordIngestionStampInput => ({
    componentObjectId: "component",
    source: "loop",
    repo: WIDGETS,
    outcome: "ok",
    ...over,
    lastAttemptAt: new Date(over.lastAttemptAt)
  });

  // DEFECT 1 — a pass that reached no repository may not revise the manifest verdict
  it("a refusal with NO repository writes NOTHING over the standing evidence", () => {
    // `null` is the whole answer: not a restatement of the stored row, not an advanced
    // `last_attempt_at`. The timestamp is in that list on purpose — it is what a reader means by
    // freshness, and a pass that read no manifest must not report a three-month-old inventory as
    // looked at a minute ago.
    expect(
      mergeIngestionStamp(
        stored({
          lastAttemptAt: T1,
          outcome: "ok",
          rowsWritten: 2,
          manifests: [entry(WIDGETS, "go.mod", "ok", 2, T1)]
        }),
        pass({
          lastAttemptAt: T2,
          repo: null,
          outcome: "unreadable",
          detail: "none of this component's source_mappings names the repository 'acme/elsewhere'"
        })
      )
    ).toBeNull();
  });

  it("a refusal with no repository cannot turn `ok` + 0 rows into `unreadable`", () => {
    // The empty-evidence half of the same defect, and the sharper one: "we looked and it declares
    // nothing" is the exact state this table was built to express, and it has no entries to hide
    // behind — so a merge that only protected the entries would still have destroyed it.
    expect(
      mergeIngestionStamp(
        stored({ lastAttemptAt: T1, outcome: "ok", rowsWritten: 0, manifests: [] }),
        pass({ lastAttemptAt: T2, repo: null, outcome: "unreadable", detail: "no repo was named" })
      )
    ).toBeNull();
  });

  it("but a FIRST attempt that refused is recorded as the refusal — absence means never attempted", () => {
    const merged = fold(
      null,
      pass({ lastAttemptAt: T1, repo: null, outcome: "unreadable", detail: "no repo was named" })
    );
    expect(merged.outcome).toBe("unreadable");
    expect(merged.detail).toBe("no repo was named");
  });

  it("a pass over one repository replaces its OWN slice and keeps the other's", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T1,
        outcome: "unreadable",
        manifests: [entry(WIDGETS, "go.mod", "unreadable", 0, T1)]
      }),
      pass({
        lastAttemptAt: T2,
        repo: CHARTS,
        outcome: "ok",
        manifests: [{ path: "Dockerfile", outcome: "ok", rows: 1 }]
      })
    );
    // MIXED, which is the honest reading and was unreachable while the row was replaced wholesale.
    expect(merged.outcome).toBe("partial");
    expect(merged.manifests.map((m) => [m.repo, m.path, m.outcome])).toEqual([
      [CHARTS, "Dockerfile", "ok"],
      [WIDGETS, "go.mod", "unreadable"]
    ]);
    // Summed across repositories: the charts pass's own count is not the component's.
    expect(merged.rowsWritten).toBe(1);
  });

  it("a later pass over the SAME repository replaces that slice rather than accumulating", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T1,
        manifests: [
          entry(WIDGETS, "go.mod", "unreadable", 0, T1),
          entry(WIDGETS, "package.json", "unreadable", 0, T1)
        ]
      }),
      pass({
        lastAttemptAt: T2,
        repo: WIDGETS,
        manifests: [{ path: "go.mod", outcome: "ok", rows: 2 }]
      })
    );
    // The `package.json` entry is GONE, because this pass's slice is the complete current picture
    // of that repository — a union per path would keep an entry for a manifest that no longer
    // exists, forever.
    expect(merged.manifests.map((m) => m.path)).toEqual(["go.mod"]);
    expect(merged.outcome).toBe("ok");
    expect(merged.rowsWritten).toBe(2);
  });

  it("counts EVERY repository's rows, so one source's failure does not zero the other's", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T1,
        rowsWritten: 2,
        manifests: [entry(WIDGETS, "go.mod", "ok", 2, T1)]
      }),
      pass({
        lastAttemptAt: T2,
        repo: CHARTS,
        manifests: [{ path: "Dockerfile", outcome: "ok", rows: 3 }]
      })
    );
    expect(merged.rowsWritten).toBe(5);
    expect(merged.outcome).toBe("ok");
  });

  // ORDERING — per repository for the slice, per component for the row-level fields
  it("an OLDER pass over the same repository does not replace a newer slice", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T2,
        source: "backfill",
        outcome: "ok",
        rowsWritten: 2,
        manifests: [entry(WIDGETS, "go.mod", "ok", 2, T2)]
      }),
      pass({
        lastAttemptAt: T1,
        repo: WIDGETS,
        outcome: "unreadable",
        manifests: [{ path: "go.mod", outcome: "unreadable", rows: 0 }]
      })
    );
    expect(merged.outcome).toBe("ok");
    expect(merged.rowsWritten).toBe(2);
    expect(merged.lastAttemptAt.toISOString()).toBe(T2);
    expect(merged.source).toBe("backfill");
  });

  it("an older pass over a DIFFERENT repository still lands its slice", () => {
    // Ordering the whole row instead would drop this pass entirely and lose the charts verdict —
    // the same silence the table replaces, arriving by a race rather than a bug.
    const merged = fold(
      stored({
        lastAttemptAt: T2,
        source: "backfill",
        manifests: [entry(WIDGETS, "go.mod", "ok", 2, T2)]
      }),
      pass({
        lastAttemptAt: T1,
        repo: CHARTS,
        outcome: "unreadable",
        manifests: [{ path: "Dockerfile", outcome: "unreadable", rows: 0 }]
      })
    );
    expect(merged.outcome).toBe("partial");
    expect(merged.manifests.map((m) => m.repo)).toEqual([CHARTS, WIDGETS]);
    // Row-level fields still describe the LATEST attempt on the component, which this is not.
    expect(merged.lastAttemptAt.toISOString()).toBe(T2);
    expect(merged.source).toBe("backfill");
  });

  it("a pass at the SAME instant refreshes its slice rather than silently doing nothing", () => {
    const merged = fold(
      stored({ lastAttemptAt: T2, manifests: [entry(WIDGETS, "go.mod", "ok", 2, T2)] }),
      pass({
        lastAttemptAt: T2,
        repo: WIDGETS,
        outcome: "unreadable",
        manifests: [{ path: "go.mod", outcome: "unreadable", rows: 0 }]
      })
    );
    expect(merged.outcome).toBe("unreadable");
  });

  // `not_enabled` — a fact about the component, not about a path
  it("a closed gate overrides the computed outcome while it is the latest word", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T1,
        outcome: "ok",
        rowsWritten: 2,
        manifests: [entry(WIDGETS, "go.mod", "ok", 2, T1)]
      }),
      pass({
        lastAttemptAt: T2,
        repo: null,
        outcome: "not_enabled",
        detail: "dependency subscriptions are not enabled for this component"
      })
    );
    expect(merged.outcome).toBe("not_enabled");
    expect(merged.detail).toContain("not enabled");
    // The entries stay: a closed gate prunes nothing, so the rows they explain are still there.
    expect(merged.manifests).toHaveLength(1);
    expect(merged.rowsWritten).toBe(2);
  });

  it("a closed gate is not undone by an older pass's evidence arriving late", () => {
    const merged = fold(
      stored({ lastAttemptAt: T3, outcome: "not_enabled", detail: "gate closed", manifests: [] }),
      pass({
        lastAttemptAt: T2,
        repo: WIDGETS,
        outcome: "ok",
        manifests: [{ path: "go.mod", outcome: "ok", rows: 2 }]
      })
    );
    expect(merged.outcome).toBe("not_enabled");
    expect(merged.detail).toBe("gate closed");
    // The evidence is still recorded — it is the VERDICT that the newer attempt owns.
    expect(merged.manifests).toHaveLength(1);
  });

  it("re-enabling is a new pass, and the evidence takes the verdict back", () => {
    const merged = fold(
      stored({ lastAttemptAt: T1, outcome: "not_enabled", detail: "gate closed", manifests: [] }),
      pass({
        lastAttemptAt: T2,
        repo: WIDGETS,
        outcome: "ok",
        manifests: [{ path: "go.mod", outcome: "ok", rows: 2 }]
      })
    );
    expect(merged.outcome).toBe("ok");
    expect(merged.rowsWritten).toBe(2);
    // The stale refusal sentence goes with it: where the evidence decides, the per-path details ARE
    // the explanation and a leftover component-level one would describe a different verdict.
    expect(merged.detail).toBeNull();
  });

  // The empty readings, which are the three meanings the table exists to separate
  it("a pass that LOOKED and found nothing is `ok` + 0 — 'genuinely declares nothing'", () => {
    const merged = fold(
      stored({
        lastAttemptAt: T1,
        outcome: "ok",
        rowsWritten: 2,
        manifests: [entry(WIDGETS, "go.mod", "ok", 2, T1)]
      }),
      pass({ lastAttemptAt: T2, repo: WIDGETS, outcome: "ok", manifests: [] })
    );
    expect(merged.outcome).toBe("ok");
    expect(merged.rowsWritten).toBe(0);
    expect(merged.manifests).toEqual([]);
  });

  it("drops an entry carrying no repository rather than keeping it unattributable forever", () => {
    // Only reachable from a database written by a pre-merge build of this branch (the table has
    // never shipped). Such an entry belongs to no slice, so no later pass could ever replace it.
    const legacy = { path: "go.mod", outcome: "ok", rows: 2 } as unknown as IngestionStampManifest;
    const merged = fold(
      stored({ lastAttemptAt: T1, outcome: "ok", rowsWritten: 2, manifests: [legacy] }),
      pass({
        lastAttemptAt: T2,
        repo: WIDGETS,
        outcome: "ok",
        manifests: [{ path: "go.mod", outcome: "ok", rows: 2 }]
      })
    );
    expect(merged.manifests).toEqual([entry(WIDGETS, "go.mod", "ok", 2, T2)]);
    expect(merged.rowsWritten).toBe(2);
  });
});
