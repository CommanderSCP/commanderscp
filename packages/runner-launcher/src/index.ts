import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { debuglog, promisify } from "node:util";
import type {
  KubernetesRunnerIo,
  KubernetesRunnerPodConventions,
  KubernetesWorkspaceVolume
} from "./kubernetes-adapter.js";

const execFileAsync = promisify(execFile);

// THE ONE PROCESS SPAWNER, AND THE LEDGER THAT MAKES "NOTHING WAS SPAWNED" AN ASSERTION
/** No plugin spawns a Docker CLI on the Kubernetes path. See docs/runner-launcher.md §43. */
export interface RunnerSpawnRecord {
  /** The binary as it was passed to `execFile` — a rename shows up here and nowhere else. */
  readonly file: string;
  /** `argv[0]`: a container-CLI subcommand for every call this package makes. */
  readonly verb: string;
  readonly argvLength: number;
}

/** How many records the ledger keeps. Ring-bounded; {@link runnerSpawnCount} is exact regardless. */
export const RUNNER_SPAWN_LEDGER_MAX = 200;

const spawnLedger: RunnerSpawnRecord[] = [];
let spawnTotal = 0;

/** Every process this package has spawned, most recent last, capped at {@link RUNNER_SPAWN_LEDGER_MAX}. */
export function runnerSpawns(): readonly RunnerSpawnRecord[] {
  return spawnLedger;
}

/** Total spawns since process start — exact, and unaffected by the ledger's cap. */
export function runnerSpawnCount(): number {
  return spawnTotal;
}

/** Clears the ledger (not the total). For a test that wants a clean window; harmless in production. */
export function clearRunnerSpawns(): void {
  spawnLedger.length = 0;
}

/** THE ONLY PLACE THIS PACKAGE STARTS A PROCESS. See docs/runner-launcher.md §44. */
function spawnRunnerProcess(
  file: string,
  argv: readonly string[],
  options: { timeout?: number; maxBuffer?: number }
): Promise<{ stdout: string; stderr: string }> {
  spawnTotal += 1;
  spawnLedger.push({ file, verb: argv[0] ?? "", argvLength: argv.length });
  if (spawnLedger.length > RUNNER_SPAWN_LEDGER_MAX) spawnLedger.shift();
  return execFileAsync(file, [...argv], options);
}

/** `NODE_DEBUG=scp-runner-launcher` to see swallowed teardown/reap failures. Both are best-effort
 *  by design (see {@link RunnerLauncher.reap} and the teardown `.catch`), so this is the only trace
 *  of them that exists — a swallow with nowhere for the reason to go is invisible, not handled. */
const debug = debuglog("scp-runner-launcher");

/** The one place a managed runner is launched. See docs/runner-launcher.md §45. */

// ==================================================================================================
// THE TENANT-SETTABLE RUN BUDGET — its floor, its default-bearing ceiling, and why a ceiling exists.
// ==================================================================================================

/** The bounds a tenant-settable timeout must lie within. See docs/runner-launcher.md §46. */
export const MANAGED_RUN_TIMEOUT_MIN_MS = 1_000;
/** See {@link MANAGED_RUN_TIMEOUT_MIN_MS}. One hour. */
export const MANAGED_RUN_TIMEOUT_MAX_MS = 60 * 60_000;

/** The ceiling, applied where every consumer converges. See docs/runner-launcher.md §47. */
export function clampRunTimeoutMs(requested: number): number {
  if (!Number.isFinite(requested)) return MANAGED_RUN_TIMEOUT_MAX_MS;
  return Math.min(requested, MANAGED_RUN_TIMEOUT_MAX_MS);
}

/** One `docker cp` of a host directory's CONTENTS into the container (the trailing `/.`). */
export interface RunnerCopyIn {
  /** HOST directory. Its contents are copied, not the directory itself. */
  hostDir: string;
  containerPath: string;
}

/** Whether the evidence copy-out runs after a FAILED start. See docs/runner-launcher.md §48. */
export type RunnerCopyOutWhen = "always" | "on-success";

/** Where a FAILED copy-out lands. - `"swallow"`. See docs/runner-launcher.md §49. */
export type RunnerCopyOutOnFailure = "swallow" | "propagate";

/** One `docker cp` of a container directory's CONTENTS back out to the host. */
export interface RunnerCopyOut {
  /** Absolute source path INSIDE the container. Its contents are copied (the trailing `/.`). */
  containerPath: string;
  hostDir: string;
  when: RunnerCopyOutWhen;
  onFailure: RunnerCopyOutOnFailure;
}

/** One runner launch, described completely — nothing about it is defaulted by the adapter. */
export interface RunnerSpec {
  /** THE CALLER'S OWN NAME FOR THIS RUN. See docs/runner-launcher.md §50. */
  runId: string;
  /** Attribution labels, emitted in insertion order. See docs/runner-launcher.md §51. */
  labels: Record<string, string>;
  /** The vetted, pinned runner image. SERVER-GOVERNED at every caller; never tenant-suppliable. */
  image: string;
  /** The runner's own entrypoint operands, in order, AFTER the image on the command line. */
  operands: string[];
  /** The network the runner gets. See docs/runner-launcher.md §52. */
  networkMode: string;
  /** Ordered environment entries that are not secret. See docs/runner-launcher.md §53. */
  env: string[];
  /** Ordered environment entries that carry a secret. See docs/runner-launcher.md §54. */
  secretEnv: string[];
  /** Where the adapter may stage the transient env file. See docs/runner-launcher.md §55. */
  secretEnvDir?: string;
  /** Copy-INs, in the order they must be issued (managed-scan issues one to three). */
  copyIn: RunnerCopyIn[];
  /** The single evidence copy-OUT, if this runner produces one. */
  copyOut?: RunnerCopyOut;
  /** THE WHOLE-RUN BUDGET. See docs/runner-launcher.md §56. */
  timeoutMs: number;
  /** Per-call `maxBuffer`. 16 MiB / 32 MiB / 8 MiB respectively — NOT one shared default. */
  maxBuffer: number;
}

/** What a runner run produced. See docs/runner-launcher.md §57. */
export type RunnerResult =
  | { succeeded: true; stdout: string; stderr: string; failure?: undefined }
  | { succeeded: false; stdout: string; stderr: string; failure: RunnerFailure };

/** The port: one verb, because a runner has one lifecycle. See docs/runner-launcher.md §58. */
export interface RunnerLauncher {
  run(spec: RunnerSpec): Promise<RunnerResult>;
  /** Containment hygiene for the remaining window. See docs/runner-launcher.md §59. */
  reap(secretEnvDir?: string): Promise<string[]>;
}

/** The adapter-selecting slice of a plugin's. See docs/runner-launcher.md §60. */
export interface RunnerLauncherConfig {
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Defaults to `"docker"`. */
  dockerBinary?: string;
  /** WHICH ADAPTER (M23.2). See docs/runner-launcher.md §61. */
  runnerLauncher?: "docker" | "kubernetes";
  /** The Kubernetes adapter's deployment settings. See docs/runner-launcher.md §62. */
  kubernetes?: KubernetesLauncherSettings;
}

/** The Kubernetes adapter's server-injected settings. See docs/runner-launcher.md §63. */
export interface KubernetesLauncherSettings {
  /** The namespace every Job, Secret and pod read lives in. */
  namespace: string;
  /** Where THIS process sees the shared RWX workspace volume the Job also mounts. */
  workspaceRoot: string;
  /** The volume the Job mounts. A CLOSED UNION — see `KubernetesWorkspaceVolume`. */
  workspaceVolume: KubernetesWorkspaceVolume;
  /** THE PER-RUN SECRET CAPABILITY — declared, and OFF until the RBAC grant is an owner decision.
   *  See `KubernetesRunnerLauncherConfig.perRunSecrets` for what is inert and what turns it on. */
  perRunSecrets?: boolean;
  /** Pod `securityContext.runAsNonRoot`. Off by default — none of the three runner images has a
   *  `USER` line, so `true` makes every managed run fail before its entrypoint. */
  runAsNonRoot?: boolean;
  /** THE DEPLOYMENT'S POD CONVENTIONS (M23.5) — the block that carries what every OTHER pod this
   *  chart creates inherits from `.Values` and this one, built at runtime rather than rendered by
   *  Helm, inherited nothing of. See {@link KubernetesRunnerPodConventions}. */
  pod?: KubernetesRunnerPodConventions;
  apiBase?: string;
  /** THE HARNESS's SEAM, and it is `undefined` in production by construction: nothing injects it
   *  from config, so a deployment cannot supply one. The kind-based integration test builds a real
   *  `fetch`-backed io against a real API server and passes it here rather than reaching around the
   *  resolver — which is what makes that test exercise the SHIPPED selection path. */
  io?: KubernetesRunnerIo;
}

/** How a plugin obtains the launcher for one run. See docs/runner-launcher.md §64. */
export type ResolveRunnerLauncher = (config: RunnerLauncherConfig) => RunnerLauncher;

// PER-RUN IDENTITY — the caller's name for the run, and the container name derived from it.

/** What a {@link RunnerSpec.runId} must look like. See docs/runner-launcher.md §65. */
export const RUNNER_RUN_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The container-name prefix every managed runner carries, on every adapter. */
export const RUNNER_CONTAINER_NAME_PREFIX = "scp-runner-";

/** Turn a caller's own run key. See docs/runner-launcher.md §66. */
export function toRunnerRunId(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === raw && slug.length > 0 && slug.length <= 40) return slug;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 10);
  return slug.length > 0 ? `${slug.slice(0, 29).replace(/-+$/, "")}-${digest}` : digest;
}

/** The container's name. See docs/runner-launcher.md §67. */
export function runnerContainerName(runId: string): string {
  return `${RUNNER_CONTAINER_NAME_PREFIX}${runId}`;
}

// THE ERROR — nothing leaves this package carrying a secret or a raw argv.

/** Which part of the launch failed. A superset of the five lifecycle steps; see `RunnerStepKind`. */
export type RunnerLaunchStep =
  "spec" | "secret-env" | "create" | "copy-in" | "start" | "copy-out" | "teardown";

/** The marker a redacted value is replaced with — the same one managed-iac's evidence redaction uses. */
export const RUNNER_REDACTION = "***";

/** Plain split/join, never a regex: a secret value may contain regex metacharacters. */
function redactAll(text: string, needles: readonly string[]): string {
  let out = text;
  for (const needle of needles) {
    if (needle.length === 0) continue;
    out = out.split(needle).join(RUNNER_REDACTION);
  }
  return out;
}

/** The VALUE half of a `KEY=VALUE` entry — what has to disappear from any text we hand upward. */
function valueOf(entry: string): string {
  const eq = entry.indexOf("=");
  return eq === -1 ? "" : entry.slice(eq + 1);
}

/** Every rejection out of a launch, with redacted argv. See docs/runner-launcher.md §68. */
export class RunnerLaunchError extends Error {
  readonly step: RunnerLaunchStep;
  /** The container CLI that was exec'd (`""` when the failure is not an exec). */
  readonly file: string;
  /** The argv, REDACTED — secret values and the `--env-file` path replaced. */
  readonly argv: readonly string[];
  /** `err.code` as Node produced it: `null`, an errno string, or a numeric exit status. */
  readonly code: string | number | null | undefined;
  readonly killed: boolean | undefined;
  readonly signal: string | null | undefined;
  /** The child's stdout, REDACTED (`""` when it produced none). */
  readonly stdout: string;
  /** The child's stderr, REDACTED — falling back to the original error's message. */
  readonly stderr: string;
  /** TRUE when this rejection is the WHOLE-RUN budget. See docs/runner-launcher.md §69. */
  readonly deadlineExceeded: boolean;

  constructor(args: {
    step: RunnerLaunchStep;
    file: string;
    argv: readonly string[];
    cause: unknown;
    redactions: readonly string[];
    deadlineExceeded?: boolean;
  }) {
    const e = (args.cause ?? {}) as {
      message?: string;
      code?: string | number | null;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    const redact = (text: string): string => redactAll(text, args.redactions);
    const argv = args.argv.map(redact);
    const causeMessage = redact(typeof e.message === "string" ? e.message : String(args.cause));
    super(
      `managed runner ${args.step} failed: ${redact(args.file)} ${argv.join(" ")} — ${causeMessage}`
    );
    this.name = "RunnerLaunchError";
    this.step = args.step;
    this.file = redact(args.file);
    this.argv = argv;
    this.code = e.code;
    this.killed = e.killed;
    this.signal = e.signal;
    // THE `?? ""` / `?? message` FALLS, MOVED HERE UNCHANGED. `promisify(execFile)` attaches both to
    // every rejection it produces, so in production these never fire; they remain the adapter's only
    // defence against a rejection that did not come from `promisify(execFile)` at all.
    this.stdout = redact(typeof e.stdout === "string" ? e.stdout : "");
    this.stderr = redact(
      typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : ""
    );
    this.deadlineExceeded = args.deadlineExceeded === true;
  }
}

// THE DIAGNOSIS AN OPERATOR READS — four ways to fail that used to be one empty string.

/** `code` on a maxBuffer overflow. See docs/runner-launcher.md §70. */
export const RUNNER_MAXBUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/** How a run failed, at operator granularity. See docs/runner-launcher.md §71. */
export type RunnerFailureKind =
  | "budget-exhausted"
  | "output-exceeded"
  | "signalled"
  | "spawn-failed"
  | "exit-nonzero"
  | "outcome-unknown";

/** The code that makes a failure outcome-unknown. See docs/runner-launcher.md §72. */
export const RUNNER_OUTCOME_UNKNOWN_CODE = "ERR_SCP_RUNNER_OUTCOME_UNKNOWN";

/** THE `code` A RUN CARRIES WHEN NOTHING EVER STARTED. See docs/runner-launcher.md §73. */
export const RUNNER_NEVER_STARTED_CODE = "RunnerContainerNeverStarted";

// THE ONE BOUND, CHOSEN ONCE, HERE — and it keeps BOTH ENDS.

/** The total budget for any operator-facing detail here. See docs/runner-launcher.md §74. */
export const RUNNER_DETAIL_MAX_CHARS = 4_000;

/** HOW MUCH OF A BOUNDED DETAIL'S END IS SACRED. See docs/runner-launcher.md §75. */
export const RUNNER_DETAIL_TAIL_CHARS = 2_000;

/** A detail provably within the maximum, by construction. See docs/runner-launcher.md §76. */
declare const BOUNDED_DETAIL: unique symbol;
export type BoundedDetail = string & { readonly [BOUNDED_DETAIL]: "bounded" };

/** Marks where characters were removed, and says how many rather than leaving a reader to wonder
 *  whether the runner simply stopped there. */
function elisionMarker(dropped: number): string {
  return ` …[${dropped} characters elided]… `;
}

/** Written as an escape, deliberately, here and in the pattern below. A LITERAL NUL byte in a
 *  tracked source file is invisible to every recursive search this repository runs (CLAUDE.md:
 *  `grep -rna`, `pnpm nul-census`) — a sanitiser nobody can grep for is the next place a census
 *  misses. `REPLACEMENT` is U+FFFD. */
const REPLACEMENT = "\uFFFD";

/** The two code points Postgres refuses to store. See docs/runner-launcher.md §77. */
const NOT_PERSISTABLE = new RegExp(
  [
    // U+0000. `jsonb` refuses it outright; `text` refuses the byte. See the table above.
    "\\u0000",
    // A high surrogate with no low surrogate after it — what a HEAD cut leaves behind.
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    // A low surrogate with no high surrogate before it — what a TAIL cut leaves behind.
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]"
  ].join("|"),
  "g"
);

function persistableText(text: string): string {
  // Every alternative above matches EXACTLY ONE code unit (the lookarounds are zero-width), so this
  // replacement preserves `.length`. The elision arithmetic in `boundDetail` depends on that.
  return text.replace(NOT_PERSISTABLE, REPLACEMENT);
}

/** BOUND A DETAIL, KEEPING BOTH ENDS. See docs/runner-launcher.md §78. */
export function boundDetail(text: string): BoundedDetail {
  return boundText(text, RUNNER_DETAIL_MAX_CHARS, RUNNER_DETAIL_TAIL_CHARS) as BoundedDetail;
}

/** THE SAME BOUND AT AN ARBITRARY WIDTH. See docs/runner-launcher.md §79. */
export function boundText(text: string, max: number, tailChars: number): string {
  return boundTextWithLoss(text, max, tailChars).text;
}

/** Bounded text, plus how many characters it removed. See docs/runner-launcher.md §80. */
function boundTextWithLoss(
  text: string,
  max: number,
  tailChars: number
): { text: string; dropped: number } {
  if (max <= 0) return { text: "", dropped: text.length };
  if (text.length <= max) return { text: persistableText(text), dropped: 0 };
  // `elisionMarker(text.length)` is the longest the marker can be (the count only shrinks), so
  // sizing the head against it guarantees the result fits even before the real count is known.
  const widest = elisionMarker(text.length);
  if (max <= widest.length + 2) {
    // Too narrow to carry both ends AND an honest count. Keep the END: for a runner failure, a
    // provider refusal or an exception message, the diagnosis is what the last characters hold.
    return { text: persistableText(text.slice(text.length - max)), dropped: text.length - max };
  }
  const tail = Math.min(tailChars, max - widest.length - 1);
  const headShare = Math.max(0, max - tail - widest.length);
  const dropped = text.length - headShare - tail;
  // The elision count stays arithmetically honest through sanitising precisely because
  // `persistableText` is length-preserving: `keptHead + dropped + keptTail === text.length` still.
  return {
    text: persistableText(
      text.slice(0, headShare) + elisionMarker(dropped) + text.slice(text.length - tail)
    ),
    dropped
  };
}

/** The total budget for one plugin-supplied structure. See docs/runner-launcher.md §81. */
export const PERSISTED_JSON_MAX_CHARS = 8_000;

/** How deep a structure may nest before a marker replaces. See docs/runner-launcher.md §82. */
export const PERSISTED_JSON_MAX_DEPTH = 8;

/** A CEILING ON WHAT AN OBJECT KEY MAY RENDER TO. See docs/runner-launcher.md §83. */
const PERSISTED_JSON_MAX_KEY_CHARS = 128;

/** Never start a field with less budget left than this. See docs/runner-launcher.md §84. */
const PERSISTED_JSON_MIN_LEAF = 96;

/** The key an over-budget object carries instead of the fields that did not fit. Exported so a
 *  test — or an operator's query — can find rows that were elided, rather than having to guess
 *  from a suspiciously short value. */
export const PERSISTED_JSON_ELIDED_KEY = "__scpElided";

/** THE ONE KEY THIS FILE REFUSES TO WRITE. See docs/runner-launcher.md §85. */
function isUnsafePersistedKey(key: string): boolean {
  return key === "__proto__";
}

/** WHAT THE BOUND REMOVED, AS DATA. See docs/runner-launcher.md §86. */
export interface PersistedJsonFieldTruncation {
  /** The field is absent, and that is our doing. See docs/runner-launcher.md §87. */
  dropped: boolean;
  /** Characters removed from strings anywhere inside this field's subtree. */
  droppedCharacters?: number;
  /** Array entries removed from arrays anywhere inside this field's subtree. */
  droppedEntries?: number;
  /** Object fields removed from objects anywhere inside this field's subtree — including the field
   *  itself when `dropped` is true's siblings did the same. Their NAMES are gone below the root:
   *  the walk replaces them with {@link PERSISTED_JSON_ELIDED_KEY} and a count. */
  droppedFields?: number;
}

/** Keyed by the ROOT FIELD of the bounded value. See docs/runner-launcher.md §88. */
export type PersistedJsonTruncation = Record<string, PersistedJsonFieldTruncation>;

/** {@link boundPersistedJson}'s result: what will be stored, and what storing it cost. */
export interface BoundedPersistedJson {
  value: unknown;
  /** Undefined when the value came back with everything it arrived with. */
  truncation?: PersistedJsonTruncation;
}

/** HOW WIDE THE REPORT ITSELF MAY BE. See docs/runner-launcher.md §89. */
export const PERSISTED_JSON_TRUNCATION_MAX_CHARS = 288;

/** WHAT `null` COSTS. See docs/runner-launcher.md §90. */
const NULL_RENDERED_CHARS = 4;

/** WHAT AN ARRAY HOLDS BACK FOR ITS OWN TAIL MARKER. See docs/runner-launcher.md §91. */
/** The entry an over-budget ARRAY carries in place of its dropped tail. One function, so the marker
 *  and its recogniser below cannot drift apart. */
function entriesElisionMarker(dropped: number): string {
  return `[elided: ${dropped} more entries]`;
}

function tailMarkerCost(length: number): number {
  // `entriesElisionMarker(length)` is the WIDEST this marker can be — the count only shrinks as
  // entries are kept — so the reserve is exact before the real count is known. Same idiom, and the
  // same reason, as {@link boundText} sizing its head against `elisionMarker(text.length)`.
  return jsonCost(entriesElisionMarker(length)) + 1; // + the comma that separates it from the tail
}

/** The value an over-budget OBJECT stores under {@link PERSISTED_JSON_ELIDED_KEY} in place of the
 *  fields that did not fit. One function, beside the array's, so the two markers and the two
 *  reserves that pay for them cannot drift apart. */
function fieldsElisionMarker(dropped: number): string {
  return `${dropped} more fields`;
}

/** WHAT AN OBJECT HOLDS BACK FOR ITS OWN ELISION ENTRY. See docs/runner-launcher.md §92. */
function fieldsElisionCost(fields: number): number {
  // The widest it can be: the count only shrinks as keys are seated. `+ 2` is the `:` and the comma
  // that attach the entry to the object — the two characters phase 1 charged and never reserved.
  return jsonCost(fieldsElisionMarker(fields)) + jsonCost(PERSISTED_JSON_ELIDED_KEY) + 2;
}

/** DOES THIS ARRAY ENTRY MEAN "THE LIST WAS CUT HERE"? See docs/runner-launcher.md §93. */
export function isPersistedJsonEntriesElision(value: string): boolean {
  return /^\[elided: \d+ more entries\]$/.test(value);
}

/** What the walk would spend, measured up to the cap. See docs/runner-launcher.md §94. */
function renderedCostAtMost(value: unknown, cap: number, depth: number): number {
  const over = cap + 1;
  // A negative cap is reachable and its answer unobservable. See docs/runner-launcher.md §95.
  if (cap < 0) return over;
  // `walk` charges these BEFORE its depth check, so this must too.
  if (value === null || value === undefined) return NULL_RENDERED_CHARS;
  switch (typeof value) {
    case "string":
      // `.length` first: rendering is never cheaper than one character per code unit, so this
      // rejects a 500 000-character plugin string without `JSON.stringify` ever touching it.
      // `persistableText` is length-preserving but NOT cost-preserving — a NUL becomes U+FFFD,
      // which renders as one character where the NUL rendered as six.
      return value.length > cap ? over : jsonCost(persistableText(value));
    case "number":
      return Number.isFinite(value) ? String(value).length : NULL_RENDERED_CHARS;
    case "boolean":
      return value ? 4 : 5;
    case "object":
      break;
    default:
      // `bigint` goes through the STRING path in `walk` and is not worth predicting; a function or
      // a symbol renders as `null` in both positions it can occupy — {@link NULL_RENDERED_CHARS}.
      return typeof value === "bigint" ? over : NULL_RENDERED_CHARS;
  }
  // At the depth limit `walk` stores a marker instead of the subtree, whatever the subtree costs.
  // Reporting "more than `cap`" makes the caller fall back to the flat reservation, which is the
  // conservative direction; predicting the marker's own width here would be an under-estimate for
  // any subtree cheaper than it.
  if (depth >= PERSISTED_JSON_MAX_DEPTH) return over;

  if (Array.isArray(value)) {
    let total = 2;
    for (let i = 0; i < value.length; i++) {
      if (i > 0) total += 1;
      if (total > cap) return over;
      total += renderedCostAtMost(value[i], cap - total, depth + 1);
      if (total > cap) return over;
    }
    return total;
  }

  let total = 2;
  let first = true;
  for (const [rawKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue === undefined) continue;
    // AND SO DOES `walk` FOR THIS ONE, for a different reason — see {@link isUnsafePersistedKey}.
    // The estimate mirrors the walk branch for branch or a field is admitted for less than it
    // costs; here the drift would be the other way (an over-estimate), but "the other way" is how
    // a mirror stops being checkable.
    if (isUnsafePersistedKey(rawKey)) continue;
    // A key past the cap is bounded rather than stored whole, so its cost is not predictable from
    // the key itself; fall back rather than guess.
    if (rawKey.length > PERSISTED_JSON_MAX_KEY_CHARS) return over;
    total += jsonCost(persistableText(rawKey)) + 1 + (first ? 0 : 1);
    first = false;
    if (total > cap) return over;
    total += renderedCostAtMost(entryValue, cap - total, depth + 1);
    if (total > cap) return over;
  }
  return total;
}

/** THE LEAST BUDGET THAT ADMITTING `value` CAN REQUIRE. See docs/runner-launcher.md §96. */
function admissionCost(value: unknown, depth: number): number {
  return Math.min(
    PERSISTED_JSON_MIN_LEAF,
    renderedCostAtMost(value, PERSISTED_JSON_MIN_LEAF, depth)
  );
}

/** WHAT ONE FIELD OF AN OBJECT MAY SPEND. See docs/runner-launcher.md §97. */
const PERSISTED_JSON_SHARE_ROUNDS = 5;

/** Walks an object's fields under the water-filling rule. See docs/runner-launcher.md §98. */
/** AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED. See docs/runner-launcher.md §99. */
function walkObjectFields(
  entries: [string, unknown][],
  budget: WalkBudget,
  depth: number,
  /** Whether `walk` already measured this object as fitting whole in the budget it was handed. An
   *  object that fits cannot elide, so it must not be charged for an elision entry — the same
   *  question, asked for the same reason, as the array's `wholeCost <= room`. */
  fitsWhole: boolean
): Record<string, unknown> {
  /** Seated fields in insertion order. `raw` is kept because phase 2 walks each field more than
   *  once — at a larger share each time — and needs the original to walk. */
  const seated: {
    key: string;
    raw: unknown;
    value: unknown;
    spent: number;
    need: number;
    /** What bounding the KEY cost. Charged once, before any value is walked, and therefore kept
     *  separately from the value's loss — which is REPLACED on every re-walk. */
    keyDropped: number;
    /** WHAT THIS FIELD LOST, replaced (never accumulated) on every re-walk — phase 2 walks a field
     *  more than once and only the LAST walk's value is stored, so only the last walk's loss is
     *  true. Accumulating instead would report a field cut two or three times over, and a re-walk
     *  is the NORMAL case here: the water-filling loop exists to run it. */
    loss: WalkLoss;
  }[] = [];
  let elidedMarker: string | undefined;
  /** Root-level attribution only — see {@link WalkBudget.fields}. Below the root the names are not
   *  addressable from the API and the losses roll up into the root field that contains them. */
  const collector = depth === 0 ? budget.fields : undefined;
  /** Root fields phase 1 refused outright. Their names are the ONLY place "we cut `rollout`" and
   *  "the executor reported no rollout" stop being the same bytes, and the stored value cannot
   *  carry them: `__scpElided` is a COUNT, deliberately, because the names would be plugin-chosen
   *  text competing with the reading for the column. */
  let refusedKeys: string[] | undefined;
  /** The sum of what the already-seated fields need — {@link admissionCost} each, NOT a flat
   *  {@link PERSISTED_JSON_MIN_LEAF} each. A field whose whole value is `60` reserves two
   *  characters, and the difference is a key that stays. */
  let reserved = 0;
  // THE ELISION ENTRY IS BOUGHT BEFORE A KEY IS SEATED — see {@link fieldsElisionCost}. Held for
  // the whole of phase 1 and handed back at exactly one of two places: to the marker, or to the
  // pool if every key seated. Clamped at what there is, which matters only for a root handed less
  // than the marker costs — the one container `boundPersistedJson`'s own reserve covers.
  const elisionReserve = fitsWhole
    ? 0
    : Math.min(Math.max(0, budget.left), fieldsElisionCost(entries.length));
  budget.left -= elisionReserve;

  // ---- PHASE 1: SEAT THE KEYS. Charge the keys and NOTHING ELSE, so the pool phase 2 divides is
  // a number that does not depend on the order the fields arrived in.
  for (let i = 0; i < entries.length; i++) {
    const [rawKey, entryValue] = entries[i]!;
    if (entryValue === undefined) continue;
    const boundedKey = boundStringToCost(
      rawKey,
      Math.min(budget.left, PERSISTED_JSON_MAX_KEY_CHARS)
    );
    const key = boundedKey.text;
    if (isUnsafePersistedKey(key)) {
      // REFUSED FOR SAFETY, NOT FOR ROOM. See docs/runner-launcher.md §100.
      budget.loss.fields += 1;
      collector?.set(key, { dropped: true });
      continue;
    }
    const keyCost = jsonCost(key) + 1 + (seated.length > 0 ? 1 : 0);
    // Every seated field must still get what it needs. See docs/runner-launcher.md §101.
    const need = admissionCost(entryValue, depth + 1);
    if (budget.left - keyCost < reserved + need) {
      elidedMarker = fieldsElisionMarker(entries.length - i);
      // THE RESERVE, SPENT ON WHAT IT WAS BOUGHT FOR. See docs/runner-launcher.md §102.
      budget.left += elisionReserve;
      budget.left -= fieldsElisionCost(entries.length - i);
      // THE SAME NUMBER THE MARKER CARRIES, for the same reason the array's does.
      budget.loss.fields += entries.length - i;
      if (collector) {
        // Bounded like any other plugin-chosen string that becomes a row — this one lands in the
        // report rather than in the value, but it is the same untrusted text.
        refusedKeys = entries
          .slice(i)
          .filter(([, refusedValue]) => refusedValue !== undefined)
          .map(([refusedKey]) => boundText(refusedKey, PERSISTED_JSON_MAX_KEY_CHARS, 0));
      }
      break;
    }
    budget.left -= keyCost;
    reserved += need;
    seated.push({
      key,
      raw: entryValue,
      value: undefined,
      spent: 0,
      need,
      keyDropped: boundedKey.dropped,
      loss: { characters: boundedKey.dropped, entries: 0, fields: 0 }
    });
  }

  // No cut: the reserve was never needed, and it goes to the fields rather than being burned — the
  // array's `budget.left += tailReserve` on the same branch, for the same reason.
  if (elidedMarker === undefined) budget.left += elisionReserve;

  // ---- PHASE 2: WATER-FILL THE VALUES. `pool` is what the fields in `pending` have to divide;
  // a field that finishes under its share is taken out and only its ACTUAL spend leaves the pool.
  let pool = budget.left;
  let pending = seated.map((_, index) => index);
  for (let round = 0; round < PERSISTED_JSON_SHARE_ROUNDS && pending.length > 0; round++) {
    // Never negative in round 0: phase 1 seats a key only while `admissionCost` per seated field
    // still fits. A later round can drive it to 0 for a pathological object, and 0 is a legal
    // share — the field stores a marker rather than nothing at all.
    const share = Math.max(0, Math.floor(pool / pending.length));
    const stillPending: number[] = [];
    let satisfiedSpend = 0;
    for (const index of pending) {
      const field = seated[index]!;
      // AT LEAST WHAT PHASE 1 RESERVED FOR IT — HIGH, M23.0 verification pass 13, and the
      // half of pass 12's fix that pass 12 did not carry through. See the block above
      // {@link walkObjectFields} under "AND PHASE 2 MUST HONOUR WHAT PHASE 1 RESERVED".
      const offered = Math.max(share, field.need);
      // A FRESH LOSS ACCUMULATOR PER ATTEMPT, at every depth. Sharing the parent's would double
      // count a field re-walked at a larger share — and a re-walk is the NORMAL case here, not a
      // pathological one: the water-filling loop exists to run it. The winning attempt's loss
      // replaces the previous one below.
      const sub: WalkBudget = { left: offered, loss: emptyLoss() };
      field.value = walk(field.raw, sub, depth + 1);
      field.loss = { characters: field.keyDropped, entries: 0, fields: 0 };
      addLoss(field.loss, sub.loss);
      // Charge what was ACTUALLY spent, not the share. `sub.left` may go slightly negative when a
      // leaf overshoots its own share; the difference keeps the accounting exact either way, which
      // is what the measured check in `boundPersistedJson` is the backstop for.
      field.spent = offered - sub.left;
      if (sub.clipped === true) stillPending.push(index);
      else satisfiedSpend += field.spent;
    }
    // Everyone still wants more: an equal split of everything there is IS the end state, and
    // another round would hand out the same shares again.
    if (stillPending.length === pending.length) break;
    pool -= satisfiedSpend;
    pending = stillPending;
  }
  // Whatever is still pending holds its last share's spend; everything else is already out of the
  // pool. What remains is genuinely unspent and goes back to the parent.
  for (const index of pending) pool -= seated[index]!.spent;
  budget.left = pool;

  // TELL THE PARENT whether this subtree would use more budget, AFTER redistribution rather than
  // during phase 1 — a field that phase 2 satisfied is not a reason for the parent to re-walk us.
  if (pending.length > 0 || elidedMarker !== undefined) budget.clipped = true;

  // ROLL THE FIELDS' LOSSES UP so an ancestor's accumulator (and, at the root, the "was anything
  // cut at all" test) sees them. The key-bounding loss seeded above rides along.
  for (const field of seated) addLoss(budget.loss, field.loss);
  if (collector) {
    for (const field of seated) {
      if (isLossy(field.loss)) collector.set(field.key, truncationOf(field.loss, false));
    }
    for (const refused of refusedKeys ?? []) collector.set(refused, { dropped: true });
  }

  const out: Record<string, unknown> = {};
  // Both assignment forms are the same here, and both safe. See docs/runner-launcher.md §103.
  for (const field of seated) out[field.key] = field.value;
  if (elidedMarker !== undefined) out[PERSISTED_JSON_ELIDED_KEY] = elidedMarker;
  return out;
}

/** Exactly what `JSON.stringify` will spend on this leaf, escapes included — the accounting has to
 *  be in RENDERED characters, because that is the unit the column is measured in. A string of
 *  backslashes doubles; a C0 control sextuples. */
function jsonCost(value: string | number | boolean): number {
  return JSON.stringify(value).length;
}

/** BOUND `text` SO ITS RENDERED COST FITS `left`. See docs/runner-launcher.md §104. */
function boundStringToCost(text: string, left: number): { text: string; dropped: number } {
  const widest = Math.min(RUNNER_DETAIL_MAX_CHARS, left);
  if (widest <= 0) return { text: "", dropped: text.length };
  const whole = boundTextWithLoss(text, widest, Math.floor(widest / 2));
  if (jsonCost(whole.text) <= left) return whole;

  // Bisect [0, widest) for the largest width whose RENDERED cost fits. `best` stays "" only when
  // not even the empty string fits — `left < 2` — which the row-level measurement in
  // `boundPersistedJson` is the backstop for. Its `dropped` is the WHOLE string, which is the truth
  // in that case and is what the truncation report must say.
  let best = { text: "", dropped: text.length };
  let lo = 0;
  let hi = widest - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = boundTextWithLoss(text, mid, Math.floor(mid / 2));
    if (jsonCost(candidate.text) <= left) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** The walk's budget, plus what allows redistribution. See docs/runner-launcher.md §105. */
type WalkBudget = {
  left: number;
  clipped?: boolean;
  /** What this sub-walk removed, in actionable units. See docs/runner-launcher.md §106. */
  loss: WalkLoss;
  /** Root-level attribution, carried by the root budget. See docs/runner-launcher.md §107. */
  fields?: Map<string, PersistedJsonFieldTruncation>;
};

/** What one sub-walk removed. Three units because they are three different facts to a reader: a
 *  shortened string, a cut list, and a key that is not there at all. */
type WalkLoss = { characters: number; entries: number; fields: number };

function emptyLoss(): WalkLoss {
  return { characters: 0, entries: 0, fields: 0 };
}

function addLoss(into: WalkLoss, from: WalkLoss): void {
  into.characters += from.characters;
  into.entries += from.entries;
  into.fields += from.fields;
}

function isLossy(loss: WalkLoss): boolean {
  return loss.characters > 0 || loss.entries > 0 || loss.fields > 0;
}

function truncationOf(loss: WalkLoss, dropped: boolean): PersistedJsonFieldTruncation {
  const entry: PersistedJsonFieldTruncation = { dropped };
  if (loss.characters > 0) entry.droppedCharacters = loss.characters;
  if (loss.entries > 0) entry.droppedEntries = loss.entries;
  if (loss.fields > 0) entry.droppedFields = loss.fields;
  return entry;
}

function walk(value: unknown, budget: WalkBudget, depth: number): unknown {
  if (value === null || value === undefined) {
    // FOUR CHARACTERS, CHARGED — see {@link NULL_RENDERED_CHARS}. Reached only from an ARRAY
    // element (an object's `undefined` field is dropped by `walkObjectFields` phase 1 before it
    // gets here, and a top-level one is short-circuited by `boundPersistedJson`), and
    // `JSON.stringify` renders an `undefined` array element as `null` exactly like a real one.
    budget.left -= NULL_RENDERED_CHARS;
    return value;
  }

  switch (typeof value) {
    case "string": {
      const bounded = boundStringToCost(value, budget.left);
      // `clipped` and `loss` are set on DIFFERENT conditions and that is deliberate. Sanitising a
      // NUL changes the text without removing anything (`bounded.text !== value`, `dropped === 0`),
      // and more budget would not bring it back — so it must not schedule a redistribution round
      // and must not be reported as truncation. See {@link WalkBudget}.
      if (bounded.text !== value) budget.clipped = true;
      budget.loss.characters += bounded.dropped;
      budget.left -= jsonCost(bounded.text);
      return bounded.text;
    }
    case "number": {
      // A non-finite number is `null` to `JSON.stringify` anyway; making that explicit means the
      // accounting below is the truth rather than an approximation of it.
      if (!Number.isFinite(value)) {
        budget.left -= NULL_RENDERED_CHARS;
        return null;
      }
      budget.left -= String(value).length;
      return value;
    }
    case "boolean":
      budget.left -= value ? 4 : 5;
      return value;
    case "bigint": {
      // `JSON.stringify` THROWS on a bigint. A plugin's JSON-RPC response cannot carry one today,
      // but this function's contract is "any value", and a throw here is the stall this whole file
      // exists to prevent.
      const rendered = String(value);
      const bounded = boundStringToCost(rendered, budget.left);
      if (bounded.text !== rendered) budget.clipped = true;
      budget.loss.characters += bounded.dropped;
      budget.left -= jsonCost(bounded.text);
      return bounded.text;
    }
    case "object":
      break;
    default:
      // function / symbol — `JSON.stringify` drops these; be explicit rather than lucky. The
      // explicit `null` is four rendered characters in BOTH positions this can occupy (an array
      // element, and an object field this function has already returned a value for), so it is
      // charged like one — see {@link NULL_RENDERED_CHARS}.
      budget.left -= NULL_RENDERED_CHARS;
      return null;
  }

  if (depth >= PERSISTED_JSON_MAX_DEPTH) {
    // NOT a budget clip — see {@link WalkBudget}. No amount of extra budget brings this subtree
    // back, so marking it would only cost a redistribution round.
    const marker = "[elided: nesting deeper than the persisted-JSON depth limit]";
    budget.left -= jsonCost(marker);
    // REPORTED EVEN THOUGH IT IS NOT A BUDGET CLIP. `clipped` says "more budget would keep more"
    // and this one is false for it; the truncation report answers a different question — "is what
    // the reader sees the whole of what the executor said" — and here it is not. Counted in the
    // unit of whatever was replaced, so a reader is told 40 entries and not "a subtree".
    if (Array.isArray(value)) budget.loss.entries += value.length;
    else budget.loss.fields += Object.keys(value as Record<string, unknown>).length;
    return marker;
  }

  if (Array.isArray(value)) {
    // A list that fits whole is not charged for a marker. See docs/runner-launcher.md §108.
    const room = budget.left;
    const wholeCost = renderedCostAtMost(value, room, depth);
    budget.left -= 2;
    // THE TAIL MARKER IS PAID FOR BEFORE THE ELEMENTS ARE OFFERED ANYTHING — see
    // {@link PERSISTED_JSON_TAIL_RESERVE}. Held back for the whole element loop and handed back
    // either to the marker or, if the list ran to the end, to the parent.
    const tailReserve =
      wholeCost <= room ? 0 : Math.min(Math.max(0, budget.left), tailMarkerCost(value.length));
    budget.left -= tailReserve;
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      // WHAT THIS ELEMENT NEEDS, NOT A FLAT 96 — see {@link renderedCostAtMost}. An element that
      // fits WHOLE is admitted for what it costs, so a list of short entries is not cut with
      // ninety-six characters still unspent; an element too big to price is admitted on exactly the
      // old terms. The comma is part of the price here, which the flat guard never charged for.
      const need = (i > 0 ? 1 : 0) + admissionCost(value[i], depth + 1);
      if (budget.left < need) {
        // Spend-in-order and truncate the TAIL — see {@link PERSISTED_JSON_SHARE_ROUNDS} for why
        // an array is not fair-shared. The marker is recognisable (`isPersistedJsonEntriesElision`)
        // so a reader looking for a specific entry can tell a cut from an absence.
        budget.left += tailReserve;
        const marker = entriesElisionMarker(value.length - i);
        budget.left -= jsonCost(marker) + 1;
        out.push(marker);
        budget.clipped = true;
        // THE SAME NUMBER THE MARKER CARRIES. A reader that has the marker and a reader that has
        // the report must not be told two different things about one cut.
        budget.loss.entries += value.length - i;
        return out;
      }
      if (i > 0) budget.left -= 1;
      out.push(walk(value[i], budget, depth + 1));
    }
    budget.left += tailReserve; // no cut: the reserve was never needed
    return out;
  }

  // AN OBJECT THAT FITS WHOLE IS NOT CHARGED FOR AN ELISION ENTRY IT CANNOT NEED — the array's
  // question, asked one branch over, where pass 11 did not sweep. See {@link fieldsElisionCost}
  // for the measurement and for why an object's overspend compounds where an array's adds.
  const objectRoom = budget.left;
  const objectWholeCost = renderedCostAtMost(value, objectRoom, depth);
  budget.left -= 2;
  // Every field against an equal share, and what is declined. See docs/runner-launcher.md §109.
  return walkObjectFields(
    Object.entries(value as Record<string, unknown>),
    budget,
    depth,
    objectWholeCost <= objectRoom
  );
}

/** BOUND A WHOLE PLUGIN-SUPPLIED VALUE FOR PERSISTENCE. See docs/runner-launcher.md §110. */
export function boundPersistedJson(
  value: unknown,
  maxChars: number = PERSISTED_JSON_MAX_CHARS
): BoundedPersistedJson {
  if (value === null || value === undefined) return { value };
  const fields = new Map<string, PersistedJsonFieldTruncation>();
  const budget: WalkBudget = {
    left: Math.max(0, maxChars) - PERSISTED_JSON_MIN_LEAF,
    loss: emptyLoss(),
    fields
  };
  const bounded = walk(value, budget, 0);
  const rendered = JSON.stringify(bounded);
  if (rendered === undefined || rendered.length <= maxChars) {
    return { value: bounded, truncation: truncationReport(fields, budget.loss) };
  }
  const fallbacks = [
    {
      [PERSISTED_JSON_ELIDED_KEY]: boundDetail(
        `a plugin-supplied value rendered to ${rendered.length} characters after bounding, over the ${maxChars}-character budget, and was not stored verbatim`
      )
    },
    { [PERSISTED_JSON_ELIDED_KEY]: true },
    null
  ];
  for (const fallback of fallbacks) {
    const fallbackRendered = JSON.stringify(fallback);
    if (fallbackRendered !== undefined && fallbackRendered.length <= maxChars) {
      return { value: fallback, truncation: wholesaleTruncation(value) };
    }
  }
  return { value: null, truncation: wholesaleTruncation(value) };
}

/** THE BACKSTOP'S OWN REPORT. See docs/runner-launcher.md §111. */
function wholesaleTruncation(input: unknown): PersistedJsonTruncation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { "": { dropped: true } };
  }
  const entries: [string, PersistedJsonFieldTruncation][] = Object.entries(
    input as Record<string, unknown>
  )
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .map(([key]) => [boundText(key, PERSISTED_JSON_MAX_KEY_CHARS, 0), { dropped: true }]);
  return entries.length === 0 ? { "": { dropped: true } } : boundTruncationReport(entries);
}

/** Turns the walk's accounting into a report, or nothing. See docs/runner-launcher.md §112. */
function truncationReport(
  fields: Map<string, PersistedJsonFieldTruncation>,
  rootLoss: WalkLoss
): PersistedJsonTruncation | undefined {
  if (fields.size > 0) return boundTruncationReport([...fields.entries()]);
  if (isLossy(rootLoss)) return { "": truncationOf(rootLoss, false) };
  return undefined;
}

/** MEASURED, NOT ARGUED. See docs/runner-launcher.md §113. */
function boundTruncationReport(
  all: [string, PersistedJsonFieldTruncation][]
): PersistedJsonTruncation {
  const out: PersistedJsonTruncation = {};
  // A key unsafe to write never enters the report's key space. See docs/runner-launcher.md §114.
  const named = all.filter(([key]) => !isUnsafePersistedKey(key));
  let unnamed = all.length - named.length;
  // The widest the elision entry can be: the count only shrinks as entries are kept, so the reserve
  // is exact before the real count is known — the same idiom as {@link tailMarkerCost}.
  const reserve =
    1 +
    jsonCost(PERSISTED_JSON_ELIDED_KEY) +
    1 +
    JSON.stringify({ dropped: true, droppedFields: all.length }).length;
  let cost = 2;
  for (let i = 0; i < named.length; i++) {
    const [key, entry] = named[i]!;
    const price = (i > 0 ? 1 : 0) + jsonCost(key) + 1 + JSON.stringify(entry).length;
    if (cost + price > PERSISTED_JSON_TRUNCATION_MAX_CHARS - reserve) {
      unnamed += named.length - i;
      break;
    }
    out[key] = entry;
    cost += price;
  }
  if (unnamed > 0) out[PERSISTED_JSON_ELIDED_KEY] = { dropped: true, droppedFields: unnamed };
  return out;
}

/** HOW MANY RUN OUTCOMES A PLUGIN'S CACHE MAY HOLD. See docs/runner-launcher.md §115. */
export const RUN_OUTCOME_CACHE_MAX_DURABLE = 200;

/** See {@link RUN_OUTCOME_CACHE_MAX_DURABLE}. In-memory caches pay O(1) per lookup rather than
 *  re-parsing, and are lost on restart anyway, so they can afford far more history. */
export const RUN_OUTCOME_CACHE_MAX_IN_MEMORY = 1_000;

/** Drops the oldest cache entries down to the maximum. See docs/runner-launcher.md §116. */
export function pruneOutcomeMap<V>(store: Map<string, V>, max: number): number {
  if (max < 0 || store.size <= max) return 0;
  const target = store.size - max;
  let dropped = 0;
  for (const key of store.keys()) {
    if (dropped >= target) break;
    store.delete(key);
    dropped++;
  }
  return dropped;
}

/** The same rule for a plain object. See docs/runner-launcher.md §117. */
export function pruneOutcomeRecord<V>(store: Record<string, V>, max: number): number {
  const keys = Object.keys(store);
  if (max < 0 || keys.length <= max) return 0;
  const doomed = keys.slice(0, keys.length - max);
  for (const key of doomed) delete store[key];
  return doomed.length;
}

/** The classified failure a caller records. See {@link classifyRunnerFailure}. */
export interface RunnerFailure {
  readonly kind: RunnerFailureKind;
  /** ONE REDACTED LINE, NEVER EMPTY AND NEVER UNBOUNDED. See docs/runner-launcher.md §118. */
  readonly detail: BoundedDetail;
  /** Which step failed, so the detail is not the only place the answer lives. */
  readonly step: RunnerLaunchStep;
  /** Node's own `code`, carried across so a caller can branch without re-parsing `detail`. */
  readonly code: string | number | null | undefined;
  readonly signal: string | null | undefined;
  /** Which bound actually ended the run. See docs/runner-launcher.md §119. */
  readonly deadlineExceeded: boolean;
}

/** Human wording per kind. Separate from the enum so the machine-readable name never has to be a
 *  sentence and the sentence never has to be stable. */
const FAILURE_WORDING: Record<RunnerFailureKind, string> = {
  "budget-exhausted": "the whole-run budget ran out and the runner was stopped mid-flight",
  "output-exceeded": "the runner printed more than maxBuffer allows, so its output is TRUNCATED",
  signalled: "the runner was killed by a signal that was not this run's own budget",
  "spawn-failed": "the container CLI could not be executed at all — nothing ran",
  "exit-nonzero": "the runner itself exited non-zero",
  // THE ONE SENTENCE HERE THAT CLAIMS NOTHING ABOUT THE RUNNER, which is its entire job. It is
  // phrased as an INSTRUCTION as well as a statement because the safe next step is the opposite of
  // the one every other kind implies: the other five all end "…so re-run it".
  "outcome-unknown":
    "the launcher never learned what became of the runner — whether it ran, and whether anything " +
    "was mutated, is NOT KNOWN; check the target's real state before re-running"
};

/** Turns a launch error into something actionable. See docs/runner-launcher.md §120. */
/** The longer introducer, whose length is load-bearing. See docs/runner-launcher.md §121. */
const OUTPUT_TAIL_MARKER = " :: runner output (tail): ";

/** How much of the child's own output {@link classifyRunnerFailure} appends. See its doc. */
const FAILURE_OUTPUT_TAIL_CHARS = RUNNER_DETAIL_TAIL_CHARS - OUTPUT_TAIL_MARKER.length;
export function classifyRunnerFailure(err: RunnerLaunchError): RunnerFailure {
  const kind: RunnerFailureKind =
    err.code === RUNNER_OUTCOME_UNKNOWN_CODE
      ? // FIRST, AND BEFORE `deadlineExceeded` — see {@link RUNNER_OUTCOME_UNKNOWN_CODE}. The runs
        // this describes normally end AT the whole-run deadline, so every later test would reach
        // `budget-exhausted` and re-assert the very claim ("stopped mid-flight") the producer has
        // just declared it cannot make. It is also before the errno test, which would otherwise call
        // a STRING code `spawn-failed` — the opposite lie, and the one measured in the field.
        "outcome-unknown"
      : err.code === RUNNER_NEVER_STARTED_CODE
        ? // SECOND, AND FOR THE SAME REASON — see {@link RUNNER_NEVER_STARTED_CODE}. A producer that
          // Nothing-ran normally ends at the deadline too. See docs/runner-launcher.md §122.
          "spawn-failed"
        : err.deadlineExceeded
          ? "budget-exhausted"
          : err.code === RUNNER_MAXBUFFER_CODE
            ? "output-exceeded"
            : err.killed === true
              ? "signalled"
              : typeof err.code === "string"
                ? "spawn-failed"
                : "exit-nonzero";

  const facts = [`code=${err.code === undefined ? "undefined" : String(err.code)}`];
  if (err.signal) facts.push(`signal=${err.signal}`);
  if (err.killed === true) facts.push("killed");

  const head = `${kind}: ${FAILURE_WORDING[kind]} during '${err.step}' (${facts.join(", ")}) — `;

  // stderr when there is any, else stdout: a runner that explains itself on stdout (managed-dep's
  // does) must not be recorded as silent just because it kept stderr clean.
  const output = err.stderr.length > 0 ? err.stderr : err.stdout;
  let suffix: string;
  if (output.length === 0) {
    suffix = " [the runner printed nothing on stdout or stderr]";
  } else if (output.length <= FAILURE_OUTPUT_TAIL_CHARS && err.message.includes(output)) {
    suffix = ""; // already in the message (Node's `Command failed:` format) — do not say it twice
  } else {
    const tail = output.slice(-FAILURE_OUTPUT_TAIL_CHARS);
    suffix =
      tail.length < output.length ? `${OUTPUT_TAIL_MARKER}${tail}` : ` :: runner output: ${tail}`;
  }

  return {
    kind,
    step: err.step,
    code: err.code,
    signal: err.signal,
    deadlineExceeded: err.deadlineExceeded,
    // The tail is last, and the bound keeps the last of it. See docs/runner-launcher.md §123.
    detail: boundDetail(`${head}${err.message}${suffix}`)
  };
}

/** The one string a caller records for a run. See docs/runner-launcher.md §124. */
export function runnerOutcomeDetail(result: RunnerResult): BoundedDetail {
  return result.succeeded ? boundDetail(result.stdout) : result.failure.detail;
}

// THE ONE FAILURE A TEARDOWN MUST NEVER ANSWER — a `create` that lost the NAME to somebody else.

/** Does this rejection mean the name was already taken. See docs/runner-launcher.md §125. */
export function isContainerNameConflict(err: unknown): boolean {
  const e = (err ?? {}) as { stderr?: unknown; message?: unknown };
  const text = `${typeof e.stderr === "string" ? e.stderr : ""}\n${
    typeof e.message === "string" ? e.message : ""
  }`;
  return /already in use/i.test(text);
}

/** Every env file this package writes carries this prefix. See docs/runner-launcher.md §126. */
const SECRET_ENV_FILE_PREFIX = "scp-secret-env-";

/** The transient `--env-file`. See docs/runner-launcher.md §127. */
async function writeSecretEnvFile(
  dir: string,
  runId: string,
  entries: readonly string[]
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SECRET_ENV_FILE_PREFIX}${runId}-${randomUUID()}`);
  await writeFile(path, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

/** The teardown call's own timeout, not the run's. See docs/runner-launcher.md §128. */
export const RUNNER_REMOVE_TIMEOUT_MS = 30_000;

// THE PORT'S OWN DEADLINE — M23.5. THE ENFORCEMENT IS HERE, NOT IN WHOEVER IMPLEMENTS THE ADAPTER.

/** Why this section exists, stated as the measurement. See docs/runner-launcher.md §129. */

/** How long past a step's bound the launcher waits. See docs/runner-launcher.md §130. */
export const RUNNER_STEP_ABANDON_GRACE_MS = 1_000;

/** The smallest remaining budget a step may be issued. See docs/runner-launcher.md §131. */
export const RUNNER_MIN_STEP_BUDGET_MS = 10;

/** `code` on an abandoned step, so a reader can branch without parsing the message. */
export const RUNNER_ABANDONED_CODE = "ERR_SCP_RUNNER_STEP_ABANDONED";

/** Thrown when the work did not honour its bound. See docs/runner-launcher.md §132. */
export class RunnerStepAbandonedError extends Error {
  readonly code = RUNNER_ABANDONED_CODE;
  /** The bound the work was handed and did not honour. */
  readonly boundMs: number;
  constructor(what: string, boundMs: number) {
    super(
      `${what} did not honour its ${boundMs}ms bound and was ABANDONED after a further ` +
        `${RUNNER_STEP_ABANDON_GRACE_MS}ms — the launcher stopped waiting; the underlying I/O may ` +
        `still be in flight`
    );
    this.name = "RunnerStepAbandonedError";
    this.boundMs = boundMs;
  }
}

/** The only way this package awaits anything external. See docs/runner-launcher.md §133. */
export async function withStepBound<T>(args: {
  /** The bound handed to `work`, in ms. Clamped to >= 1: `timeout: 0` is NO timeout in Node. */
  timeoutMs: number;
  /** How the step is named in an abandonment message, e.g. `'copy-in'` or `DELETE job`. */
  what: string;
  work: (timeoutMs: number) => Promise<T>;
}): Promise<T> {
  const bound = Math.max(1, Math.trunc(args.timeoutMs));
  // `async` wrapper so a `work` that throws SYNCHRONOUSLY is a rejection like any other rather than
  // an exception that escapes past the `finally` and leaves the timer armed.
  const pending = (async () => args.work(bound))();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RunnerStepAbandonedError(args.what, bound)),
          bound + RUNNER_STEP_ABANDON_GRACE_MS
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The one clock a run is held to, spent by adapters. See docs/runner-launcher.md §134. */
export interface RunDeadline {
  /** `clampRunTimeoutMs(spec.timeoutMs)` — the budget the run is actually held to. */
  readonly runTimeoutMs: number;
  /** Epoch ms. `Date.now() + runTimeoutMs`, read ONCE. */
  readonly at: number;
  remainingMs(): number;
  /** IS THE BUDGET GONE? See docs/runner-launcher.md §135. */
  spent(): boolean;
  /** REFUSE, BOUND, OR ABANDON. See docs/runner-launcher.md §136. */
  spend<T>(
    step: RunnerLaunchStep,
    argv: readonly string[],
    work: (timeoutMs: number) => Promise<T>
  ): Promise<T>;
}

export function createRunDeadline(args: {
  /** Raw `spec.timeoutMs`; {@link clampRunTimeoutMs} is applied HERE and nowhere else. */
  requestedTimeoutMs: number;
  /** {@link RunnerLaunchError.file} for the refusals this object raises. */
  file: string;
  /** Read late: the Docker adapter's redaction set grows an `--env-file` path mid-run. */
  redactions: () => readonly string[];
}): RunDeadline {
  const runTimeoutMs = clampRunTimeoutMs(args.requestedTimeoutMs);
  const at = Date.now() + runTimeoutMs;
  const iso = new Date(at).toISOString();
  return {
    runTimeoutMs,
    at,
    remainingMs: () => at - Date.now(),
    spent: () => at - Date.now() < RUNNER_MIN_STEP_BUDGET_MS,
    async spend(step, argv, work) {
      const remaining = at - Date.now();
      // BELOW {@link RUNNER_MIN_STEP_BUDGET_MS} IS SPENT, and that is not a rounding convenience —
      // read that constant for why `<= 0` is a boundary this process cannot reliably land on.
      if (remaining < RUNNER_MIN_STEP_BUDGET_MS) {
        throw new RunnerLaunchError({
          step,
          file: args.file,
          argv,
          deadlineExceeded: true,
          cause: new Error(
            `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) was already spent ` +
              `at the run deadline ${iso} — '${step}' was not issued` +
              (remaining > 0
                ? ` (${remaining}ms left, under the ${RUNNER_MIN_STEP_BUDGET_MS}ms below which a ` +
                  `step is a spawn and a SIGTERM rather than a call)`
                : "")
          ),
          redactions: args.redactions()
        });
      }
      try {
        return await withStepBound({ timeoutMs: remaining, what: `'${step}'`, work });
      } catch (cause) {
        if (cause instanceof RunnerStepAbandonedError) {
          throw new RunnerLaunchError({
            step,
            file: args.file,
            argv,
            deadlineExceeded: true,
            cause: new Error(
              `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                `'${step}' at the run deadline ${iso} — ${cause.message}`
            ),
            redactions: args.redactions()
          });
        }
        throw cause;
      }
    }
  };
}

// THE TEARDOWN MODEL — M23.5 HIGH-2. What happens after the deadline, per adapter, as a NUMBER.

/** The adapters this package ships. Also the key of every per-adapter quantity below. */
export type RunnerLauncherKind = "docker" | "kubernetes";

/** Every bounded call allowed after the run deadline. See docs/runner-launcher.md §137. */
export const RUNNER_POST_DEADLINE_CALLS = {
  /** `unlink` of the staged env-file in `create`'s `finally`, then `docker rm -f <name>`. */
  docker: ["secret-env unlink", "teardown rm -f"],
  kubernetes: ["teardown DELETE job", "teardown DELETE secret", "teardown removeDir"]
} as const satisfies Readonly<Record<RunnerLauncherKind, readonly string[]>>;

/** The names `kind` may hand {@link withPostDeadlineBound} — anything else is a compile error, which
 *  is what makes a new post-deadline call impossible to add without moving the model. */
export type RunnerPostDeadlineCall<K extends RunnerLauncherKind> =
  (typeof RUNNER_POST_DEADLINE_CALLS)[K][number];

/** HOW MANY of them, per adapter. DERIVED from {@link RUNNER_POST_DEADLINE_CALLS} and written down
 *  nowhere — the number and the list cannot disagree because there is only the list. */
export const RUNNER_POST_DEADLINE_CALL_COUNT: Readonly<Record<RunnerLauncherKind, number>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(RUNNER_POST_DEADLINE_CALLS).map(([kind, calls]) => [kind, calls.length])
    ) as Record<RunnerLauncherKind, number>
  );

/** The worst case of ONE bounded call made outside the run budget: its own timeout, plus the margin
 *  {@link withStepBound} waits before giving up on work that ignored it. */
export const RUNNER_BOUNDED_CALL_WORST_CASE_MS =
  RUNNER_REMOVE_TIMEOUT_MS + RUNNER_STEP_ABANDON_GRACE_MS;

/** The worst-case wall clock of every bounded call `kind` may issue after the run deadline. */
export function runnerPostDeadlineCallsMs(kind: RunnerLauncherKind): number {
  return RUNNER_POST_DEADLINE_CALL_COUNT[kind] * RUNNER_BOUNDED_CALL_WORST_CASE_MS;
}

/** What a sum of timers costs beyond the arithmetic. See docs/runner-launcher.md §138. */
export const RUNNER_TIMER_LATENCY_ALLOWANCE_MS = 1_000;

/** Everything run may still do past its deadline. See docs/runner-launcher.md §139. */
export function runnerPostDeadlineMs(kind: RunnerLauncherKind): number {
  return (
    RUNNER_STEP_ABANDON_GRACE_MS +
    runnerPostDeadlineCallsMs(kind) +
    RUNNER_TIMER_LATENCY_ALLOWANCE_MS
  );
}

/** The only bounded call not spent from the run budget. See docs/runner-launcher.md §140. */
export async function withPostDeadlineBound<K extends RunnerLauncherKind, T>(args: {
  kind: K;
  /** Which declared call this is. A name not in the list for `kind` does not type-check. */
  call: RunnerPostDeadlineCall<K>;
  /** What it addresses, appended to the abandonment message — a container name, a path. */
  what?: string;
  work: (timeoutMs: number) => Promise<T>;
}): Promise<T> {
  return withStepBound({
    timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
    what: args.what ? `${args.call} ${args.what}` : args.call,
    work: args.work
  });
}

/** The bound a run is held to, for a requested timeout. See docs/runner-launcher.md §141. */
export function runnerRunBoundMs(kind: RunnerLauncherKind, requestedTimeoutMs: number): number {
  return clampRunTimeoutMs(requestedTimeoutMs) + runnerPostDeadlineMs(kind);
}

/** How far clear of its post-deadline work a run stamps. See docs/runner-launcher.md §142. */
export const RUNNER_REAP_HEADROOM_MS = 90_000;

/** The Docker adapter's default CLI. Server-injected in production; this is the unit-test fallback. */
export const DEFAULT_DOCKER_BINARY = "docker";

// THE REAPER'S LABELS AND IDENTITY — M23.1 PHASE 4. See {@link RunnerLauncher.reap} for the defect.

/** The label reap filters the container listing on. See docs/runner-launcher.md §143. */
export const RUNNER_LAUNCHER_OWNER_LABEL = "scp.launcher.owner";
/** RFC3339. See {@link RUNNER_REAP_GRACE_MS} for how the value is computed. */
export const RUNNER_LAUNCHER_DEADLINE_LABEL = "scp.launcher.deadline";

/** How far past its deadline a container's stamp sits. See docs/runner-launcher.md §144. */
export function runnerReapGraceMs(kind: RunnerLauncherKind): number {
  return runnerPostDeadlineMs(kind) + RUNNER_REAP_HEADROOM_MS;
}

/** {@link runnerReapGraceMs} for the DOCKER adapter — the value the Docker stamp and
 *  {@link RUNNER_SECRET_ENV_MAX_AGE_MS} (an `--env-file` is a Docker-only artefact) are built from. */
export const RUNNER_REAP_GRACE_MS = runnerReapGraceMs("docker");

/** THE HARD BOUND ON ONE `reap()` PASS. See docs/runner-launcher.md §145. */
export const RUNNER_REAP_BUDGET_MS = 2 * 60_000;

/** The hard bound on an env file's age before orphaned. See docs/runner-launcher.md §146. */
export const RUNNER_SECRET_ENV_MAX_AGE_MS = MANAGED_RUN_TIMEOUT_MAX_MS + RUNNER_REAP_GRACE_MS;

/** This process's own identity, minted once at load. See docs/runner-launcher.md §147. */
/** EXPORTED FOR THE SECOND ADAPTER (M23.2), not widened for convenience. `reap()`'s cardinal rule is
 *  "never destroy a container you do not own", and ownership is THIS PROCESS's identity — so the
 *  Kubernetes adapter must stamp and compare the SAME id, not a second one. Two ids in one process
 *  would make each adapter treat the other's live objects as foreign and reapable. */
export const LAUNCHER_OWNER_ID = randomUUID();

/** The single-flight slot for the background sweep. See docs/runner-launcher.md §148. */
const reapInFlight = new Map<string, Promise<string[]>>();

/** The sweep in flight for this binary, or a resolved one. See docs/runner-launcher.md §149. */
export function whenReapSettled(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): Promise<readonly string[]> {
  return reapInFlight.get(dockerBinary) ?? Promise.resolve([]);
}

/** THE DOCKER ADAPTER. See docs/runner-launcher.md §150. */
export function createDockerRunnerLauncher(
  dockerBinary: string = DEFAULT_DOCKER_BINARY
): RunnerLauncher {
  /** See {@link RunnerLauncher.reap}. See docs/runner-launcher.md §151. */
  const reapOnce = async (): Promise<string[]> => {
    /** THE PASS's OWN DEADLINE — see {@link RUNNER_REAP_BUDGET_MS}. Bounding the individual calls
     *  bounds nothing when the number of calls is the unbounded term. */
    const passDeadline = Date.now() + RUNNER_REAP_BUDGET_MS;
    let listing: string;
    try {
      // BOUNDED THROUGH THE PORT, like every other call this package makes (M23.5). A `docker ps`
      // against a wedged daemon socket is exactly the shape whose SIGTERM never lands, and a reap
      // pass that never settles is a background promise that never settles — invisible, and it
      // holds the single-flight slot against every later run.
      listing = (
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: "reap `docker ps`",
          work: (timeout) =>
            spawnRunnerProcess(
              dockerBinary,
              [
                "ps",
                "-a",
                "--filter",
                `label=${RUNNER_LAUNCHER_OWNER_LABEL}`,
                "--format",
                `{{.ID}}\t{{.Label "${RUNNER_LAUNCHER_OWNER_LABEL}"}}\t{{.Label "${RUNNER_LAUNCHER_DEADLINE_LABEL}"}}`
              ],
              { timeout }
            )
        })
      ).stdout;
    } catch (cause) {
      debug("reap: listing launcher-owned containers failed, skipping this pass: %O", cause);
      return [];
    }

    const now = Date.now();
    const targets: string[] = [];
    for (const line of listing.split("\n")) {
      if (line.trim().length === 0) continue;
      const [id, owner, deadline] = line.split("\t");
      if (!id || owner === LAUNCHER_OWNER_ID) continue; // never my own — live or not yet torn down
      const deadlineMs = deadline ? Date.parse(deadline) : NaN;
      if (!Number.isFinite(deadlineMs) || deadlineMs > now) continue;
      targets.push(id);
    }

    const removed: string[] = [];
    for (const id of targets) {
      // STOP, DO NOT TRUNCATE THE TIMEOUT. What is left is still expired, still labelled and still
      // findable, so the next pass collects it; a pass that kept going with a 1ms `timeout` would
      // turn every remaining orphan into a kill-and-retry instead of leaving it alone.
      if (Date.now() >= passDeadline) {
        debug(
          "reap: pass budget spent with %d target(s) left, leaving them for the next pass",
          targets.length - removed.length
        );
        break;
      }
      try {
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`docker rm -f ${id}\``,
          work: (timeout) => spawnRunnerProcess(dockerBinary, ["rm", "-f", id], { timeout })
        });
        removed.push(id);
      } catch (cause) {
        debug("reap: rm -f %s failed, leaving it for the next pass: %O", id, cause);
      }
    }
    return removed;
  };

  /** The half of reap that sweeps a leaked env file. See docs/runner-launcher.md §152. */
  const sweepStaleSecretEnvFiles = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      // BOUNDED, LIKE THE CONTAINER HALF OF THE SAME SWEEP (M23.5 census). A `readdir` of a wedged
      // mount never settles, and this pass is `void`ed — so it would hold its promise open forever,
      // invisibly, with nothing ever sweeping a leaked credential file again.
      entries = await withStepBound({
        timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
        what: `reap \`readdir ${dir}\``,
        work: () => readdir(dir)
      });
    } catch (cause) {
      debug("reap: listing secret-env dir %s failed, skipping this pass: %O", dir, cause);
      return;
    }
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith(SECRET_ENV_FILE_PREFIX)) continue; // not ours — never a candidate
      const path = join(dir, name);
      try {
        const info = await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`stat ${path}\``,
          work: () => stat(path)
        });
        // A LIVE run's file is NEVER this old — see {@link RUNNER_SECRET_ENV_MAX_AGE_MS}. An
        // ambiguous or just-created file is left alone, the same fail-closed direction as a
        // missing/garbled container deadline label.
        if (now - info.mtimeMs < RUNNER_SECRET_ENV_MAX_AGE_MS) continue;
        await withStepBound({
          timeoutMs: RUNNER_REMOVE_TIMEOUT_MS,
          what: `reap \`unlink ${path}\``,
          work: () => unlink(path)
        });
        debug("reap: swept stale secret-env file %s (age %dms)", path, now - info.mtimeMs);
      } catch (cause) {
        debug("reap: could not sweep secret-env file %s: %O", path, cause);
      }
    }
  };

  /** Single-flighted per binary, as that slot explains. See docs/runner-launcher.md §153. */
  const reap = async (secretEnvDir?: string): Promise<string[]> => {
    const fileSweep = secretEnvDir
      ? sweepStaleSecretEnvFiles(secretEnvDir).catch((cause) =>
          debug("reap: secret-env sweep of %s rejected: %O", secretEnvDir, cause)
        )
      : undefined;

    const joined = reapInFlight.get(dockerBinary);
    if (joined) {
      if (fileSweep) await fileSweep;
      return joined;
    }
    const pass = (async () => {
      const removed = await reapOnce();
      if (fileSweep) await fileSweep;
      return removed;
    })().finally(() => {
      if (reapInFlight.get(dockerBinary) === pass) reapInFlight.delete(dockerBinary);
    });
    reapInFlight.set(dockerBinary, pass);
    return pass;
  };

  return {
    reap,
    async run(spec: RunnerSpec): Promise<RunnerResult> {
      // SCHEDULED AT THE TOP, BEFORE `create`, AND NOT AWAITED. See docs/runner-launcher.md §154.
      void reap(spec.secretEnvDir).catch((cause) =>
        debug("reap: background pass rejected: %O", cause)
      );

      /** THE WHOLE-RUN DEADLINE. See docs/runner-launcher.md §155. */
      const runDeadline = createRunDeadline({
        requestedTimeoutMs: spec.timeoutMs,
        file: dockerBinary,
        redactions: () => redactions()
      });
      /** `spec.timeoutMs` WITH THE PRODUCT CEILING APPLIED. See docs/runner-launcher.md §156. */
      const runTimeoutMs = runDeadline.runTimeoutMs;
      const runDeadlineAt = runDeadline.at;
      const maxBuffer = spec.maxBuffer;
      const envArgs = spec.env.flatMap((entry) => ["-e", entry]);

      // THE NAME IS KNOWN BEFORE ANYTHING IS ISSUED. Everything about M23.0's defect 1 turns on this
      // line being ABOVE the `try`: the teardown needs an identity that exists even when `create`
      // never answered. See {@link runnerContainerName} for why "move the await inside the try" —
      // this file's own former advice — repairs nothing.
      const containerName = runnerContainerName(spec.runId);
      /** The deadline label's value for this run. See docs/runner-launcher.md §157. */
      const reapDeadline = new Date(runDeadlineAt + RUNNER_REAP_GRACE_MS).toISOString();

      // THE REDACTION SET, and it is complete by construction rather than by inspection: the secret
      // VALUES the caller declared, plus the `--env-file` path once there is one. Read through a
      // closure, so the path joins the set the moment it exists and every later error inherits it.
      const secretValues = spec.secretEnv.map(valueOf).filter((v) => v.length > 0);
      let envFilePath: string | undefined;
      const redactions = (): string[] => [...secretValues, ...(envFilePath ? [envFilePath] : [])];
      const redact = (text: string): string => redactAll(text, redactions());

      /** The only external call, and the only raw escape. See docs/runner-launcher.md §158. */
      const execFixed = async (
        step: RunnerLaunchStep,
        argv: string[],
        call: RunnerPostDeadlineCall<"docker">,
        options: { maxBuffer?: number } = {}
      ): Promise<{ stdout: string; stderr: string }> => {
        try {
          // OUTSIDE THE RUN BUDGET IS NOT OUTSIDE A BOUND. See docs/runner-launcher.md §159.
          return await withPostDeadlineBound({
            kind: "docker",
            call,
            what: `'${step}' (${argv[0] ?? ""})`,
            work: (timeout) => spawnRunnerProcess(dockerBinary, argv, { ...options, timeout })
          });
        } catch (cause) {
          throw new RunnerLaunchError({
            step,
            file: dockerBinary,
            argv,
            cause,
            redactions: redactions()
          });
        }
      };

      /** Every step bounded by what is left of the budget. See docs/runner-launcher.md §160. */
      const exec = async (
        step: RunnerLaunchStep,
        argv: string[],
        options: { maxBuffer?: number }
      ): Promise<{ stdout: string; stderr: string }> => {
        try {
          return await runDeadline.spend(step, argv, (timeout) =>
            spawnRunnerProcess(dockerBinary, argv, { ...options, timeout })
          );
        } catch (cause) {
          // ALREADY THE PORT'S OWN VERDICT — a refusal before the step was issued, or an
          // abandonment of work that ignored its bound. Re-wrapping it here would restate the step
          // and lose the message the port built.
          if (cause instanceof RunnerLaunchError) throw cause;
          // OUR OWN DEADLINE, NOT THE STEP'S FAULT — distinguishable because `promisify(execFile)`
          // sets `killed` only when IT did the killing, and because the clock has by then reached
          // the deadline the `timeout` was derived from.
          const e = cause as {
            message?: string;
            code?: string | number | null;
            killed?: boolean;
            signal?: string | null;
            stdout?: string;
            stderr?: string;
          };
          // THROUGH THE DEADLINE OBJECT, NOT A SECOND EXPRESSION FOR THE SAME INSTANT — see
          // {@link RunDeadline.spent}. `Date.now() >= runDeadlineAt` here reported FALSE for a
          // `create` this adapter's own derived timeout had just killed, because the killing timer
          // and this comparison read different clocks.
          const deadlineExceeded = e.killed === true && runDeadline.spent();
          throw new RunnerLaunchError({
            step,
            file: dockerBinary,
            argv,
            // THE MESSAGE IS REPLACED, THE DIAGNOSIS IS NOT. See docs/runner-launcher.md §161.
            cause: deadlineExceeded
              ? {
                  ...e,
                  message:
                    `whole-run budget of ${runTimeoutMs}ms (RunnerSpec.timeoutMs) ran out during ` +
                    `'${step}' at the run deadline ${new Date(runDeadlineAt).toISOString()}`
                }
              : cause,
            redactions: redactions(),
            deadlineExceeded
          });
        }
      };

      // 0. REFUSE A SPEC THAT WOULD PRODUCE AN AMBIGUOUS COMMAND LINE, before a container exists.
      //    Never sanitise: a silently-corrected runId is how two runs come to share one container,
      //    and a newline inside an `--env-file` value is how one entry becomes two.
      const refuse = (why: string): never => {
        throw new RunnerLaunchError({
          step: "spec",
          file: "",
          argv: [],
          cause: new Error(why),
          redactions: redactions()
        });
      };
      if (!RUNNER_RUN_ID_PATTERN.test(spec.runId)) {
        refuse(
          `runId '${spec.runId}' is not DNS-safe (${String(RUNNER_RUN_ID_PATTERN)}) — build it with toRunnerRunId()`
        );
      }
      for (const [key, value] of Object.entries(spec.labels)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || /[\r\n]/.test(value)) {
          refuse(`label '${key}' is not a usable Docker/Kubernetes label`);
        }
      }
      for (const entry of spec.secretEnv) {
        // A `\n` in an env-file value silently DEFINES ANOTHER VARIABLE, which is an injection into
        // the runner's environment from whatever produced the secret.
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry) || /[\r\n]/.test(entry)) {
          refuse(
            `secretEnv entry '${entry.split("=")[0] ?? ""}=…' is not a single-line KEY=VALUE pair`
          );
        }
      }
      for (const entry of spec.env) {
        // The plain environment had no check at all. See docs/runner-launcher.md §162.
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry)) {
          refuse(`env entry '${entry.split("=")[0] ?? ""}=…' is not a KEY=VALUE pair`);
        }
      }

      // 1. STAGE THE SECRETS OFF THE COMMAND LINE (M23.0 defect 3). Before the `try`, so a failure
      //    here tears nothing down — no container has been asked for yet.
      if (spec.secretEnv.length > 0) {
        if (!spec.secretEnvDir) {
          refuse("secretEnv was supplied without secretEnvDir — refusing to choose a directory");
        }
        try {
          // THROUGH THE ONE DEADLINE, LIKE EVERY OTHER STEP. See docs/runner-launcher.md §163.
          envFilePath = await runDeadline.spend("secret-env", [], () =>
            writeSecretEnvFile(spec.secretEnvDir!, spec.runId, spec.secretEnv)
          );
        } catch (cause) {
          if (cause instanceof RunnerLaunchError) throw cause;
          throw new RunnerLaunchError({
            step: "secret-env",
            file: "",
            argv: [],
            cause,
            redactions: redactions()
          });
        }
      }

      /** DID `create` LOSE THE NAME TO SOMEBODY ELSE? See docs/runner-launcher.md §164. */
      let createNameConflict = false;

      try {
        // Create, not run: it exists but has not started. See docs/runner-launcher.md §165.
        let createOut: string;
        try {
          createOut = (
            await exec(
              "create",
              [
                "create",
                "--network",
                spec.networkMode,
                "--name",
                containerName,
                ...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
                // THE REAPER'S OWN TWO LABELS (M23.1 phase 4) — always present, on every container
                // this adapter ever creates, never conditional on the caller's own `spec.labels`.
                "--label",
                `${RUNNER_LAUNCHER_OWNER_LABEL}=${LAUNCHER_OWNER_ID}`,
                "--label",
                `${RUNNER_LAUNCHER_DEADLINE_LABEL}=${reapDeadline}`,
                ...(envFilePath ? ["--env-file", envFilePath] : []),
                ...envArgs,
                spec.image,
                ...spec.operands
              ],
              { maxBuffer }
            )
          ).stdout;
        } catch (cause) {
          // THE ONE CREATE FAILURE THAT MUST NOT BE FOLLOWED BY A TEARDOWN. Recorded, then
          // rethrown unchanged — the caller's error is the same `RunnerLaunchError` it always was;
          // only what the `finally` does about it changes.
          createNameConflict = isContainerNameConflict(cause);
          throw cause;
        } finally {
          // Unlinked the instant create returns, either way. See docs/runner-launcher.md §166.
          if (envFilePath) {
            const doomed = envFilePath;
            await withPostDeadlineBound({
              kind: "docker",
              call: "secret-env unlink",
              work: () => unlink(doomed)
            }).catch(() => undefined);
          }
        }
        // TWO IDENTITIES, ON PURPOSE. The steps that only run AFTER a successful `create` address
        // the id the daemon returned — the precise handle, and what every golden records. Teardown
        // addresses the NAME, because it is the only identity that exists on the path where `create`
        // is the thing that failed.
        const containerId = createOut.trim();

        // 3. COPY IN — the caller's directories' CONTENTS, in the caller's order.
        for (const copy of spec.copyIn) {
          await exec(
            "copy-in",
            ["cp", `${copy.hostDir}/.`, `${containerId}:${copy.containerPath}`],
            { maxBuffer }
          );
        }

        // 4. START attached — blocks until the container exits and propagates its exit code, so a
        //    non-zero runner rejects here and is CAPTURED rather than thrown.
        let succeeded: boolean;
        let stdout: string;
        let stderr: string;
        /** Set exactly when `succeeded` is false — see {@link RunnerResult} for why that is a type
         *  invariant here rather than a convention. */
        let failure: RunnerFailure | undefined;
        try {
          const r = await exec("start", ["start", "-a", containerId], { maxBuffer });
          succeeded = true;
          stdout = redact(r.stdout);
          stderr = redact(r.stderr);
        } catch (err) {
          // Already redacted, fallbacks already applied. See docs/runner-launcher.md §167.
          const e = err as RunnerLaunchError;
          succeeded = false;
          stdout = e.stdout;
          stderr = e.stderr;
          failure = classifyRunnerFailure(e);
        }

        // 5. COPY OUT — conditionally, and guarded or not, exactly as the caller asked. Both axes
        //    differ between the three callers and both are load-bearing.
        const copyOut = spec.copyOut;
        if (copyOut && (copyOut.when === "always" || succeeded)) {
          const pending = exec(
            "copy-out",
            ["cp", `${containerId}:${copyOut.containerPath}/.`, copyOut.hostDir],
            { maxBuffer }
          );
          if (copyOut.onFailure === "swallow") {
            await pending.catch(() => undefined);
          } else {
            await pending;
          }
        }

        // THE UNION IS REBUILT EXPLICITLY rather than spread from the three locals: `failure` is
        // present exactly when `succeeded` is false, and writing that out is what lets the compiler
        // hold callers to it (see {@link RunnerResult}).
        return succeeded
          ? { succeeded: true, stdout, stderr }
          : { succeeded: false, stdout, stderr, failure: failure! };
      } finally {
        // 6. Destroy the container unconditionally. See docs/runner-launcher.md §168.
        if (createNameConflict) {
          debug(
            "teardown: SKIPPED for %s — create lost the name to a container this run does not own",
            containerName
          );
        } else {
          await execFixed("teardown", ["rm", "-f", containerName], "teardown rm -f").catch(
            (cause) => {
              debug("teardown: rm -f %s failed: %O", containerName, cause);
            }
          );
        }
      }
    }
  };
}

/** The default resolver every managed executor uses today. See docs/runner-launcher.md §169. */
export const resolveDockerRunnerLauncher: ResolveRunnerLauncher = (config) =>
  createDockerRunnerLauncher(config.dockerBinary ?? DEFAULT_DOCKER_BINARY);

// Recorded outcomes: every path out of trigger records one. See docs/runner-launcher.md §170.

/** How a plugin writes one terminal outcome to its store. See docs/runner-launcher.md §171. */
export type RecordOutcome = (succeeded: boolean, detail: BoundedDetail) => void | Promise<void>;

/** The fix for a path out of trigger that records nothing. See docs/runner-launcher.md §172. */
export async function withRecordedOutcome<T>(
  opts: { record: RecordOutcome; redact: (text: string) => string },
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The message suffices for one adapter, not the other. See docs/runner-launcher.md §173.
    const stderr = err instanceof RunnerLaunchError ? err.stderr : "";
    const detail =
      stderr.length > 0 && !message.includes(stderr) ? `${message} :: ${stderr}` : message;
    // BOUNDED BEFORE `record` EVER SEES IT. See docs/runner-launcher.md §174.
    await opts.record(false, boundDetail(opts.redact(detail)));
    return undefined;
  }
}

// THE SECOND ADAPTER. See docs/runner-launcher.md §175.
export {
  ADVERSARIAL_ALL,
  ADVERSARIAL_ALPHABETS,
  ADVERSARIAL_PERSISTED_JSON
} from "./adversarial-corpus.js";
export {
  KUBERNETES_JOB_TTL_SECONDS,
  KUBERNETES_MERGES_STDERR_INTO_STDOUT,
  KUBERNETES_POLL_INTERVAL_MS,
  K8S_SA_DIR,
  RUNNER_CONTAINER_NAME,
  RUNNER_LAUNCHER_DEADLINE_ANNOTATION,
  RUNNER_NETWORK_LABEL,
  RUNNER_RUN_ID_LABEL,
  RUNNER_WORKSPACE_VOLUME_NAME,
  createDefaultKubernetesIo,
  createFetchKubernetesIo,
  createKubernetesRunnerLauncher,
  isKubernetesAlreadyExists,
  isKubernetesLabelValue,
  jobManifest,
  kubernetesContainerStarted,
  kubernetesConstructionCount,
  kubernetesJobTermination,
  kubernetesRbacKey,
  kubernetesRbacRequirement,
  kubernetesRunnerRbac,
  kubernetesStartVerdict,
  kubernetesTermination,
  kubernetesWaitingEvidence,
  resolveRunnerLauncher,
  runnerJobName,
  runnerSecretName,
  shortDigest,
  whenKubernetesReapSettled,
  workspaceSlots
} from "./kubernetes-adapter.js";
export type {
  KubernetesApiRequest,
  KubernetesRbacRule,
  KubernetesApiResponse,
  KubernetesStartFacts,
  KubernetesRunnerIo,
  KubernetesRunnerLauncherConfig,
  KubernetesRunnerPodConventions,
  KubernetesWorkspaceVolume
} from "./kubernetes-adapter.js";
