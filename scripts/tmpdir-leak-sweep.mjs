#!/usr/bin/env node
// Temp-directory leak gate — CLAUDE.md "make the next omission impossible to ship".
//
// WHAT THIS CLOSES. A census (see @scp/test-tmpdir's module doc) found dozens of test files that
// `mkdtemp` a fixture directory under `os.tmpdir()` and never remove it — 10 real leaks, plus a
// production backlog in the hundreds per fixture prefix that nobody had been sweeping. The fix for
// KNOWN call sites is @scp/test-tmpdir's tracked allocator (see that package). This script is the
// gate for call sites nobody has written yet: it runs the wrapped test command and fails the BUILD
// if the run leaves ANY new directory behind under a prefix this repo's own fixtures use — a
// static per-file heuristic ("does this file have an afterEach") both over- and under-matches (see
// this branch's history for two real examples); this measures the one thing that actually matters,
// what is left on disk when the run ends.
//
// SELF-DERIVING PREFIX LIST, ON PURPOSE. A hand-maintained allowlist goes stale the moment a new
// fixture picks its own prefix — this instead reads every tracked source file for the
// `tmpdir(), "literal-prefix-"` (or `os.tmpdir(), …` / template-string) shape every fixture in this
// repo already uses, at SWEEP TIME, so a brand-new fixture is covered automatically as long as it
// follows the same convention. See `discoverPrefixes` below.
//
// SCOPED, NOT A BLANKET `os.tmpdir()` DIFF. Other processes (an editor, another Claude session, an
// unrelated build) can legitimately create their own tmp entries during the run; diffing the whole
// directory would produce false positives having nothing to do with this repo's tests. Scoping to
// prefixes this repo's own source actually uses avoids that without needing a hand-maintained list.
//
// Usage: node scripts/tmpdir-leak-sweep.mjs -- <command> [args...]
// Exit code is the wrapped command's own code, OR 1 if it succeeded but left leaked directories —
// whichever is non-zero (both failures are reported either way).

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const sepIndex = process.argv.indexOf("--");
if (sepIndex === -1 || sepIndex === process.argv.length - 1) {
  console.error("usage: node scripts/tmpdir-leak-sweep.mjs -- <command> [args...]");
  process.exit(2);
}
const [cmd, ...args] = process.argv.slice(sepIndex + 1);

/**
 * Every literal prefix this repo's TRACKED source hands to `mkdtemp`/`mkdtempSync` via
 * `tmpdir()`/`os.tmpdir()`. Matches both `import { tmpdir } from "node:os"` call-site usage and
 * `os.tmpdir()` usage, and both `"…"`/`` `…` `` literals — every shape the census found in this
 * repo. `git ls-files -z` (not a directory walk) for the same reason `nul-census.mjs` and
 * `test-script-census.test.ts` read the index rather than walking: a walk sweeps in `node_modules`
 * and `dist` and either stays permanently red or gets "fixed" with exclusions.
 */
function discoverPrefixes() {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));

  const prefixes = new Set();
  const pattern = /tmpdir\(\)\s*,\s*[`"]([^`"]+)[`"]/g;
  for (const file of files) {
    let text;
    try {
      // NUL-safe on purpose (CLAUDE.md: `grep -rna`, never `grep -rn` — the same property applies
      // to reading files in Node: a file with an embedded NUL byte is still a normal read here,
      // nothing here treats it as binary and skips it the way a naive shell grep would).
      text = readFileSync(join(repoRoot, file), "utf8");
    } catch {
      continue; // deleted-but-not-yet-`git rm`'d — tolerated like test-script-census.test.ts's read.
    }
    for (const match of text.matchAll(pattern)) {
      prefixes.add(match[1]);
    }
  }
  return prefixes;
}

/** Every `os.tmpdir()` entry whose name starts with one of the discovered prefixes. */
function snapshot(prefixes) {
  const root = tmpdir();
  const found = new Set();
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return found;
  }
  for (const name of entries) {
    for (const prefix of prefixes) {
      if (name.startsWith(prefix)) {
        found.add(join(root, name));
        break;
      }
    }
  }
  return found;
}

const prefixes = discoverPrefixes();
if (prefixes.size < 10) {
  // Sanity floor (CLAUDE.md "a claim about a tool cannot be verified with that tool" — the
  // analogous risk here is the census silently finding nothing and the gate going quietly inert).
  // Measured 2026-08-21: over 90 distinct prefixes. A number this low means the census itself
  // broke, not that the repo suddenly stopped using mkdtemp.
  console.error(
    `tmpdir-leak-sweep: discovered only ${prefixes.size} mkdtemp prefixes — expected dozens. ` +
      "Refusing to run with a gate this narrow; the discovery regex likely broke."
  );
  process.exit(2);
}

const before = snapshot(prefixes);
const result = spawnSync(cmd, args, { stdio: "inherit" });
const after = snapshot(prefixes);

const leaked = [...after].filter((p) => !before.has(p));

if (leaked.length > 0) {
  console.error(
    `\ntmpdir-leak-sweep: ${leaked.length} director${leaked.length === 1 ? "y was" : "ies were"} ` +
      "created during this run and never removed:"
  );
  for (const p of leaked.sort()) {
    console.error(`  ${p}`);
    try {
      rmSync(p, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `    (failed to sweep it: ${err instanceof Error ? err.message : String(err)})`
      );
    }
  }
  console.error(
    "Fix: allocate with @scp/test-tmpdir's mkdtempTracked/mkdtempTrackedForFile instead of the " +
      "raw fs mkdtemp/mkdtempSync — see that package's module doc.\n"
  );
}

const wrappedFailed = result.status !== 0;
const leakFailed = leaked.length > 0;
if (wrappedFailed || leakFailed) {
  process.exit(wrappedFailed ? (result.status ?? 1) : 1);
}
