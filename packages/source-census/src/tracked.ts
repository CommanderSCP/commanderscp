import { execFileSync } from "node:child_process";

/** Every path `git ls-files` tracks under `repoRoot`. See docs/source-census.md §33. */
export function trackedFiles(repoRoot: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter((p) => p.length > 0);
}
