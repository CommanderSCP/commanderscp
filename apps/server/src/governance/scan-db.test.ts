import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, mkdir, writeFile, rm, readFile as read } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_TRIVY_DB_SCHEMA_VERSION,
  atomicInstallDb,
  classifyScanDbStaleness
} from "./scan-db.js";

/**
 * M13.3b-ii unit tests (ADR-0020, proposal §13.3b) — the pure staleness classifier, the schema-compat
 * assertion, and the atomic-swap install. The connected-refresh (skopeo pull) and the cosign-verify
 * load are exercised in the integration suite (they need network/cosign); here we prove the decision
 * logic + the fail-closed swap without either.
 */

const NOW = new Date("2026-07-24T00:00:00Z");
const SOFT = 168; // 7d
const HARD = 720; // 30d

function meta(hoursOld: number, version = EXPECTED_TRIVY_DB_SCHEMA_VERSION) {
  const updated = new Date(NOW.getTime() - hoursOld * 3_600_000).toISOString();
  return {
    kind: "ok" as const,
    metadata: { Version: version, UpdatedAt: updated, NextUpdate: "" }
  };
}

describe("classifyScanDbStaleness", () => {
  it("fresh — within the soft bound", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: true,
      metadata: meta(24),
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("fresh");
    expect(c.thresholdFired).toBe("none");
    expect(c.scannable).toBe(true);
    expect(c.schemaCompatible).toBe(true);
  });

  it("warn — past the soft bound but within the hard bound (still scans)", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: true,
      metadata: meta(200),
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("warn");
    expect(c.thresholdFired).toBe("soft");
    expect(c.scannable).toBe(true);
  });

  it("hard-fail — past the hard bound (fail-closed)", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: true,
      metadata: meta(800),
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("hard-fail");
    expect(c.thresholdFired).toBe("hard");
    expect(c.scannable).toBe(false);
  });

  it("missing — no DB file present (fail-closed)", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: false,
      metadata: { kind: "missing" },
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("missing");
    expect(c.scannable).toBe(false);
  });

  it("corrupt — unreadable metadata (fail-closed)", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: true,
      metadata: { kind: "corrupt", reason: "bad json" },
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("corrupt");
    expect(c.scannable).toBe(false);
  });

  it("corrupt — schema the pinned binary can't read (fail-closed), even when age is fresh", () => {
    const c = classifyScanDbStaleness({
      now: NOW,
      dbFilePresent: true,
      metadata: meta(1, EXPECTED_TRIVY_DB_SCHEMA_VERSION + 1),
      softMaxAgeHours: SOFT,
      hardMaxAgeHours: HARD,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
    });
    expect(c.staleness).toBe("corrupt");
    expect(c.schemaCompatible).toBe(false);
    expect(c.scannable).toBe(false);
    expect(c.detail).toContain("not readable by the pinned Trivy");
  });
});

describe("EXPECTED_TRIVY_DB_SCHEMA_VERSION drift", () => {
  it("matches tools/trivy/pin.env TRIVY_DB_SCHEMA_VERSION byte-for-byte", async () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pinEnv = resolve(here, "../../../../tools/trivy/pin.env");
    const text = await readFile(pinEnv, "utf8");
    const m = /^TRIVY_DB_SCHEMA_VERSION=(\d+)$/m.exec(text);
    expect(m, "pin.env must declare TRIVY_DB_SCHEMA_VERSION").not.toBeNull();
    expect(Number(m![1])).toBe(EXPECTED_TRIVY_DB_SCHEMA_VERSION);
  });
});

describe("atomicInstallDb", () => {
  async function stageValid(dir: string, hoursOld = 1, version = EXPECTED_TRIVY_DB_SCHEMA_VERSION) {
    await writeFile(join(dir, "trivy.db"), "fake-db-bytes");
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        Version: version,
        UpdatedAt: new Date(Date.now() - hoursOld * 3_600_000).toISOString(),
        NextUpdate: new Date().toISOString()
      })
    );
  }

  it("installs a valid DB, writes the source sidecar, and swaps atomically over an existing one", async () => {
    const cache = await mkdtemp(join(tmpdir(), "scp-scan-db-cache-"));
    try {
      await atomicInstallDb(cache, "refreshed", (staging) => stageValid(staging));
      expect(existsSync(join(cache, "db", "trivy.db"))).toBe(true);
      expect(existsSync(join(cache, "db", "metadata.json"))).toBe(true);
      const sidecar = JSON.parse(await read(join(cache, "scp-scan-db-source.json"), "utf8"));
      expect(sidecar.source).toBe("refreshed");

      // Swap in a new DB — the old is replaced, the sidecar updated.
      await atomicInstallDb(cache, "operator-loaded", async (staging) => {
        await writeFile(join(staging, "trivy.db"), "newer-db-bytes");
        await writeFile(
          join(staging, "metadata.json"),
          JSON.stringify({ Version: EXPECTED_TRIVY_DB_SCHEMA_VERSION, UpdatedAt: new Date().toISOString(), NextUpdate: "" })
        );
      });
      expect(await read(join(cache, "db", "trivy.db"), "utf8")).toBe("newer-db-bytes");
      const sidecar2 = JSON.parse(await read(join(cache, "scp-scan-db-source.json"), "utf8"));
      expect(sidecar2.source).toBe("operator-loaded");
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("REFUSES a DB whose schema the pinned binary can't read, leaving any existing DB intact", async () => {
    const cache = await mkdtemp(join(tmpdir(), "scp-scan-db-cache-"));
    try {
      await atomicInstallDb(cache, "refreshed", (staging) => stageValid(staging));
      await expect(
        atomicInstallDb(cache, "refreshed", (staging) =>
          stageValid(staging, 1, EXPECTED_TRIVY_DB_SCHEMA_VERSION + 1)
        )
      ).rejects.toThrow(/not readable by the pinned Trivy/);
      // The good DB is still there (no torn/partial swap).
      expect(existsSync(join(cache, "db", "trivy.db"))).toBe(true);
      const meta = JSON.parse(await read(join(cache, "db", "metadata.json"), "utf8"));
      expect(meta.Version).toBe(EXPECTED_TRIVY_DB_SCHEMA_VERSION);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("REFUSES a staged payload with no trivy.db", async () => {
    const cache = await mkdtemp(join(tmpdir(), "scp-scan-db-cache-"));
    try {
      await expect(
        atomicInstallDb(cache, "refreshed", async (staging) => {
          await mkdir(staging, { recursive: true });
          await writeFile(join(staging, "metadata.json"), JSON.stringify({ Version: EXPECTED_TRIVY_DB_SCHEMA_VERSION, UpdatedAt: new Date().toISOString() }));
        })
      ).rejects.toThrow(/no trivy\.db/);
    } finally {
      await rm(cache, { recursive: true, force: true });
    }
  });
});
