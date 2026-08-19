import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyBlobDetached } from "@scp/cosign";
import type { DependencyIndexEcosystem } from "@scp/plugin-api";
import { boundText } from "@scp/runner-launcher";

/**
 * M21.4 — THE AIR-GAP VERSION FEED (ADR-0032 §7, charter principle 5).
 *
 * A disconnected commander cannot reach `proxy.golang.org`, and it must not pretend otherwise. The
 * ONLY external-feed pattern this platform has ever shipped is the Trivy scanner DB
 * (`governance/scan-db.ts`, migrations 0035/0036), and this module copies its shape deliberately
 * rather than inventing a second one:
 *
 *  | Trivy DB (shipped)                       | dependency version feed (here)                  |
 *  |------------------------------------------|-------------------------------------------------|
 *  | operator-invoked connected refresh        | {@link buildDependencyIndexFeed} at the connected side |
 *  | cosign detached-signature operator-load   | {@link loadDependencyIndexFeedBlob}             |
 *  | digest binding over the signature         | `expectedDigest`, same defence in depth         |
 *  | atomic install, never a partial cache     | staging file + `rename`                         |
 *  | fail-closed staleness policy              | {@link readDependencyIndexFeed}'s `hard` class  |
 *  | no cache ⇒ no scan ⇒ E6 refuses           | no feed ⇒ `unavailable`, never "no new version" |
 *
 * WHY FAIL-CLOSED STALENESS IS THE LOAD-BEARING PART. A stale feed does not merely miss a bump: it
 * ASSERTS a head that has since moved, and every subscriber then looks up to date against a version
 * that is months old. That is the "wrong version is worse than no version" rule (ADR-0032 §7) in its
 * air-gap form, so a feed past the operator's hard bound is REFUSED, not used with a warning.
 *
 * WHAT THIS IS NOT. It is not a mirror, not a cache of a live index, and not something SCP fetches.
 * The bytes are produced at the connected side, signed there, carried across the CDS by an operator,
 * and loaded here — the same walk the scanner DB blob makes, for the same reason: an air-gapped
 * domain has no other honest way to learn a fact about the outside world.
 *
 * SCOPE, STATED RATHER THAN DISCOVERED: this feed is INSTANCE-scoped operator infrastructure on
 * disk, exactly as the Trivy cache is. It is not a graph object, does not federate, and carries no
 * org data — it is a list of public version strings.
 */

/** One coordinate's published versions, as the connected side observed them. */
export interface DependencyIndexFeedEntry {
  ecosystem: DependencyIndexEcosystem;
  /** VERBATIM, in the ecosystem's own spelling — the same identity rule the inventory keys on
   *  (ADR-0032 Context 2). {@link lookupFeedVersions} compares it with `===`. */
  coordinate: string;
  /** Version strings exactly as the index published them. The feed carries NO ordering claim and no
   *  "latest": ranking is `version-index.ts`'s `selectLineHead`, the one place it may happen. */
  versions: string[];
}

export interface DependencyIndexFeedDocument {
  /** Bumped only on an incompatible shape change; an unknown version is REFUSED, never
   *  best-effort-parsed — a feed this build cannot read is exactly the case where guessing is worst. */
  schemaVersion: 1;
  /** ISO-8601. The age this is measured against is what the staleness policy classifies, and it is
   *  the moment the CONNECTED side observed the versions — not the moment the operator loaded the
   *  file, which would reset the clock on data that never changed. */
  generatedAt: string;
  entries: DependencyIndexFeedEntry[];
}

export const DEPENDENCY_INDEX_FEED_FILE = "dependency-index-feed.json";
const SOURCE_SIDECAR = "scp-dependency-index-feed-source.json";

/** Defaults chosen to be conservative but usable for a CDS walk an operator performs on a cadence:
 *  a week before "this is getting old", a month before it is refused. Both are operator-overridable
 *  because "a company applies their own rules" — the same owner decision that made the scan-db
 *  staleness policy instance-scoped. */
export const DEFAULT_FEED_SOFT_MAX_AGE_HOURS = 24 * 7;
export const DEFAULT_FEED_HARD_MAX_AGE_HOURS = 24 * 30;

export function dependencyIndexFeedDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.SCP_DEPENDENCY_INDEX_FEED_DIR;
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveHours(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type FeedStaleness = "fresh" | "soft" | "hard";

export type FeedRead =
  /** No feed dir configured, or no feed file in it. NOT an error and NOT an empty feed — the caller
   *  reports `not_configured`, which is the air-gap default. */
  | { status: "absent" }
  /** A file is there and cannot be trusted: unreadable, not JSON, wrong schema version, malformed
   *  entries. Fail-closed — never silently treated as empty, which would be indistinguishable from
   *  "this coordinate has no versions". */
  | { status: "unreadable"; detail: string }
  | {
      status: "present";
      document: DependencyIndexFeedDocument;
      ageHours: number;
      staleness: FeedStaleness;
      softMaxAgeHours: number;
      hardMaxAgeHours: number;
    };

/**
 * Parse and VALIDATE a feed document. Throws on anything it cannot fully understand.
 *
 * Strict on purpose, and this is the same argument `@scp/dependency-manifests`'s parsers make for
 * themselves: "this feed lists no versions for X" and "I could not read this feed" produce identical
 * downstream behaviour (no bump) and mean opposite things. A tolerant parser that dropped malformed
 * entries would turn a corrupted transfer into a silently smaller feed, and the estate would look
 * up to date on every coordinate that fell out.
 */
export function parseDependencyIndexFeed(text: string): DependencyIndexFeedDocument {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `dependency version feed is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const d = doc as Partial<DependencyIndexFeedDocument> | null;
  if (!d || typeof d !== "object") throw new Error("dependency version feed is not an object");
  if (d.schemaVersion !== 1) {
    throw new Error(
      `dependency version feed schemaVersion ${String(d.schemaVersion)} is not readable by this ` +
        `build (expected 1) — refusing rather than best-effort parsing`
    );
  }
  if (typeof d.generatedAt !== "string" || Number.isNaN(new Date(d.generatedAt).getTime())) {
    throw new Error("dependency version feed has no parseable generatedAt");
  }
  if (!Array.isArray(d.entries)) throw new Error("dependency version feed has no entries array");
  const entries: DependencyIndexFeedEntry[] = [];
  for (const raw of d.entries) {
    const entry = raw as Partial<DependencyIndexFeedEntry> | null;
    if (
      !entry ||
      typeof entry.ecosystem !== "string" ||
      typeof entry.coordinate !== "string" ||
      entry.coordinate.length === 0 ||
      !Array.isArray(entry.versions) ||
      entry.versions.some((v) => typeof v !== "string")
    ) {
      // `boundText`, NOT `.slice(0, 120)` (HIGH class, M23.0 verification pass 8). This message
      // reaches a DATABASE ROW: `readDependencyIndexFeed` turns the throw into
      // `FeedRead.detail` -> `unavailableOutcome(...).detail` -> `decisionFor`'s `reasonTree.detail`
      // -> a `Decision`'s jsonb. A slice at a UTF-16 CODE-UNIT offset can land inside a surrogate
      // pair, and `jsonb` refuses an ill-formed string. `JSON.stringify` escapes lone surrogates
      // and NUL to ASCII, so the ONLY way through is a well-formed astral pair straddling the cut —
      // and that is reachable: measured, a `coordinate` of 86 characters followed by an emoji makes
      // `.slice(0, 120)` ill-formed. A malformed feed entry would then take the poll's Decision
      // with it instead of being reported.
      throw new Error(
        `dependency version feed carries a malformed entry (${boundText(JSON.stringify(raw), 120, 0)})`
      );
    }
    entries.push({
      ecosystem: entry.ecosystem as DependencyIndexEcosystem,
      coordinate: entry.coordinate,
      versions: entry.versions
    });
  }
  return { schemaVersion: 1, generatedAt: d.generatedAt, entries };
}

/**
 * Read + staleness-classify the installed feed. Synchronous and cheap: the poll reads it ONCE per
 * tick and hands the result down, so this is a single small file read per day, not per dependency.
 */
export function readDependencyIndexFeed(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): FeedRead {
  const dir = dependencyIndexFeedDir(env);
  if (!dir) return { status: "absent" };
  const path = join(dir, DEPENDENCY_INDEX_FEED_FILE);
  if (!existsSync(path)) return { status: "absent" };
  let document: DependencyIndexFeedDocument;
  try {
    document = parseDependencyIndexFeed(readFileSync(path, "utf8"));
  } catch (err) {
    return { status: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  const softMaxAgeHours = positiveHours(
    env.SCP_DEPENDENCY_INDEX_FEED_SOFT_MAX_AGE_HOURS,
    DEFAULT_FEED_SOFT_MAX_AGE_HOURS
  );
  const hardMaxAgeHours = positiveHours(
    env.SCP_DEPENDENCY_INDEX_FEED_HARD_MAX_AGE_HOURS,
    DEFAULT_FEED_HARD_MAX_AGE_HOURS
  );
  const ageHours = (now.getTime() - new Date(document.generatedAt).getTime()) / 3_600_000;
  // A feed stamped in the FUTURE is treated as fresh rather than refused: clock skew across a CDS
  // is ordinary, and the failure direction of refusing here would be an estate that stops polling
  // because one machine's clock ran ahead. The hard bound is what protects against old data.
  const staleness: FeedStaleness =
    ageHours > hardMaxAgeHours ? "hard" : ageHours > softMaxAgeHours ? "soft" : "fresh";
  return { status: "present", document, ageHours, staleness, softMaxAgeHours, hardMaxAgeHours };
}

/**
 * The versions this feed carries for one coordinate, or `null` when it carries the coordinate not
 * at all.
 *
 * `null` VERSUS `[]` IS THE WHOLE POINT, and it is the same distinction `ManifestParseError` draws:
 * an empty array is "the connected side looked and this package has published nothing", while `null`
 * is "nobody looked" — which the caller reports as unavailable rather than as up-to-date.
 *
 * Comparison is VERBATIM (`===`), never normalised: `graph/urn.ts`'s slug would collapse
 * `@acme/lib`, `acme/lib` and `acme-lib` into one key, so a normalising lookup could answer one
 * package's question with another package's versions.
 */
export function lookupFeedVersions(
  document: DependencyIndexFeedDocument,
  ecosystem: DependencyIndexEcosystem,
  coordinate: string
): string[] | null {
  for (const entry of document.entries) {
    if (entry.ecosystem === ecosystem && entry.coordinate === coordinate) return entry.versions;
  }
  return null;
}

/**
 * Serialize a feed at the CONNECTED side — the bytes an operator then `cosign sign-blob`s and
 * carries across the CDS.
 *
 * Keys are emitted in a fixed order and entries are sorted on their natural key, so re-generating a
 * feed over an unchanged estate produces BYTE-IDENTICAL output. That is not cosmetic: it lets an
 * operator diff two feeds, and it means a re-signed feed with no changes has the same digest.
 */
export function buildDependencyIndexFeed(
  entries: readonly DependencyIndexFeedEntry[],
  generatedAt: Date = new Date()
): string {
  const sorted = [...entries].sort((a, b) =>
    a.ecosystem === b.ecosystem
      ? a.coordinate < b.coordinate
        ? -1
        : a.coordinate > b.coordinate
          ? 1
          : 0
      : a.ecosystem < b.ecosystem
        ? -1
        : 1
  );
  const document: DependencyIndexFeedDocument = {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    entries: sorted.map((entry) => ({
      ecosystem: entry.ecosystem,
      coordinate: entry.coordinate,
      versions: [...entry.versions]
    }))
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface LoadDependencyIndexFeedInput {
  feedDir: string;
  blobPath: string;
  signaturePath: string;
  publicKeyPath: string;
  /** Optional cross-check on top of the signature — the operator's stated digest for the bytes. */
  expectedDigest?: string;
}

function normalizeSha256(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  const hex = value.startsWith("sha256:") ? value.slice(7) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? `sha256:${hex}` : null;
}

/**
 * AIR-GAP OPERATOR-LOAD — verify a cosign-signed feed, then install it. `loadScanDbBlob`'s shape,
 * clause for clause.
 *
 * ORDER IS THE SECURITY PROPERTY: digest cross-check, then signature verification, then PARSE, and
 * only then the atomic install. Nothing is written until all three pass, so a tampered, wrongly
 * signed, or malformed feed leaves the previously installed one untouched — a failed load must never
 * be able to empty the feed, because an empty feed would make every coordinate look unlisted while
 * looking like a successful operation.
 */
export async function loadDependencyIndexFeedBlob(
  input: LoadDependencyIndexFeedInput
): Promise<DependencyIndexFeedDocument> {
  for (const [label, path] of [
    ["feed", input.blobPath],
    ["signature", input.signaturePath],
    ["public key", input.publicKeyPath]
  ] as const) {
    if (!existsSync(path)) throw new Error(`dependency feed load: ${label} '${path}' not found`);
  }

  const bytes = await readFile(input.blobPath);
  if (input.expectedDigest) {
    const want = normalizeSha256(input.expectedDigest);
    if (!want) {
      throw new Error(
        `dependency feed load: expectedDigest '${input.expectedDigest}' is not a sha256 digest`
      );
    }
    const got = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (got !== want) {
      throw new Error(
        `dependency feed load: blob hashes to ${got} but expected ${want} — refusing (no install)`
      );
    }
  }

  const verdict = verifyBlobDetached(input.blobPath, input.signaturePath, input.publicKeyPath);
  if (!verdict.ok) {
    throw new Error(
      `dependency feed load: cosign detached-signature verification FAILED — refusing (no install): ${verdict.detail}`
    );
  }

  // Parsed BEFORE installing: a signed-but-malformed feed is still a feed this build cannot read,
  // and installing it would replace a good one with an `unreadable` state.
  const document = parseDependencyIndexFeed(bytes.toString("utf8"));

  await mkdir(input.feedDir, { recursive: true });
  const target = join(input.feedDir, DEPENDENCY_INDEX_FEED_FILE);
  const staging = `${target}.staging`;
  try {
    await writeFile(staging, bytes);
    // `rename` within one directory is atomic on every platform this runs on, so a reader either
    // sees the whole old feed or the whole new one — never a half-written file. Same move
    // `scan-db.ts`'s `atomicInstallDb` makes.
    await rename(staging, target);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
  await writeFile(
    join(input.feedDir, SOURCE_SIDECAR),
    `${JSON.stringify(
      {
        source: "operator-loaded",
        loadedAt: new Date().toISOString(),
        generatedAt: document.generatedAt,
        entries: document.entries.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      },
      null,
      2
    )}\n`
  );
  return document;
}
