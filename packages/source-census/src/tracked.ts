import { execFileSync } from "node:child_process";

/**
 * Every path `git ls-files` tracks under `repoRoot` — THE population for any census over this
 * repo's own source. `git ls-files -z`, not a directory walk, for the reason
 * `scanner-containment.test.ts` states: a walk sweeps in `node_modules` and build output and ends
 * up either permanently red or "fixed" with exclusions; and `-z` because some tracked files
 * legitimately contain bytes that would corrupt line-based parsing (see CLAUDE.md on the NUL-byte
 * files).
 *
 * Hoisted here 2026-08-31 from three byte-identical private copies inside this package's own
 * census tests — the package whose module doc calls it "THE SHARED MACHINERY FOR READING THIS
 * REPO'S OWN SOURCE" had not shared the very first step of every census it hosts, so a fix to one
 * copy (maxBuffer, submodules) would have silently missed the other two.
 */
export function trackedFiles(repoRoot: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}
