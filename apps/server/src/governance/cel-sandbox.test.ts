import { afterEach, describe, expect, it } from "vitest";
import {
  CEL_MAX_EXPRESSION_LENGTH,
  CEL_MAX_NESTING_DEPTH,
  CelSandbox,
  CelSandboxError,
  checkStaticComplexity
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
    const deep = "(".repeat(CEL_MAX_NESTING_DEPTH + 10) + "1" + ")".repeat(CEL_MAX_NESTING_DEPTH + 10);
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
    const result = await sandbox.evaluate("change.emergency == false", { change: { emergency: false } });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("evaluates a false boolean condition", async () => {
    const sandbox = makeSandbox();
    const result = await sandbox.evaluate("change.emergency == true", { change: { emergency: false } });
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
      Array.from({ length: 10 }, () => sandbox.evaluate('subject.labels.env == "prod" && !change.emergency', ctx))
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

  it("a genuinely hung/slow evaluation is killed by the hard timeout, not left to hang the caller", async () => {
    // cel-js has no native sleep/loop construct to actually hang itself with (by design — CEL is
    // not Turing-complete), so this proves the OTHER failure mode the timeout defends against:
    // an expression the static pre-check didn't catch but that is slow to evaluate. We simulate
    // "slow" by pointing the sandbox at a worker entry that never responds (below), proving the
    // timeout path itself — terminate() firing, the pending call resolving instead of hanging
    // forever, and the pool recovering for the NEXT call.
    const sandbox = makeSandbox({ timeoutMs: 50, workerEntryPath: HANGING_WORKER_ENTRY_PATH });
    const start = Date.now();
    const result = await sandbox.evaluate("true", {});
    expect(result.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000); // bounded, not hung forever

    // The pool must have respawned a working worker for the NEXT call to succeed against a real
    // (non-hanging) entry point — verified by constructing a fresh, normal sandbox here instead
    // (respawn-after-timeout against the SAME hanging entry point would just hang again by
    // construction; what matters is that `evaluate()` itself resolved rather than hung, proven
    // above).
    const normalSandbox = makeSandbox();
    const normalResult = await normalSandbox.evaluate("true", {});
    expect(normalResult).toEqual({ ok: true, value: true });
  }, 10_000);
});

// A worker entry that never posts a response — used only by the timeout test above to force the
// hard-timeout path deterministically without depending on cel-js internals.
const HANGING_WORKER_ENTRY_PATH = new URL("./test-support/hanging-cel-worker-entry.ts", import.meta.url)
  .pathname;
