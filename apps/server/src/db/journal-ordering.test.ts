import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** THE MIGRATION JOURNAL'S ORDERING INVARIANTS. See docs/db.md §3. */
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
      readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => f.replace(/\.sql$/, ""))
    );
    const inJournal = new Set(entries.map((e) => e.tag));
    expect({
      onDiskButNotJournalled: [...onDisk].filter((t) => !inJournal.has(t)).sort(),
      journalledButMissingFile: [...inJournal].filter((t) => !onDisk.has(t)).sort()
    }).toEqual({ onDiskButNotJournalled: [], journalledButMissingFile: [] });
  });
});
