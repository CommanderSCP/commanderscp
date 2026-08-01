import { afterEach, describe, expect, it } from "vitest";
import {
  CEL_MAX_CONTEXT_BYTES,
  CEL_MAX_CONTEXT_DEPTH,
  CEL_MAX_ERROR_LENGTH,
  CEL_MAX_EXPRESSION_LENGTH,
  CEL_MAX_NESTING_DEPTH,
  CelSandbox,
  CelSandboxError,
  checkContextComplexity,
  checkStaticComplexity,
  normalizeCelWorkerError
} from "./cel-sandbox.js";

/**
 * Unit coverage for the sandboxed CEL evaluator (BUILD_AND_TEST.md §8 M4 unit DoD: "the CEL
 * sandbox genuinely blocks I/O/arbitrary code (assert a malicious expression can't escape)").
 * Spins up real `node:worker_threads` — no mocking of the sandbox internals, since the whole
 * point under test is that isolation is real.
 */
describe("checkStaticComplexity (layer 1: static pre-validation)", () => {
  it("accepts a normal short expression", () => {
    expect(() => checkStaticComplexity("change.impacts.size() > 0")).not.toThrow();
  });

  it("rejects an empty expression", () => {
    expect(() => checkStaticComplexity("")).toThrow(CelSandboxError);
  });

  it("rejects an expression past the max length", () => {
    const huge = "1+".repeat(CEL_MAX_EXPRESSION_LENGTH); // way past the byte cap
    expect(() => checkStaticComplexity(huge)).toThrow(CelSandboxError);
  });

  it("rejects pathologically deep nesting (parser-stack-overflow defense)", () => {
    const deep =
      "(".repeat(CEL_MAX_NESTING_DEPTH + 10) + "1" + ")".repeat(CEL_MAX_NESTING_DEPTH + 10);
    expect(() => checkStaticComplexity(deep)).toThrow(CelSandboxError);
  });

  it("accepts nesting right at the boundary", () => {
    const atBoundary = "(".repeat(CEL_MAX_NESTING_DEPTH) + "1" + ")".repeat(CEL_MAX_NESTING_DEPTH);
    expect(() => checkStaticComplexity(atBoundary)).not.toThrow();
  });
});

describe("CelSandbox (layer 2: worker-thread isolation)", () => {
  const sandboxes: CelSandbox[] = [];
  function makeSandbox(opts?: ConstructorParameters<typeof CelSandbox>[0]): CelSandbox {
    const sandbox = new CelSandbox(opts);
    sandboxes.push(sandbox);
    return sandbox;
  }
  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((s) => s.stop()));
  });

  it("evaluates a true boolean condition", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("change.emergency == false", {
      change: { emergency: false }
    });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("evaluates a false boolean condition", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("change.emergency == true", {
      change: { emergency: false }
    });
    expect(result).toEqual({ ok: true, value: false });
  });

  it("evaluates against nested context fields (dot notation)", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate('subject.labels.env == "prod"', {
      subject: { labels: { env: "prod" } }
    });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("supports has()/size() macros over context collections", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("size(change.targets) > 1", {
      change: { targets: ["a", "b", "c"] }
    });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("same expression + same context snapshot always yields the same result (determinism)", async () => {
    const sandbox = makeSandbox();
    const ctx = { change: { emergency: false }, subject: { labels: { env: "prod" } } };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        sandbox.evaluate('subject.labels.env == "prod" && !change.emergency', ctx)
      )
    );
    for (const r of results) expect(r).toEqual({ ok: true, value: true });
  });

  it("returns ok:false (never throws) for a syntactically invalid expression", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("this is not : valid CEL {{{", {});
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for a reference to an undefined identifier — no ambient globals leak in", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("process.env.SECRET == 'x'", {});
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------------------------
  // THE ERROR TEXT DEPENDS ON THE FAULT, NEVER ON THE CONTEXT (PR #153 review Q2).
  //
  // cel-js serializes the WHOLE evaluation context into its identifier-resolution errors, and
  // `governance/evaluate.ts` puts a per-evaluation `time` snapshot in that context and then
  // persists the resulting string into every gate Decision's reason tree. Left alone, a single
  // typo'd policy condition — a PERMANENT operator error that never self-heals — made the reason
  // tree differ on every ~2 s reconcile tick, so `insertDecisionIfChanged` correctly wrote a new
  // row every tick and the gate returned to ~43,200 rows/day/change: the original 1.44 GB/day
  // incident, with the persist-on-change fix fully in place.
  //
  // These two tests are the ones a cel-js version bump must break rather than silently regress:
  // the first pins the message END TO END through a real worker (so a reworded upstream error is
  // caught), the second pins the invariant that matters (context values, above all `time`, never
  // appear).
  // ---------------------------------------------------------------------------------------
  it("an unevaluable identifier yields the DIAGNOSIS only — cel-js's serialized context dump is stripped", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("change.typoed == true", {
      change: { emergency: false },
      time: "2026-07-30T12:00:00.000Z"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Exact, not a regex: this is the whole string a Decision's reason tree now stores.
      expect(result.error).toBe('Identifier "typoed" not found in context');
    }
  });

  it("the error text for the SAME fault is byte-identical across evaluations whose context differs only in `time`", async () => {
    const sandbox = makeSandbox();
    const at = async (time: string) =>
      sandbox.evaluate("change.typoed == true", { change: { emergency: false }, time });

    const first = await at("2026-07-30T12:00:00.000Z");
    const second = await at("2026-07-30T12:00:02.000Z");
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      // THE PROPERTY THE DEDUPE DEPENDS ON. Before the fix these differed inside the embedded
      // timestamp — two 1,346-byte strings, two characters apart — which is exactly enough for
      // `restatesDecision` to (correctly) call it a new verdict and append a row.
      expect(second.error).toBe(first.error);
      expect(first.error).not.toContain("2026-07-30T12:00:00.000Z");
      expect(first.error).not.toContain("emergency");
    }
  });

  it("truncates an unrecognized over-long worker error rather than putting an unbounded blob in every Decision", () => {
    // No context-dump marker, so the SIZE bound is what applies — the backstop for a future cel-js
    // message this module does not recognize. (Called directly: producing a >512-char cel-js error
    // through a real worker would take a pathological expression the static checks reject first.)
    const long = `CelParseError: ${"x".repeat(CEL_MAX_ERROR_LENGTH * 2)}`;
    const normalized = normalizeCelWorkerError(long);
    expect(normalized.length).toBeLessThanOrEqual(CEL_MAX_ERROR_LENGTH + "… (truncated)".length);
    expect(normalized.startsWith("CelParseError: ")).toBe(true);
  });

  it("leaves an error that carries no context dump exactly as cel-js wrote it", () => {
    const parseError = "Given CEL expression is invalid";
    expect(normalizeCelWorkerError(parseError)).toBe(parseError);
  });

  // ---------------------------------------------------------------------------------------
  // Malicious-input / sandbox-escape attempts (BUILD_AND_TEST.md §8 M4: "assert a malicious
  // expression can't escape"). None of these may (a) throw an uncaught exception that could
  // crash the host process, (b) return a live Node object / function / any value that isn't
  // plain JSON-serializable data, or (c) have any observable side effect (no way to assert
  // "no side effect" directly, so these tests assert the SAFE failure mode: a rejected/failed
  // evaluation that resolves to inert data, never to something callable).
  // ---------------------------------------------------------------------------------------
  const escapeAttempts = [
    "this.constructor.constructor('return process')()",
    "(() => process.exit(1))()",
    "require('child_process').execSync('id')",
    "global.process.mainModule.require('fs').readFileSync('/etc/passwd')",
    "__proto__.constructor.constructor('return this')()",
    "context.constructor.constructor('return process.env')()",
    "[].constructor.constructor('return process')()"
  ];

  for (const expression of escapeAttempts) {
    it(`sandbox-escape attempt is neutered, never executes JS: ${JSON.stringify(expression)}`, async () => {
      const result = await sandbox_evaluate(expression);
      // Either a parse/eval failure (the overwhelmingly common outcome — this isn't valid CEL),
      // or in the worst case a benign non-function value. It must NEVER be a function/process/
      // object with dangerous methods — assert the value, if any, is JSON-safe primitive/plain
      // data, proving nothing "escaped" into a live host object.
      if (result.ok) {
        expect(["string", "number", "boolean", "object"]).toContain(typeof result.value);
        expect(typeof result.value).not.toBe("function");
        // structured-clone through postMessage already strips functions/Node internals; this is
        // belt-and-braces confirming the value round-trips through JSON (i.e. is inert data).
        expect(() => JSON.stringify(result.value)).not.toThrow();
      } else {
        expect(typeof result.error).toBe("string");
      }
    });
  }

  async function sandbox_evaluate(expression: string) {
    const sandbox = makeSandbox();
    return sandbox.evaluate(expression, { context: { nested: true } });
  }

  // MINOR (a): the escape-attempt loop above only ever exercises the `ok:false` branch (none of
  // those strings is valid CEL). This makes the "inert value" branch real — a parseable
  // expression that resolves to an OBJECT must come back as JSON-safe, structured-clone-stripped
  // data, never a live/callable value.
  it("a parseable expression that resolves to a context OBJECT returns inert, JSON-safe data (never a live/callable value)", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("context", {
      context: { nested: { deep: true }, list: [1, 2, 3] }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe("object");
      expect(typeof result.value).not.toBe("function");
      expect(() => JSON.stringify(result.value)).not.toThrow();
      expect(result.value).toEqual({ nested: { deep: true }, list: [1, 2, 3] });
    }
  });

  // MAJOR #4: a pathologically large or deep (partly attacker-controlled) context is rejected
  // BEFORE it reaches a worker, so a short expression can't exhaust the timeout budget.
  it("rejects an over-large evaluation context (fail-closed, not passed to a worker)", async () => {
    const sandbox = makeSandbox();
    const huge = "x".repeat(CEL_MAX_CONTEXT_BYTES + 1);
    const result = await sandbox.evaluate("subject.labels == subject.labels", {
      subject: { labels: { blob: huge } }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/context exceeds max size/i);
  });

  it("rejects a pathologically deep evaluation context (fail-closed)", async () => {
    const sandbox = makeSandbox();
    // Build a context nested deeper than CEL_MAX_CONTEXT_DEPTH.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < CEL_MAX_CONTEXT_DEPTH + 5; i++) deep = { child: deep };
    const result = await sandbox.evaluate("has(subject)", { subject: deep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/context exceeds max nesting depth/i);
  });

  it("checkContextComplexity accepts a normal policy-sized context", () => {
    expect(
      checkContextComplexity({
        change: { id: "c1", emergency: false, targets: ["t1"] },
        subject: { id: "t1", labels: { env: "prod", tier: "critical" } },
        graph: { ownerIds: ["o1", "o2"], dependentIds: [], domainIds: [] }
      })
    ).toBeNull();
  });

  it("a genuinely hung/slow evaluation is killed by the hard timeout — and the SAME sandbox recovers for the next call", async () => {
    // cel-js has no native sleep/loop construct to actually hang itself with (by design — CEL is
    // not Turing-complete), so a conditional-hang worker entry forces the timeout path
    // deterministically: it hangs ONLY on the sentinel "__HANG__" and evaluates everything else
    // normally. That lets this prove what the old test couldn't (MINOR (b)) — after the timeout
    // terminates+respawns the wedged worker, the SAME sandbox instance serves a subsequent call.
    const sandbox = makeSandbox({
      timeoutMs: 50,
      workerEntryPath: CONDITIONAL_HANG_WORKER_ENTRY_PATH
    });
    const start = Date.now();
    const hung = await sandbox.evaluate("__HANG__", {});
    expect(hung.ok).toBe(false);
    // BOUNDED, NOT HUNG FOREVER — that is the whole claim, and the number is headroom, not a
    // latency target. The sandbox's own `timeoutMs` here is 50ms; everything above that is worker
    // spawn.
    //
    // RAISED 2000 -> 5000 (2026-08-01). Job 4 now runs `pnpm test -- --coverage`, and v8
    // instrumentation makes spawning + loading a worker thread materially slower: this assertion
    // failed on `main` at 2158ms having passed uninstrumented for months. 5000 keeps the assertion
    // meaningful — a genuinely hung evaluation blows the 10s test timeout below, so 5s still
    // separates "bounded" from "wedged" — while not re-litigating worker startup cost on every
    // loaded CI box.
    //
    // This is the ONLY wall-clock assertion in the unit layer (censused 2026-08-01:
    // `packages/plugins/fake-executor` deliberately uses a fake clock for exactly this reason, and
    // says so). `plugin-host/host.test.ts`'s `rssGrowthMb < 300` is the same PROPERTY — a resource
    // bound now measured under instrumentation — and was checked: it has passed every run since
    // coverage was enabled, so it is left alone rather than pre-emptively loosened.
    expect(Date.now() - start).toBeLessThan(5000);

    // SAME sandbox: the respawned worker (same conditional-hang entry) evaluates a normal
    // expression successfully — proving the pool healed rather than staying wedged.
    const recovered = await sandbox.evaluate("1 == 1", {});
    expect(recovered).toEqual({ ok: true, value: true });
  }, 10_000);
});

// A worker entry that hangs only on the "__HANG__" sentinel (evaluating everything else) — used by
// the same-sandbox-recovery timeout test above.
const CONDITIONAL_HANG_WORKER_ENTRY_PATH = new URL(
  "./test-support/conditional-hang-cel-worker-entry.ts",
  import.meta.url
).pathname;
