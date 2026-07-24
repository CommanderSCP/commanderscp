import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import {
  DEFAULT_SCAN_DB_HARD_MAX_AGE_HOURS,
  DEFAULT_SCAN_DB_SOFT_MAX_AGE_HOURS,
  type ScanDbSource,
  type ScanDbStalenessClass,
  type ScanDbStalenessPolicy,
  type ScanDbStatus,
  type ScanDbThresholdFired
} from "@scp/schemas";
import { resolveSkopeo, verifyBlobDetached } from "@scp/cosign";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";

const execFileAsync = promisify(execFile);

/**
 * M13.3b-ii — OFFLINE SCANNER-DB PRE-LOAD + REFRESH (ADR-0020, proposal §13.3b). The single home for
 * the commander's server-maintained Trivy-DB cache: reading its on-disk `metadata.json`, classifying
 * its staleness against the operator's INSTANCE-SCOPED policy (owner decision 2026-07-24: "a company
 * applies their own rules"), asserting its schema is one the PINNED Trivy binary can read, and
 * populating it two ways — a connected operator-invoked skopeo refresh, and an air-gap operator-load
 * of a cosign-signed DB blob carried across the CDS.
 *
 * WHY A SERVER-MAINTAINED OPERATIONAL CACHE IS NEW (and does NOT violate "SCP has no blob storage
 * for promotion artifacts"): the trivy-db is the scan's INPUT (operational data), not a promotion
 * artifact SCP is caching for someone else. It is exactly the objectStorage-PVC precedent
 * (values.yaml) applied to operational scanner data.
 *
 * FAIL-CLOSED THROUGHOUT (proposal §13.3b, owner 2026-07-24): a configured-but-missing/corrupt/
 * unreadable-schema/hard-stale DB yields NO scan → NO evidence → E6 refuses. Only a fresh (or
 * soft-stale WARN) DB scans; a warn is surfaced in the ScanEvidence + Decision, never silently.
 */

/** The trivy-db schema version the PINNED Trivy binary (tools/trivy/pin.env TRIVY_DB_SCHEMA_VERSION)
 *  can read. A DB built for a different schema is UNREADABLE by that binary, so the refresh/load
 *  paths refuse it fail-closed. Kept in lockstep with pin.env by `scan-db.test.ts`. */
export const EXPECTED_TRIVY_DB_SCHEMA_VERSION = 2;

/** trivy-db's on-disk `metadata.json` (the fields we consume). */
export interface TrivyDbMetadata {
  Version: number;
  UpdatedAt: string;
  NextUpdate: string;
}

/** The org-context used to read the instance-scoped staleness-policy table. The table's RLS is
 *  `FOR SELECT USING (true)` (drizzle/0036), so any org context returns the single instance row —
 *  this is a fixed, non-tenant sentinel exactly as the read is instance-wide, not per-org. */
const SCAN_DB_POLICY_READ_ORG = "commander";

/** The sidecar the cache carries recording HOW its current DB was populated (refresh vs operator
 *  load), so the status read and the ScanEvidence can name the source honestly. */
const SOURCE_SIDECAR = "scp-scan-db-source.json";

// -------------------------------------------------------------------------------------------
// Cache path + presence
// -------------------------------------------------------------------------------------------

/** The configured DB cache dir (`SCP_MANAGED_SCAN_DB_CACHE`), or undefined ⇒ no cache (the runner
 *  falls back to the image-baked DB, the fail-closed fallback as stale as the image). */
export function scanDbCacheDir(): string | undefined {
  const v = process.env.SCP_MANAGED_SCAN_DB_CACHE;
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/** The Trivy cache stores the DB at `<cacheDir>/db/trivy.db` (+ `metadata.json`). */
function dbDir(cacheDir: string): string {
  return join(cacheDir, "db");
}

function dbFilePresent(cacheDir: string): boolean {
  return existsSync(join(dbDir(cacheDir), "trivy.db"));
}

type MetadataRead =
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "ok"; metadata: TrivyDbMetadata };

async function readTrivyDbMetadataFrom(dir: string): Promise<MetadataRead> {
  const path = join(dir, "metadata.json");
  if (!existsSync(path)) return { kind: "missing" };
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { kind: "corrupt", reason: err instanceof Error ? err.message : String(err) };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "metadata.json is not valid JSON" };
  }
  const d = doc as Partial<TrivyDbMetadata> | null;
  if (!d || typeof d.Version !== "number" || typeof d.UpdatedAt !== "string") {
    return { kind: "corrupt", reason: "metadata.json missing Version/UpdatedAt" };
  }
  return {
    kind: "ok",
    metadata: { Version: d.Version, UpdatedAt: d.UpdatedAt, NextUpdate: typeof d.NextUpdate === "string" ? d.NextUpdate : "" }
  };
}

async function readSource(cacheDir: string): Promise<ScanDbSource | null> {
  const path = join(cacheDir, SOURCE_SIDECAR);
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(await readFile(path, "utf8")) as { source?: unknown };
    if (doc.source === "refreshed" || doc.source === "operator-loaded") return doc.source;
  } catch {
    /* fall through */
  }
  return null;
}

async function writeSource(cacheDir: string, source: ScanDbSource): Promise<void> {
  await writeFile(
    join(cacheDir, SOURCE_SIDECAR),
    JSON.stringify({ source, at: new Date().toISOString() }),
    "utf8"
  );
}

// -------------------------------------------------------------------------------------------
// Staleness classifier — PURE (BUILD_AND_TEST §4.1: anything testable as a pure function is one),
// so fresh/warn/hard-fail/missing/corrupt is unit-testable without a DB or a filesystem.
// -------------------------------------------------------------------------------------------

export interface ScanDbClassifyInput {
  now: Date;
  dbFilePresent: boolean;
  metadata: MetadataRead;
  softMaxAgeHours: number;
  hardMaxAgeHours: number;
  expectedSchemaVersion: number;
}

export interface ScanDbClassification {
  staleness: ScanDbStalenessClass;
  thresholdFired: ScanDbThresholdFired;
  ageHours: number | null;
  schemaVersion: number | null;
  schemaCompatible: boolean;
  updatedAt: string | null;
  nextUpdate: string | null;
  /** True only for `fresh`/`warn` — the runner may scan; `missing`/`corrupt`/`hard-fail` are refused. */
  scannable: boolean;
  detail: string;
}

/** Classify a candidate DB against the active staleness policy + the pinned schema version. A DB
 *  file that is absent → `missing`; present-but-unreadable/wrong-schema → `corrupt`; older than the
 *  hard bound → `hard-fail`; older than the soft bound → `warn` (still scans); otherwise `fresh`. */
export function classifyScanDbStaleness(input: ScanDbClassifyInput): ScanDbClassification {
  if (!input.dbFilePresent) {
    return {
      staleness: "missing",
      thresholdFired: "none",
      ageHours: null,
      schemaVersion: null,
      schemaCompatible: false,
      updatedAt: null,
      nextUpdate: null,
      scannable: false,
      detail: "scan DB cache is configured but holds no trivy.db — fail-closed (no scan → no evidence → E6 refuses)"
    };
  }
  if (input.metadata.kind !== "ok") {
    const reason = input.metadata.kind === "missing" ? "metadata.json absent" : input.metadata.reason;
    return {
      staleness: "corrupt",
      thresholdFired: "none",
      ageHours: null,
      schemaVersion: null,
      schemaCompatible: false,
      updatedAt: null,
      nextUpdate: null,
      scannable: false,
      detail: `scan DB metadata is unreadable (${reason}) — fail-closed`
    };
  }
  const metadata = input.metadata.metadata;
  const schemaCompatible = metadata.Version === input.expectedSchemaVersion;
  if (!schemaCompatible) {
    return {
      staleness: "corrupt",
      thresholdFired: "none",
      ageHours: null,
      schemaVersion: metadata.Version,
      schemaCompatible: false,
      updatedAt: metadata.UpdatedAt,
      nextUpdate: metadata.NextUpdate || null,
      scannable: false,
      detail: `scan DB schema v${metadata.Version} is not readable by the pinned Trivy (needs v${input.expectedSchemaVersion}) — fail-closed`
    };
  }
  const updatedMs = Date.parse(metadata.UpdatedAt);
  if (Number.isNaN(updatedMs)) {
    return {
      staleness: "corrupt",
      thresholdFired: "none",
      ageHours: null,
      schemaVersion: metadata.Version,
      schemaCompatible: true,
      updatedAt: metadata.UpdatedAt,
      nextUpdate: metadata.NextUpdate || null,
      scannable: false,
      detail: `scan DB UpdatedAt '${metadata.UpdatedAt}' is unparseable — fail-closed`
    };
  }
  const ageHours = Math.max(0, (input.now.getTime() - updatedMs) / 3_600_000);
  const base = {
    schemaVersion: metadata.Version,
    schemaCompatible: true,
    updatedAt: metadata.UpdatedAt,
    nextUpdate: metadata.NextUpdate || null,
    ageHours
  };
  if (ageHours > input.hardMaxAgeHours) {
    return {
      ...base,
      staleness: "hard-fail",
      thresholdFired: "hard",
      scannable: false,
      detail: `scan DB is ${ageHours.toFixed(1)}h old, past the hard max ${input.hardMaxAgeHours}h — fail-closed`
    };
  }
  if (ageHours > input.softMaxAgeHours) {
    return {
      ...base,
      staleness: "warn",
      thresholdFired: "soft",
      scannable: true,
      detail: `scan DB is ${ageHours.toFixed(1)}h old, past the soft max ${input.softMaxAgeHours}h — WARN (scanning with a stale DB)`
    };
  }
  return {
    ...base,
    staleness: "fresh",
    thresholdFired: "none",
    scannable: true,
    detail: `scan DB is ${ageHours.toFixed(1)}h old (within soft max ${input.softMaxAgeHours}h)`
  };
}

// -------------------------------------------------------------------------------------------
// Instance staleness policy (the operator's commander-level setting)
// -------------------------------------------------------------------------------------------

interface PolicyRow extends Record<string, unknown> {
  soft_max_age_hours: number | null;
  hard_max_age_hours: number | null;
  note: string | null;
  updated_at: Date | string;
}

/** Read the operator's staleness policy (the singleton instance row), with the built-in defaults
 *  substituted for any unset bound. Reads under the table's tenant-read RLS, exactly as
 *  `readInstanceScanFloors` does — no privileged connection needed. */
export async function readScanDbStalenessPolicy(db: Db): Promise<ScanDbStalenessPolicy> {
  const rows = await withTenantTx(db, SCAN_DB_POLICY_READ_ORG, async (tx) => {
    const result = await tx.execute<PolicyRow>(sql`
      SELECT soft_max_age_hours, hard_max_age_hours, note, updated_at
      FROM scan_db_staleness_policy
      WHERE id = 'default'
    `);
    return result.rows;
  });
  const row = rows[0];
  const soft = row?.soft_max_age_hours ?? null;
  const hard = row?.hard_max_age_hours ?? null;
  const isDefault = !row || (soft === null && hard === null);
  return {
    softMaxAgeHours: soft,
    hardMaxAgeHours: hard,
    note: row?.note ?? null,
    updatedAt: row
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at)
      : new Date(0).toISOString(),
    isDefault,
    effectiveSoftMaxAgeHours: soft ?? DEFAULT_SCAN_DB_SOFT_MAX_AGE_HOURS,
    effectiveHardMaxAgeHours: hard ?? DEFAULT_SCAN_DB_HARD_MAX_AGE_HOURS
  };
}

/** The effective bounds, tolerant of a missing db handle (falls back to built-in defaults) — used by
 *  the runner, which classifies without a tenant context of its own. */
export async function resolveActiveStalenessBounds(
  db: Db | undefined
): Promise<{ softMaxAgeHours: number; hardMaxAgeHours: number; policy: ScanDbStalenessPolicy | null }> {
  if (!db) {
    return {
      softMaxAgeHours: DEFAULT_SCAN_DB_SOFT_MAX_AGE_HOURS,
      hardMaxAgeHours: DEFAULT_SCAN_DB_HARD_MAX_AGE_HOURS,
      policy: null
    };
  }
  const policy = await readScanDbStalenessPolicy(db);
  return {
    softMaxAgeHours: policy.effectiveSoftMaxAgeHours,
    hardMaxAgeHours: policy.effectiveHardMaxAgeHours,
    policy
  };
}

// -------------------------------------------------------------------------------------------
// Status projection (the tenant-readable GET /instance/scan-db)
// -------------------------------------------------------------------------------------------

/** The full status of the DB the runner would consume — the API projection + the block reason a
 *  Decision would cite. `cacheDir` undefined ⇒ the baked-image fallback (no staleness gate). */
export async function readScanDbStatus(db: Db | undefined, cacheDir: string | undefined): Promise<ScanDbStatus> {
  const { softMaxAgeHours, hardMaxAgeHours } = await resolveActiveStalenessBounds(db);
  if (!cacheDir) {
    // No cache: the runner uses the image-baked DB. We cannot introspect its age from here (it lives
    // inside the runner image), so we report the honest "baked" fallback with no staleness gate.
    return {
      cacheConfigured: false,
      present: true,
      source: "baked",
      ageHours: null,
      updatedAt: null,
      nextUpdate: null,
      schemaVersion: null,
      expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION,
      schemaCompatible: true,
      staleness: "fresh",
      thresholdFired: "none",
      activeSoftMaxAgeHours: softMaxAgeHours,
      activeHardMaxAgeHours: hardMaxAgeHours,
      detail: "no DB cache configured — the runner uses the image-baked DB (as stale as the image; no staleness gate)"
    };
  }
  const present = dbFilePresent(cacheDir);
  const metadata = present ? await readTrivyDbMetadataFrom(dbDir(cacheDir)) : ({ kind: "missing" } as MetadataRead);
  const c = classifyScanDbStaleness({
    now: new Date(),
    dbFilePresent: present,
    metadata,
    softMaxAgeHours,
    hardMaxAgeHours,
    expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION
  });
  const source: ScanDbSource = present ? (await readSource(cacheDir)) ?? "refreshed" : "absent";
  return {
    cacheConfigured: true,
    present,
    source,
    ageHours: c.ageHours,
    updatedAt: c.updatedAt,
    nextUpdate: c.nextUpdate,
    schemaVersion: c.schemaVersion,
    expectedSchemaVersion: EXPECTED_TRIVY_DB_SCHEMA_VERSION,
    schemaCompatible: c.schemaCompatible,
    staleness: c.staleness,
    thresholdFired: c.thresholdFired,
    activeSoftMaxAgeHours: softMaxAgeHours,
    activeHardMaxAgeHours: hardMaxAgeHours,
    detail: c.detail
  };
}

// -------------------------------------------------------------------------------------------
// Populating the cache — the atomic swap shared by refresh + operator-load
// -------------------------------------------------------------------------------------------

/**
 * Build a fresh DB directory in staging, VALIDATE it (trivy.db present + readable metadata + a
 * schema the pinned binary accepts), then ATOMICALLY swap it into `<cacheDir>/db` — no torn read
 * during a concurrent scan (a scan `docker cp`s a point-in-time snapshot of the dir; `rename` keeps
 * any already-opened inode intact). Refuses (throws, no cache write) a DB the pinned Trivy can't
 * read. Staging is created UNDER `cacheDir` so the rename is same-filesystem (hence atomic).
 */
export async function atomicInstallDb(
  cacheDir: string,
  source: ScanDbSource,
  populate: (stagingDbDir: string) => Promise<void>
): Promise<TrivyDbMetadata> {
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(join(cacheDir, ".staging-"));
  try {
    const stagingDb = join(staging, "db");
    await mkdir(stagingDb, { recursive: true });
    await populate(stagingDb);

    // VALIDATE before we touch the live cache.
    if (!existsSync(join(stagingDb, "trivy.db"))) {
      throw new Error("scan-db install: staged payload has no trivy.db — refusing");
    }
    const meta = await readTrivyDbMetadataFrom(stagingDb);
    if (meta.kind !== "ok") {
      throw new Error(
        `scan-db install: staged metadata unreadable (${meta.kind === "corrupt" ? meta.reason : "absent"}) — refusing`
      );
    }
    if (meta.metadata.Version !== EXPECTED_TRIVY_DB_SCHEMA_VERSION) {
      throw new Error(
        `scan-db install: staged DB schema v${meta.metadata.Version} is not readable by the pinned Trivy ` +
          `(needs v${EXPECTED_TRIVY_DB_SCHEMA_VERSION}) — refusing (see tools/trivy/pin.env)`
      );
    }

    // ATOMIC SWAP: move the live db aside, move the validated staging db into place, then drop the old.
    const target = dbDir(cacheDir);
    const old = join(cacheDir, `.db.old-${Date.now()}`);
    if (existsSync(target)) await rename(target, old);
    await rename(stagingDb, target);
    await writeSource(cacheDir, source);
    if (existsSync(old)) await rm(old, { recursive: true, force: true });
    return meta.metadata;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Untar (auto-detecting gzip) `archivePath` into a temp dir and copy the discovered `trivy.db` +
 *  `metadata.json` (at ANY depth — tolerant of both a `db/`-prefixed blob and the flat trivy-db OCI
 *  layer) flatly into `destDbDir`. */
async function extractDbFilesInto(archivePath: string, destDbDir: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "scp-scan-db-x-"));
  try {
    await execFileAsync("tar", ["-xf", archivePath, "-C", scratch], { maxBuffer: 256 * 1024 * 1024 });
    const found = new Map<string, string>();
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name === "trivy.db" || entry.name === "metadata.json") found.set(entry.name, p);
      }
    }
    await walk(scratch);
    const dbSrc = found.get("trivy.db");
    const metaSrc = found.get("metadata.json");
    if (!dbSrc || !metaSrc) {
      throw new Error("scan-db blob: archive did not contain both trivy.db and metadata.json");
    }
    await mkdir(destDbDir, { recursive: true });
    await writeFile(join(destDbDir, "trivy.db"), await readFile(dbSrc));
    await writeFile(join(destDbDir, "metadata.json"), await readFile(metaSrc));
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

// -------------------------------------------------------------------------------------------
// Connected refresh — operator-invoked skopeo pull of the upstream OCI trivy-db
// -------------------------------------------------------------------------------------------

/** The upstream OCI trivy-db (proposal §13.3b). Overridable for a mirror, but the host must still be
 *  in SCP_ARTIFACT_OCI_REGISTRY_HOSTS. */
function trivyDbOciRef(): string {
  return process.env.SCP_MANAGED_SCAN_DB_OCI_REF ?? "ghcr.io/aquasec/trivy-db:2";
}

function ociAllowlist(): string[] {
  return (process.env.SCP_ARTIFACT_OCI_REGISTRY_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

function ociHostOf(ref: string): string | null {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const first = ref.slice(0, slash).toLowerCase();
  if (first === "localhost" || first.includes(".") || first.includes(":")) return first;
  return null;
}

/**
 * Connected refresh: skopeo-copy the upstream OCI trivy-db (allowlist-guarded, ADR-0019 §4) into a
 * `dir:` layout, extract its layer(s), and atomically install the resulting DB into the cache with
 * the schema-compat assertion. Operator-invoked; the ONE place this reaches the network, exactly the
 * vendored-skopeo channel #111 established. Returns the installed metadata.
 */
export async function refreshScanDbConnected(cacheDir: string): Promise<TrivyDbMetadata> {
  const ref = trivyDbOciRef();
  const host = ociHostOf(ref);
  if (!host) throw new Error(`scan-db refresh: '${ref}' names no registry host — refusing`);
  if (!ociAllowlist().includes(host)) {
    throw new Error(
      `scan-db refresh: registry host '${host}' is not in SCP_ARTIFACT_OCI_REGISTRY_HOSTS (fail-closed)`
    );
  }
  const skopeo = resolveSkopeo();
  const scratch = await mkdtemp(join(tmpdir(), "scp-scan-db-pull-"));
  try {
    const layout = join(scratch, "layout");
    await execFileAsync(
      skopeo.bin,
      ["copy", "--override-os", "linux", `docker://${ref}`, `dir:${layout}`],
      { timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }
    );
    // The `dir:` transport writes manifest.json + one blob file per digest (named by hex). Extract
    // every layer; the trivy-db is a single tar+gzip layer of {trivy.db, metadata.json}.
    const manifest = JSON.parse(await readFile(join(layout, "manifest.json"), "utf8")) as {
      layers?: { digest?: string }[];
    };
    const layers = (manifest.layers ?? [])
      .map((l) => l.digest)
      .filter((d): d is string => typeof d === "string")
      .map((d) => d.replace(/^sha256:/, ""));
    if (layers.length === 0) throw new Error("scan-db refresh: pulled manifest has no layers");
    return await atomicInstallDb(cacheDir, "refreshed", async (stagingDb) => {
      for (const layerHex of layers) {
        const blob = join(layout, layerHex);
        if (existsSync(blob)) await extractDbFilesInto(blob, stagingDb).catch(() => undefined);
      }
    });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

// -------------------------------------------------------------------------------------------
// Air-gap operator-load — verify a cosign-signed DB blob, then install it
// -------------------------------------------------------------------------------------------

function normalizeSha256(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  const hex = v.startsWith("sha256:") ? v.slice(7) : v;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

export interface LoadScanDbBlobInput {
  cacheDir: string;
  blobPath: string;
  signaturePath: string;
  publicKeyPath: string;
  expectedDigest?: string;
}

/**
 * Air-gap operator-load: VERIFY a cosign-signed DB blob (detached signature against the operator's
 * public key, plus an optional digest cross-check) BEFORE accepting the bytes into the cache. No
 * federation message/flow — the operator produced the signed blob at the connected side (skopeo-pull
 * + repackage + cosign sign-blob) and walked it across the CDS. The blob is the SAME `type:'blob'`
 * shape as the connected repackage: a (gzipped) tar carrying trivy.db + metadata.json. A tampered
 * blob / wrong key / digest mismatch is REFUSED with NO cache write.
 */
export async function loadScanDbBlob(input: LoadScanDbBlobInput): Promise<TrivyDbMetadata> {
  if (!existsSync(input.blobPath)) throw new Error(`scan-db load: blob '${input.blobPath}' not found`);
  if (!existsSync(input.signaturePath)) throw new Error(`scan-db load: signature '${input.signaturePath}' not found`);
  if (!existsSync(input.publicKeyPath)) throw new Error(`scan-db load: public key '${input.publicKeyPath}' not found`);

  const bytes = await readFile(input.blobPath);
  // DIGEST BINDING (defence in depth over the signature): the bytes must hash to the operator's
  // stated digest, when given. The cosign detached-signature verify below is the trust anchor.
  if (input.expectedDigest) {
    const want = normalizeSha256(input.expectedDigest);
    if (!want) throw new Error(`scan-db load: expectedDigest '${input.expectedDigest}' is not a sha256 digest`);
    const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (got !== want) {
      throw new Error(`scan-db load: blob hashes to ${got} but expected ${want} — refusing (no cache write)`);
    }
  }
  const verdict = verifyBlobDetached(input.blobPath, input.signaturePath, input.publicKeyPath);
  if (!verdict.ok) {
    throw new Error(`scan-db load: cosign detached-signature verification FAILED — refusing (no cache write): ${verdict.detail}`);
  }
  // Only now, with the bytes proven authentic, extract + atomically install (with schema assertion).
  return atomicInstallDb(input.cacheDir, "operator-loaded", async (stagingDb) => {
    await extractDbFilesInto(input.blobPath, stagingDb);
  });
}

/** Best-effort byte size of the configured cache's db (diagnostics only). */
export async function scanDbSizeBytes(cacheDir: string): Promise<number | null> {
  try {
    const s = await stat(join(dbDir(cacheDir), "trivy.db"));
    return s.size;
  } catch {
    return null;
  }
}
