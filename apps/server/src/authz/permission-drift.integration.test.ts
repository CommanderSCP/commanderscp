import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "./resolve.js";
import { buildTestServer, testDatabaseUrl, type TestServer } from "../test-support/harness.js";

/**
 * ================================================================================================
 * THE PERMISSION DRIFT GATE — role-model.md §5 step 4
 * ================================================================================================
 *
 * THREE POPULATIONS THAT MUST AGREE, and until this file existed nothing compared any two of them:
 *
 *   1. **What the code DEFINES** — `authz/resolve.ts`'s {@link PERMISSIONS}.
 *   2. **What the database GRANTS** — the `permissions` array on every built-in (`org_id IS NULL`)
 *      role, as the migrations actually left it.
 *   3. **What the code DEMANDS** — the permission literals appearing at call sites.
 *
 * THE FAILURE THIS EXISTS TO CATCH IS NOT HYPOTHETICAL. `org:admin` was defined in (1), granted to
 * Owner by drizzle/0002 in (2), and demanded at ZERO call sites in (3) — for its entire life. It
 * advertised authority in a roles listing and gated nothing. It was found because a human ran a
 * census by hand in 2026-08, which is not a control. Every population was internally consistent;
 * the defect was only ever visible BETWEEN them.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS IS AN INTEGRATION TEST, AND WHY THE SEEDED HALF IS READ FROM A DATABASE
 * ------------------------------------------------------------------------------------------------
 * The obvious cheap version greps the migration SQL for permission literals. It was written, run,
 * and is wrong — measured on this repo, that census returns `org:admin` (a string drizzle/0099
 * REMOVES, so grepping the text reports the opposite of the truth), plus `scp:managed-by` and
 * `scp:stack`, which are governance LABEL KEYS and not permissions at all. Migrations are a
 * sequence of edits, and the only thing that knows their composition is a database that has run
 * them. So this test runs them and reads `roles`.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THE CALL-SITE CENSUS READS BYTES INSTEAD OF SHELLING OUT TO grep
 * ------------------------------------------------------------------------------------------------
 * CLAUDE.md's standing hazard: some tracked source files contain literal NUL bytes (NUL is a
 * composite-key delimiter here and is correct), every search tool classifies those files as binary,
 * and a recursive search DROPS them with no output and exit 0/1 — indistinguishable from "no such
 * code exists". A census whose blind spot is invisible is worse than no census. `readFileSync`
 * has no such notion: it returns the bytes. This walk is also FILTERLESS by construction — it
 * descends every directory under `src/` and reads every `.ts` file, because a filter is exactly
 * where the next instance hides.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "..");
const DRIZZLE_DIR = path.resolve(HERE, "../../drizzle");

/**
 * A permission this system DEFINES but deliberately grants to NO built-in role.
 *
 * Empty today, and that is the finding rather than an oversight: every one of the 22 permissions is
 * carried by at least one built-in. An entry here must say why the permission exists ungranted —
 * the honest case is one reserved for custom roles (role-model.md §5 step 10), which do not exist.
 */
const UNGRANTED_BY_DESIGN: Readonly<Record<string, string>> = {};

/**
 * A permission this system DEFINES and GRANTS but demands at no call site.
 *
 * Empty today, deliberately and load-bearingly: `org:admin` is the only string that was ever in
 * this state, and drizzle/0099 removed it rather than documenting it. An entry here is a claim
 * that a permission which appears in `GET /roles` — advertising authority to every operator who
 * reads it — gates nothing, and that claim should be hard to make quietly.
 */
const UNGATED_BY_DESIGN: Readonly<Record<string, string>> = {};

/**
 * ================================================================================================
 * THE WIDENING REGISTRY — role-model.md §4.4's assertion, which is not about drift at all
 * ================================================================================================
 *
 * A built-in role row is a SHARED SINGLETON: `org_id IS NULL`, read by every org on the deployment
 * through the `roles` RLS `USING (org_id = current_org OR org_id IS NULL)` clause. So
 * `array_append`ing a permission to one does not widen a role — it widens EVERY EXISTING BINDING OF
 * THAT ROLE, in every org, at once, with no per-org opt-out and no re-check.
 *
 * `authz/role-binding-door.ts` §8 records why that cannot be fixed at the write door: the subset
 * rule is a WRITE-time test with no read-time mirror, so a binding written legitimately today
 * confers whatever its role gains tomorrow. Re-testing at resolve time would put ~20 permission
 * probes on the hot path of every authorization AND make a subject's authority depend on the
 * current authority of whoever granted it years ago. Refusing the migration is worse: appending to
 * a shared singleton is how every permission this system has ever added arrived.
 *
 * So the control is not a refusal, it is a DECLARATION: a migration that changes a built-in's
 * permission array must state, here, which role it changes and what the blast radius is. This
 * registry and the migrations are compared IN BOTH DIRECTIONS below.
 *
 * ⚠️ THE DECLARATIONS LIVE HERE RATHER THAN AS COMMENTS IN THE .sql FILES, and that is forced:
 * `drizzle-orm`'s migrator sha256s each migration's text into `__drizzle_migrations`, so editing an
 * applied file to add a comment changes a recorded hash. Entries below for migrations 0010 through
 * 0094 are BACKFILLED — they document history that predates the rule, and they were read off the
 * migrations rather than remembered.
 */
type Widening = {
  /** The migration file's tag, exactly as `drizzle/_journal.json` carries it. */
  readonly migration: string;
  /** `append` widens every existing binding of the role; `remove` narrows every one of them. */
  readonly kind: "append" | "remove";
  readonly permission: string;
  /** What the blast radius IS — not a restatement of the SQL. */
  readonly blastRadius: string;
};

const DECLARED_WIDENINGS: readonly Widening[] = [
  {
    migration: "0010_governance",
    kind: "append",
    permission: "policy:write",
    blastRadius:
      "Every existing Administrator and Owner binding gains policy authoring at its scope. M4 " +
      "introduced governance; before it, no role could author a policy at all, so this widens " +
      "bindings into a capability that did not previously exist rather than one they were denied."
  },
  {
    migration: "0010_governance",
    kind: "append",
    permission: "freeze:write",
    blastRadius: "Same population as `policy:write` above — Administrator and Owner bindings."
  },
  {
    migration: "0010_governance",
    kind: "append",
    permission: "freeze:override",
    blastRadius:
      "Owner bindings ALONE. The narrowest grant M4 made, and the shape drizzle/0088's " +
      "`campaign:deadline-override` was later modelled on."
  },
  {
    migration: "0010_governance",
    kind: "append",
    permission: "change:emergency",
    blastRadius:
      "Administrator and Owner bindings gain the ability to bypass governance gates on a change. " +
      "The narrowest-consequence of M4's four appends to state and the widest in effect."
  },
  {
    migration: "0012_federation",
    kind: "append",
    permission: "federation:write",
    blastRadius:
      "Administrator and Owner bindings gain authority to OPERATE a federation link. Note what " +
      "this widening turned out to include, measured only in 2026-08: until drizzle/0094 split " +
      "`federation:pair` out, this one string also admitted PAIRING a peer, i.e. deciding whose " +
      "signature the instance believes. A blast radius stated at append time would have said so."
  },
  {
    migration: "0012_federation",
    kind: "append",
    permission: "federation:read",
    blastRadius: "Read-only federation status. Widens Viewer and above."
  },
  {
    migration: "0083_governance_move_rungs",
    kind: "append",
    permission: "governance:move",
    blastRadius:
      "Administrator and Owner bindings only (owner decision Q2-A), deliberately NOT Operator: " +
      "Operator and above all hold `object:write`, so an Operator-and-above grant would have made " +
      "every principal who can move also able to move UNDER enforcement, leaving the lattice inert."
  },
  {
    migration: "0088_campaign_deadline_override_permission",
    kind: "append",
    permission: "campaign:deadline-override",
    blastRadius: "Owner bindings alone — `freeze:override`'s grant shape exactly."
  },
  {
    migration: "0094_federation_pair_permission",
    kind: "append",
    permission: "federation:pair",
    blastRadius:
      "Administrator and Owner bindings. Narrows nothing on the day it lands — it is ADDED beside " +
      "the `federation:write` those roles already held, so no live pairing starts failing — and " +
      "its whole value is being separately withholdable, which is what makes FederationAdmin's " +
      "no-pairing invariant true."
  },
  {
    migration: "0099_rbac_permission_splits_and_purpose_roles",
    kind: "remove",
    permission: "org:admin",
    blastRadius:
      "NARROWS every existing Owner binding on every deployment. Safe because the narrowing is " +
      "provably EMPTY: the permission was demanded at zero call sites for its entire life, a " +
      "property re-measured by filterless census for this migration rather than assumed. This is " +
      "the one deliberate subtraction in an otherwise additive design."
  },
  {
    migration: "0099_rbac_permission_splits_and_purpose_roles",
    kind: "append",
    permission: "secret:write",
    blastRadius:
      "Owner, Administrator and OrgAdmin bindings. The append is not the breaking half — the " +
      "SUBSTITUTION at the three credential doors is: a principal holding org-root `object:write` " +
      "and nothing else is now 403 there. The built-in ladder is unaffected precisely because " +
      "this append covers it; what loses the capability is a custom role holding `object:write` " +
      "alone."
  },
  {
    migration: "0099_rbac_permission_splits_and_purpose_roles",
    kind: "append",
    permission: "scan:override",
    blastRadius:
      "Owner, Administrator and SecurityOfficer bindings. A NO-OP on every live deployment by " +
      "construction: `policy:write` is held today by Administrator and Owner alone (drizzle/0010), " +
      "so every principal who can decide a scan waiver today still can, and no in-flight waiver " +
      "starts 403ing on upgrade."
  },
  {
    migration: "0099_rbac_permission_splits_and_purpose_roles",
    kind: "append",
    permission: "change:accept",
    blastRadius:
      "Owner, Administrator, OrgAdmin, ServiceAdmin and ComponentAdmin bindings — and " +
      "DELIBERATELY NOT Operator or Approver, which hold `object:write` and can accept and roll " +
      "back releases today. Existing Operator and Approver bindings LOSE that capability on " +
      "upgrade. This is the one intentionally breaking grant in the design and must be announced, " +
      "not discovered."
  }
];

/** Every `.ts` file under `src/`, filterless — see the module doc on why this walks rather than greps. */
function everyTypeScriptFile(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyTypeScriptFile(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Parse every statement that mutates a built-in role's `permissions` array out of the migration
 * SQL.
 *
 * DELIBERATELY OVER-BROAD ON THE PATTERN. It matches `array_append`, `array_remove` and `array_cat`
 * on a column named `permissions`, anywhere in the file, including inside a comment. A false
 * positive costs one registry entry; a false negative is a silent widening, which is the entire
 * thing being guarded. Wholesale replacement (`SET permissions = ARRAY[...]`) is matched too —
 * there are none today, and there being none is asserted rather than assumed.
 */
function widenings(
  sql: string,
  tag: string
): Array<{ migration: string; kind: string; permission: string }> {
  const found: Array<{ migration: string; kind: string; permission: string }> = [];
  const fn = /array_(append|remove|cat)\s*\(\s*permissions\s*,\s*'([^']+)'/g;
  for (const m of sql.matchAll(fn)) {
    found.push({
      migration: tag,
      kind: m[1] === "append" ? "append" : m[1] === "remove" ? "remove" : "cat",
      permission: m[2]!
    });
  }
  return found;
}

describe("the permission drift gate (role-model.md §5 step 4)", () => {
  let server: TestServer;
  let admin: pg.Client;
  let builtIns: Array<{ name: string; permissions: string[] }>;

  beforeAll(async () => {
    // Building the server is what runs the migrations against the Testcontainers Postgres.
    server = await buildTestServer();
    // Superuser: `roles`'s RLS never exposes `org_id IS NULL` rows for WRITE, and this test reads
    // the built-in catalogue as the migrations left it rather than as one org sees it.
    admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    const res = await admin.query<{ name: string; permissions: string[] }>(
      "SELECT name, permissions FROM roles WHERE org_id IS NULL ORDER BY name"
    );
    builtIns = res.rows;
  });

  afterAll(async () => {
    await admin?.end();
    await server?.app.close();
  });

  it("the catalogue is non-empty and the fixture actually read the built-ins", () => {
    // A KNOWN-POSITIVE CONTROL. Every assertion below is of the form "no member of set X is missing
    // from set Y", which passes vacuously when X is empty — and X here is read over a database
    // connection that can fail, return zero rows, or be pointed at an unmigrated database. Without
    // this, the whole file is green on a catastrophe.
    expect(builtIns.length).toBeGreaterThanOrEqual(10);
    // `>=` rather than `toBe(22)` DELIBERATELY. An exact count would make every legitimate new
    // permission edit this line, and a number nobody can change without ceremony gets changed
    // without reading it. Removing a permission is not lost either way: a string still seeded on a
    // built-in but no longer defined fails the first comparison below, which is the real control.
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(22);
    // A duplicate member would make the set comparisons below quietly weaker than they read.
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  describe("(1) vs (2) — what the code DEFINES vs what the database GRANTS", () => {
    it("every permission seeded onto a built-in role is one the code defines", () => {
      const defined = new Set<string>(PERMISSIONS);
      const offenders: string[] = [];
      for (const role of builtIns) {
        for (const p of role.permissions) {
          if (!defined.has(p)) offenders.push(`${role.name} holds '${p}'`);
        }
      }
      // This is the direction that catches a migration seeding a typo, or seeding a string the
      // code has since removed. `org:admin` would fail here today had drizzle/0099 removed it from
      // the union without removing it from Owner's array.
      expect(offenders).toEqual([]);
    });

    it("every permission the code defines is granted to at least one built-in role", () => {
      const granted = new Set<string>(builtIns.flatMap((r) => r.permissions));
      const ungranted = PERMISSIONS.filter((p) => !granted.has(p) && !(p in UNGRANTED_BY_DESIGN));
      // The reverse direction: a permission added to the union and to a door, but granted to
      // nobody, is a door no built-in role can open. It reads as a working feature.
      expect(ungranted).toEqual([]);
    });
  });

  describe("(1) vs (3) — what the code DEFINES vs what the code DEMANDS", () => {
    const sources = everyTypeScriptFile(SRC_ROOT)
      .filter((f) => !f.endsWith(".test.ts"))
      // `resolve.ts` is where the catalogue is DECLARED; a declaration is not a demand, and
      // counting it would make every permission trivially "demanded" and this assertion vacuous.
      .filter((f) => f !== path.join(SRC_ROOT, "authz", "resolve.ts"));

    it("the census actually read a substantial body of source (known-positive control)", () => {
      // The NUL hazard's signature is a search that returns nothing and looks like a clean bill of
      // health. Assert the walk found files, and that a permission known to be demanded IS found —
      // if this control ever fails, every assertion below is meaningless rather than passing.
      expect(sources.length).toBeGreaterThan(200);
      const corpus = sources.map((f) => readFileSync(f, "utf8")).join("\n");
      expect(corpus).toContain('"object:write"');
    });

    it("every permission the code defines is demanded at at least one call site", () => {
      const corpus = sources.map((f) => readFileSync(f, "utf8")).join("\n");
      const undemanded = PERMISSIONS.filter(
        (p) => !corpus.includes(`"${p}"`) && !(p in UNGATED_BY_DESIGN)
      );
      // THE `org:admin` ASSERTION. This is the one that would have fired continuously from
      // drizzle/0002 until 2026-08, instead of waiting for somebody to run a census by hand.
      expect(undemanded).toEqual([]);
    });
  });

  describe("(4) the widening registry — a change to a built-in's permissions must state its blast radius", () => {
    const migrationFiles = readdirSync(DRIZZLE_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const inSql = migrationFiles.flatMap((f) =>
      widenings(readFileSync(path.join(DRIZZLE_DIR, f), "utf8"), f.replace(/\.sql$/, ""))
    );

    it("the migration scan actually found the known widenings (known-positive control)", () => {
      expect(migrationFiles.length).toBeGreaterThan(90);
      expect(inSql.length).toBeGreaterThanOrEqual(13);
    });

    it("there is no wholesale replacement of a built-in's permissions array", () => {
      // `SET permissions = ARRAY[...]` would silently rewrite a shared singleton's whole grant, and
      // the append/remove parser above would not see it. There are none; if one ever lands, this
      // fails and the parser needs to grow rather than the assertion being relaxed.
      // CAPTURE THE TOKEN, DO NOT LOOK AHEAD PAST `\s*`. The first version of this used
      // `SET\s+permissions\s*=\s*(?!array_)` and fired on every legitimate `array_append` in the
      // tree — because `\s*` backtracks to match FEWER spaces, putting the lookahead at a position
      // where the next characters are whitespace rather than `array_`, which duly is not `array_`.
      // A negative lookahead behind a variable-width match asserts nothing. Reading the token and
      // comparing it cannot express that bug.
      const offenders: string[] = [];
      for (const f of migrationFiles) {
        const sql = readFileSync(path.join(DRIZZLE_DIR, f), "utf8");
        for (const m of sql.matchAll(/SET\s+permissions\s*=\s*([A-Za-z_[]+)/gi)) {
          const rhs = m[1]!.toLowerCase();
          if (rhs === "permissions" || rhs.startsWith("array_")) continue;
          const at = sql.slice(0, m.index).split("\n").length;
          offenders.push(`${f}:${at} (SET permissions = ${m[1]}…)`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("every permission change in a migration is declared in the registry", () => {
      const declared = new Set(
        DECLARED_WIDENINGS.map((w) => `${w.migration}|${w.kind}|${w.permission}`)
      );
      const undeclared = inSql
        .map((w) => `${w.migration}|${w.kind}|${w.permission}`)
        .filter((k) => !declared.has(k));
      // A NEW migration that appends to a built-in fails here until its author states which
      // existing bindings it widens. That is the whole control: the act stays possible, and stops
      // being quiet.
      expect([...new Set(undeclared)]).toEqual([]);
    });

    it("every registry entry corresponds to a real migration statement", () => {
      const actual = new Set(inSql.map((w) => `${w.migration}|${w.kind}|${w.permission}`));
      const stale = DECLARED_WIDENINGS.map(
        (w) => `${w.migration}|${w.kind}|${w.permission}`
      ).filter((k) => !actual.has(k));
      // The other direction, and it is not symmetry for its own sake: a registry that can hold
      // entries for statements that no longer exist is a registry that drifts into fiction, and a
      // reader who trusts it would conclude a widening happened that did not.
      expect(stale).toEqual([]);
    });

    it("every declared blast radius says something, and names the affected population", () => {
      const thin = DECLARED_WIDENINGS.filter((w) => w.blastRadius.trim().length < 40);
      expect(thin.map((w) => `${w.migration}/${w.permission}`)).toEqual([]);
    });
  });
});
