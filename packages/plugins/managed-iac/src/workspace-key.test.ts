import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@scp/plugin-api";
import type { RunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import {
  createManagedIacExecutorPlugin,
  managedIacWorkspaceKey,
  ManagedIacWorkspaceRefInvalid
} from "./index.js";

/**
 * THE WORKSPACE IDENTITY IS NON-LOSSY (#417 verification probes G and H; ADR-0056 addendum 4). A
 * `targetRef` names a directory only if it already is a plain name; anything else is refused —
 * the server's lane keys its collision check on this same function, so no two refs can reach one
 * directory, and `..` reaches nothing.
 */

describe("managedIacWorkspaceKey", () => {
  it("keeps a plain name EXACTLY — the identity is the name, not a mapping of it", () => {
    for (const ref of ["t1", "alias_X", "prod-eu-west-1", "a.b", "01a0d162-ee05-750e-b552-59c0ff6222a1"]) {
      expect(managedIacWorkspaceKey(ref)).toBe(ref);
    }
    expect(managedIacWorkspaceKey(undefined)).toBe("default");
  });

  it("REFUSES what sanitizing used to alias or escape: separators, '.', '..', empty, leading dot", () => {
    for (const ref of ["alias/X", "a\\b", ".", "..", "", ".hidden", "a b", "a:b", "x".repeat(129)]) {
      expect(() => managedIacWorkspaceKey(ref), JSON.stringify(ref)).toThrow(
        ManagedIacWorkspaceRefInvalid
      );
    }
  });
});

let workspaceRoot: string;
let seen: RunnerSpec[];
beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "managed-iac-ws-key-"));
  seen = [];
});
afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function ctx(): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async () => {
        throw new Error("managed-iac: never calls ctx.http");
      }
    },
    config: {
      runnerImage: "scp-runner-iac:vetted",
      workspaceRoot,
      networkMode: "none",
      statePath: join(workspaceRoot, "dedup.json")
    }
  };
}

describe("the plugin refuses a non-plain targetRef as a RECORDED failure, and writes nothing", () => {
  it.each(["..", "alias/X", "."])("targetRef %j", async (targetRef) => {
    const launcher: RunnerLauncher = {
      async run(spec) {
        seen.push(spec);
        return { succeeded: true, stdout: "", stderr: "" };
      },
      reap: async () => []
    };
    const plugin = createManagedIacExecutorPlugin(() => launcher);
    const c = ctx();
    const ref = await plugin.trigger(c, {
      kind: "sync",
      targetRef,
      parameters: { iacAction: "plan" },
      idempotencyKey: `ws-${targetRef.length}-${targetRef.charCodeAt(0)}`
    });
    const status = await plugin.status(c, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/is not a plain workspace name/);
    expect(seen).toEqual([]);
    // Nothing was created beside the dedup ledger — above all, no workspace at the root.
    expect((await readdir(workspaceRoot)).sort()).toEqual(["dedup.json"]);
  });
});
