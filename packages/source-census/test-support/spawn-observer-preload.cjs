"use strict";
/**
 * ==================================================================================================
 * THE SPAWN OBSERVER'S PRELOAD — WHAT ACTUALLY WATCHES A PROCESS BE CREATED
 * ==================================================================================================
 *
 * WHY THIS EXISTS AT ALL. `packages/runner-launcher` keeps a LEDGER of everything it spawns, and the
 * three managed plugins each assert that ledger is empty on the Kubernetes path. That gate is worth
 * exactly as much as the guarantee that a spawn cannot happen OFF the ledger — and it cannot: the
 * ledger only sees calls that go through `spawnRunnerProcess`. A literal
 * `execFile(dockerBinary, ["version"])` planted in `resolveRunnerLauncher`'s Kubernetes branch is
 * invisible to it, and was MEASURED invisible to it: the three ledger tests stayed green while
 * fourteen real spawns happened. What caught that mutation was a SOURCE CENSUS, and a source census
 * proves the presence of text, never the absence of execution — this repository has a named failure
 * for exactly that distinction (a wiring census that stayed green with the call commented out;
 * see `@scp/source-census`'s own module doc).
 *
 * SO THE OBSERVATION IS MOVED OUTSIDE THE CODE UNDER TEST. This file is `--require`d into a CHILD
 * `node` before a single line of the subject is loaded, wraps every process-creating export of
 * `node:child_process`, and appends one JSON line per creation to the file named by
 * `SCP_SPAWN_OBSERVER_OUT`. The subject then runs for real. "Nothing was spawned" becomes a property
 * of that file being empty, which no rename, no indirection and no second call site can dodge.
 *
 * WHY A CJS `--require` AND NOT AN ESM `--import`. Node builds a builtin's ESM facade ON FIRST
 * IMPORT and copies the CJS export values into it at that moment. A `--require` preload runs before
 * any user module, so mutating `require("node:child_process")` here is what a LATER
 * `import { execFile } from "node:child_process"` in the subject receives. Patch it after the facade
 * exists — which is what an `--import` preload that itself imported the module would do — and the
 * subject keeps the original function and the observer sees nothing. Verified on this Node, not
 * assumed: `spawn-observer.test.ts`'s positive controls fail if this ordering ever stops holding.
 *
 * THE `util.promisify.custom` TRAP, WHICH IS THE ONE THAT WOULD HAVE MADE THIS SILENTLY USELESS.
 * `execFile` carries its own promisified implementation on `util.promisify.custom`, and that
 * implementation calls the module-INTERNAL `execFile`, not `exports.execFile`. So
 * `promisify(execFile)` — which is precisely how `packages/runner-launcher` spawns — would have
 * bypassed a naive wrapper entirely while every callback-style call was recorded. The symbol is
 * therefore wrapped SEPARATELY below, and the runner-launcher control that drives the real Docker
 * path through `promisify(execFile)` is what proves it (that control is not decoration: delete this
 * block and it goes red).
 *
 * AND A CATCH-ALL BENEATH THE EXPORTS. Every ASYNC creation route in Node — `spawn`, `exec`,
 * `execFile`, `fork`, and anything internal that does not go through the exports at all — funnels
 * through `ChildProcess.prototype.spawn`. It is wrapped too, so an async spawn is recorded twice
 * (once by name, once by the catch-all) rather than missed once. Assertions here are about the list
 * being EMPTY, so double-recording costs nothing and a missed route would cost everything.
 *
 * WHAT THIS DOES NOT SEE, STATED RATHER THAN IMPLIED: a native addon calling `posix_spawn`/`fork`
 * directly, and a `process.binding`-style reach into the internals. Neither is reachable from this
 * repository's dependency set (no native addons in `packages/`), and covering them would mean
 * running the child under `strace`/`dtrace`, which is not portable to macOS-without-SIP-disabled or
 * to the CI container. The census below is the compensating control: the set of process-creating
 * exports is PINNED, so a Node upgrade that adds a new one fails this file loudly instead of
 * widening a hole quietly.
 */

const { appendFileSync } = require("node:fs");
const { promisify } = require("node:util");
const cp = require("node:child_process");

const OUT = process.env.SCP_SPAWN_OBSERVER_OUT;
if (!OUT) {
  throw new Error(
    "spawn-observer preload: SCP_SPAWN_OBSERVER_OUT is unset. The observer records to a file so a " +
      "child that crashes mid-spawn still leaves its evidence; without one, an empty result would " +
      "be indistinguishable from a working gate."
  );
}

/**
 * EVERY process-creating export of `node:child_process`, pinned. Not a filter over whatever happens
 * to be there: a filter is where the next instance hides (CLAUDE.md §census-by-property). The list is
 * DERIVED below and COMPARED to this, so a Node release that adds an eighth is a loud failure here
 * rather than a route nobody wrapped.
 */
const PINNED_SPAWNERS = [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync"
];

function record(via, file, argv) {
  appendFileSync(
    OUT,
    JSON.stringify({
      via,
      file: typeof file === "string" ? file : String(file),
      argv: Array.isArray(argv) ? argv.map((a) => String(a)) : []
    }) + "\n"
  );
}

const derived = Object.keys(cp)
  .filter((key) => typeof cp[key] === "function" && /^(exec|spawn|fork)/.test(key))
  .sort();

// WRAP FIRST, COMPLAIN SECOND. If this Node has an export the pin does not know about, it is still
// wrapped — the observer must not become less complete than the list it is being held to.
for (const name of derived) {
  const orig = cp[name];
  const wrapper = function (...args) {
    record(name, args[0], args[1]);
    return orig.apply(this, args);
  };
  for (const key of Reflect.ownKeys(orig)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    // `util.promisify.custom` IS DELIBERATELY NOT COPIED. Node defines it NON-CONFIGURABLE, so
    // copying it first makes the wrapped version below impossible to install — and a wrapper that
    // carried the original symbol would hand `promisify(execFile)` an implementation that calls the
    // module-internal `execFile`, i.e. exactly the route this observer exists to watch.
    if (key === promisify.custom) continue;
    Object.defineProperty(wrapper, key, Object.getOwnPropertyDescriptor(orig, key));
  }
  const custom = orig[promisify.custom];
  if (typeof custom === "function") {
    Object.defineProperty(wrapper, promisify.custom, {
      value: function (...args) {
        record(name + "[promisified]", args[0], args[1]);
        return custom.apply(this, args);
      },
      configurable: true,
      writable: true,
      enumerable: false
    });
  }
  cp[name] = wrapper;
}

if (cp.ChildProcess && typeof cp.ChildProcess.prototype.spawn === "function") {
  const origProtoSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    record("ChildProcess.prototype.spawn", options && options.file, options && options.args);
    return origProtoSpawn.apply(this, arguments);
  };
}

if (JSON.stringify(derived) !== JSON.stringify(PINNED_SPAWNERS)) {
  throw new Error(
    "spawn-observer preload: node:child_process exposes " +
      JSON.stringify(derived) +
      " and this observer is pinned to " +
      JSON.stringify(PINNED_SPAWNERS) +
      ". A new process-creating API means every 'nothing was spawned' assertion in this repository " +
      "just got a route it does not watch. Wrap it, extend the pin, and re-run the controls."
  );
}
