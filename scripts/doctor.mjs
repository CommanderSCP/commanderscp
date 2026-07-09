#!/usr/bin/env node
// Toolchain sanity check — BUILD_AND_TEST.md §1.
// Verifies node/pnpm/docker/compose versions and that the docker daemon is reachable.
// Never touches the network.

import { execFileSync } from "node:child_process";

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function check(name, fn) {
  try {
    const { ok, detail } = fn();
    results.push({ name, ok, detail });
  } catch (err) {
    results.push({
      name,
      ok: false,
      detail: `error: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

function satisfiesRange(major, minor, minMajor, minMinor, maxMajorExclusive) {
  if (major < minMajor) return false;
  if (major === minMajor && minor < minMinor) return false;
  if (major >= maxMajorExclusive) return false;
  return true;
}

check("node", () => {
  const v = process.versions.node; // e.g. 22.17.0
  const parts = v.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const ok = satisfiesRange(major, minor, 22, 11, 23);
  return {
    ok,
    detail: ok
      ? `v${v} (expected >=22.11 <23)`
      : `v${v} does NOT satisfy >=22.11 <23 — this is a recorded deviation from BUILD_AND_TEST.md §1; run this repo's tooling with Node 22.x (e.g. via corepack/nvm/asdf).`
  };
});

check("pnpm", () => {
  const v = run("pnpm", ["-v"]);
  if (!v) return { ok: false, detail: "pnpm not found on PATH" };
  const major = Number(v.split(".")[0]);
  const ok = major === 10;
  return { ok, detail: `${v} (expected 10.x, pinned via packageManager + corepack)` };
});

check("docker", () => {
  const v = run("docker", ["--version"]);
  if (!v) return { ok: false, detail: "docker not found on PATH" };
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  const ok = Boolean(match) && Number(match[1]) >= 27;
  return { ok, detail: `${v} (expected Engine 27+)` };
});

check("docker compose", () => {
  const v = run("docker", ["compose", "version"]);
  if (!v) return { ok: false, detail: "`docker compose` (v2 plugin) not found" };
  const match = v.match(/v?(\d+)\.(\d+)\.(\d+)/);
  const ok =
    Boolean(match) && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 29));
  return { ok, detail: `${v} (expected 2.29+)` };
});

check("docker daemon", () => {
  const v = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return {
    ok: Boolean(v),
    detail: v
      ? `reachable (server ${v})`
      : "daemon not reachable — start Docker Desktop/colima before `docker compose up`"
  };
});

check("git", () => {
  const v = run("git", ["--version"]);
  return { ok: Boolean(v), detail: v ?? "git not found" };
});

const width = Math.max(...results.map((r) => r.name.length));
let allOk = true;
for (const r of results) {
  allOk = allOk && r.ok;
  const status = r.ok ? "OK  " : "FAIL";
  console.log(`[${status}] ${r.name.padEnd(width)}  ${r.detail}`);
}

if (!allOk) {
  console.error("\ndoctor: one or more checks failed — see FAIL lines above.");
  process.exitCode = 1;
} else {
  console.log("\ndoctor: all checks passed.");
}
