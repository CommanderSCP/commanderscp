#!/usr/bin/env node
// NUL-byte census — CLAUDE.md "Census by property, not by symptom", BUILD_AND_TEST.md §4.4b.
//
// Why this exists. Several tracked source files legitimately contain literal NUL bytes: NUL is used
// as a composite-key delimiter precisely because it cannot occur in the components being joined
// (e.g. `${typeId}\x00${fromUrn}\x00${toUrn}`). That is correct and must not be "fixed".
//
// The cost is that every search tool this repo reaches for classifies those files as BINARY and
// drops them from a recursive search WITHOUT SAYING SO — `grep -rn` and `rg` both print nothing and
// exit 1, which is byte-for-byte the same result as "no such code exists". A census run with the
// documented `grep -rn` therefore silently skips these files. `plan-diff.ts` holds the sole label
// test that makes an object a delete candidate, so an IaC-deletion census that misses it misses the
// only place that matters.
//
// This script is the ONLY reliable enumeration: it reads bytes, so no tool-level binary heuristic
// can hide a file from it. It keeps the affected set KNOWN as files come and go, so that "which
// files do I need `-a` for?" always has a current, committed answer rather than a remembered one.
//
// Never touches the network. Runs in well under a second over the whole index.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Tracked files known to contain NUL bytes. Keep sorted. Adding or removing an entry is a
// deliberate act — see the remedy text below for what each change means.
const EXPECTED = [
  "apps/server/src/dependencies/ingestion-stamp-repo.ts",
  "apps/server/src/iac/plan-diff.ts",
  "packages/iac/src/construct.ts",
  "packages/sdk/src/response-validation.ts",
  "tools/openapi/bin/oasdiff-linux-amd64"
];

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024
})
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const found = [];
for (const rel of tracked) {
  const abs = join(repoRoot, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    continue; // submodule pointer, sparse checkout, or a path removed from the worktree
  }
  if (!st.isFile()) continue;
  if (readFileSync(abs).includes(0)) found.push(rel);
}
found.sort();

const expected = [...EXPECTED].sort();
const added = found.filter((f) => !expected.includes(f));
const removed = expected.filter((f) => !found.includes(f));

if (process.argv.includes("--list")) {
  for (const f of found) console.log(f);
  process.exit(0);
}

if (added.length === 0 && removed.length === 0) {
  console.log(
    `nul-census: ${found.length} NUL-carrying tracked files, as expected (${tracked.length} scanned).`
  );
  process.exit(0);
}

console.error("nul-census: the set of NUL-carrying tracked files changed.\n");
for (const f of added) console.error(`  + ${f}`);
for (const f of removed) console.error(`  - ${f}`);
console.error(`
What this means
  These files contain literal NUL bytes. That is usually CORRECT — NUL is used as a composite-key
  delimiter because it cannot occur in the components being joined. Do NOT "fix" it by changing the
  delimiter; that reintroduces the collision bug it was chosen to prevent.

Why you are being told
  grep and ripgrep silently drop these files from a recursive search. Both print NOTHING and exit 1
  — indistinguishable from "no such code exists". Any census that has to be complete must use
  \`grep -rna\` / \`rg --text\`, or not use grep at all.

Remedy
  * A file was ADDED: confirm the NUL is deliberate, then add it to EXPECTED in scripts/nul-census.mjs.
  * A file was REMOVED: confirm the removal was intended (not an accidental delimiter change), then
    drop it from EXPECTED.
  * Regenerate the current list at any time with:  node scripts/nul-census.mjs --list
`);
process.exit(1);
