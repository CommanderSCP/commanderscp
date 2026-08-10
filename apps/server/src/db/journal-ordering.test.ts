import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE MIGRATION JOURNAL'S ORDERING INVARIANTS — a guard against a merge that fails SILENTLY, and
 * specifically against the way EVERY OTHER CHECK IN THIS REPO IS BLIND TO IT.
 *
 * `drizzle-orm/pg-core/dialect.cjs` gates each migration like this:
 *
 *     const lastDbMigration = dbMigrations[0];              // newest already applied
 *     for await (const migration of migrations) {
 *       if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { ... }
 *
 * Two consequences, and the second is the trap:
 *
 *  1. `idx` IS NEVER CONSULTED FOR GATING. It orders the array; it does not decide what runs. A
 *     journal with perfect contiguous idx values can still skip a migration.
 *  2. `lastDbMigration` is read ONCE, BEFORE the loop. So on a FRESH database it is undefined and
 *     every migration applies regardless of `when` — which is exactly what every integration suite
 *     in this repo does (Testcontainers hands out a new database per file). On an EXISTING database
 *     a migration whose `when` is BELOW the newest applied one is skipped, permanently, with no
 *     error. CI is structurally incapable of catching that: green here, broken on upgrade.
 *
 * That is not hypothetical. On 2026-08-10 three branches landed migrations the same day; the
 * `reconcile_cursor` journal entry was authored while main was at 0055 and carried
 * `when: 1787940000000`, but `0057_source_mapping_ref_pattern` merged first with
 * `when: 1788006400000`. Any instance that had applied 0057 would have skipped 0058 forever — the
 * `reconcile_cursor_at` column would simply never exist, and every candidate query would fail
 * against a column the schema swore was there. Every test still passed, because they all migrate
 * from empty.
 *
 * So this asserts the property the merge conflict CANNOT: not "did we resolve the array", but "does
 * the resolved array actually apply". Resolving a `_journal.json` conflict with `--ours`/`--theirs`,
 * or appending an entry authored against an older main, breaks it — and nothing else here notices.
 */
describe("drizzle migration journal", () => {
  const journalPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "drizzle",
    "meta",
    "_journal.json"
  );
  const entries = (
    JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    }
  ).entries;

  it("has entries at all — a truncated journal would make every assertion below vacuous", () => {
    expect(entries.length).toBeGreaterThan(50);
  });

  it("orders `when` STRICTLY INCREASING — the only value drizzle actually gates on", () => {
    // Reported as the offending PAIR rather than a bare boolean: the failure is always "this entry
    // was authored before that one merged", and the two tags name the branches that raced.
    const offenders = entries
      .slice(1)
      .map((entry, i) => ({ prev: entries[i]!, entry }))
      .filter(({ prev, entry }) => entry.when <= prev.when)
      .map(
        ({ prev, entry }) =>
          `${entry.tag} (when=${entry.when}) does not exceed ${prev.tag} (when=${prev.when}) — ` +
          `an instance that applied ${prev.tag} will SKIP ${entry.tag} forever`
      );
    expect(offenders).toEqual([]);
  });

  it("numbers `idx` contiguously from 0 — array order is what drizzle walks", () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it("has no duplicate tag — two branches naming one migration is a lost migration", () => {
    const seen = new Set<string>();
    const duplicates = entries.map((e) => e.tag).filter((tag) => !seen.add(tag));
    expect(duplicates).toEqual([]);
  });

  it("has one journal entry per .sql file on disk, and no orphan of either kind", () => {
    // The other half of the same hazard: a renumbered file whose journal entry was not renamed
    // leaves a `.sql` nothing applies, and an entry with no file makes `migrate()` throw at boot.
    const dir = path.join(path.dirname(journalPath), "..");
    const onDisk = new Set(
      readFileSync
        ? // eslint-disable-next-line @typescript-eslint/no-var-requires
          (require("node:fs").readdirSync(dir) as string[])
            .filter((f) => f.endsWith(".sql"))
            .map((f) => f.replace(/\.sql$/, ""))
        : []
    );
    const inJournal = new Set(entries.map((e) => e.tag));
    expect({
      onDiskButNotJournalled: [...onDisk].filter((t) => !inJournal.has(t)).sort(),
      journalledButMissingFile: [...inJournal].filter((t) => !onDisk.has(t)).sort()
    }).toEqual({ onDiskButNotJournalled: [], journalledButMissingFile: [] });
  });
});
