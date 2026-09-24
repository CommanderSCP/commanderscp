import http from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scpOpsV1ReferenceTemplate } from "@scp/plugin-argo-workflows";
import {
  OPS_TEMPLATE_REFUSED_RPC_CODE,
  opsTemplateRefusalOf,
  triggerRefusalOf
} from "@scp/plugin-api";
import { SubprocessPluginHost, configFingerprint } from "./host.js";

// Wraps the REAL `child_process.spawn`, to count respawns.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * A STARTED INSTANCE'S CONFIG IS CURRENT (#414 re-verification, SHOULD-FIX 2) — over the REAL
 * subprocess host, not the lane test's fake, whose `start()` overwrites config every call and so
 * could never show the defect.
 *
 * The defect: `start()` skipped any id already running, so a process kept the config it was first
 * started with. An `object:write` editor could start an argo-workflows instance under their own
 * `serverUrl`, re-point the binding at the pinned endpoint with the SAME instance id, and every later
 * "start" left their process running — later triggers passed the server's pin check (which read the
 * NEW config) and then submitted through the OLD one.
 */

let host: SubprocessPluginHost | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function listen(
  handler: http.RequestListener
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

describe("SubprocessPluginHost: an instance is restarted when its config changes", () => {
  it("the fingerprint ignores key order and orgId/scopeKey, and sees config/secrets/egress", () => {
    const base = { id: "x", module: "fake-executor" as const, orgId: "o1", scopeKey: "s1" };
    expect(configFingerprint({ ...base, config: { a: 1, b: { c: 2, d: 3 } } })).toBe(
      configFingerprint({
        ...base,
        orgId: "o2",
        scopeKey: "s2",
        config: { b: { d: 3, c: 2 }, a: 1 }
      })
    );
    for (const changed of [
      { config: { a: 2, b: { c: 2, d: 3 } } },
      { config: { a: 1, b: { c: 2, d: 3 } }, secrets: { k: "v" } },
      { config: { a: 1, b: { c: 2, d: 3 } }, allowedHosts: ["h"] },
      { config: { a: 1, b: { c: 2, d: 3 } }, allowInternalEgress: true }
    ]) {
      expect(configFingerprint({ ...base, ...changed })).not.toBe(
        configFingerprint({ ...base, config: { a: 1, b: { c: 2, d: 3 } } })
      );
    }
  });

  it("same config → the process is left alone; changed config → respawned, and the NEW config is what runs", async () => {
    const childProcess = await import("node:child_process");
    const spawnSpy = vi.mocked(childProcess.spawn);
    spawnSpy.mockClear();
    const statePath = join(tmpdir(), `refresh-${randomUUID()}.json`);
    const cfg = (phase: "failed" | "succeeded") => ({
      id: "refresh-probe",
      module: "fake-executor" as const,
      orgId: "org-1",
      scopeKey: "d",
      config: { statePath, forcePhase: { "target-1": phase } }
    });
    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });

    await host.start([cfg("failed")]);
    const ref1 = await host
      .executor("refresh-probe")
      .trigger({ kind: "sync", targetRef: "target-1" });
    expect((await host.executor("refresh-probe").status(ref1)).phase).toBe("failed");

    await host.start([cfg("failed")]);
    expect(spawnSpy, "an identical config must not respawn").toHaveBeenCalledTimes(1);

    await host.start([cfg("succeeded")]);
    expect(spawnSpy, "a changed config must respawn").toHaveBeenCalledTimes(2);
    const ref2 = await host
      .executor("refresh-probe")
      .trigger({ kind: "sync", targetRef: "target-1" });
    expect(
      (await host.executor("refresh-probe").status(ref2)).phase,
      "the respawned process runs the config it was just given"
    ).toBe("succeeded");
  });

  it("ensureAliveOnly never reconfigures a running instance (the shared default executor's contract)", async () => {
    const childProcess = await import("node:child_process");
    const spawnSpy = vi.mocked(childProcess.spawn);
    spawnSpy.mockClear();
    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    const booted = {
      id: "default-like",
      module: "fake-executor" as const,
      orgId: "o",
      scopeKey: "d",
      config: { forcePhase: { t: "failed" } }
    };
    await host.start([booted]);
    await host.start([{ ...booted, config: {}, ensureAliveOnly: true }]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const ref = await host.executor("default-like").trigger({ kind: "sync", targetRef: "t" });
    expect((await host.executor("default-like").status(ref)).phase).toBe("failed");
  });

  it("THE #414 SCENARIO: an argo-workflows instance started under an editor's server, then re-pointed at the pin, submits ONLY to the pinned server", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const redeemUrl = "http://commanderscp-api.scp.svc:8080";
    const evilHits: string[] = [];
    const goodHits: string[] = [];
    const evil = await listen((req, res) => {
      evilHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        req.method === "GET"
          ? JSON.stringify(scpOpsV1ReferenceTemplate({ runnerImageDigest: digest, redeemUrl }))
          : JSON.stringify({ metadata: { name: "wf-evil", uid: "u-evil" } })
      );
    });
    const good = await listen((req, res) => {
      goodHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        req.method === "GET"
          ? JSON.stringify(scpOpsV1ReferenceTemplate({ runnerImageDigest: digest, redeemUrl }))
          : JSON.stringify({ metadata: { name: "wf-good", uid: "u-good" } })
      );
    });
    try {
      host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
      const statePath = join(tmpdir(), `refresh-argo-${randomUUID()}.json`);
      const instance = (serverUrl: string) => ({
        id: "argo-ops-shared-id",
        module: "argo-workflows" as const,
        orgId: "org-1",
        scopeKey: "d",
        allowInternalEgress: true,
        config: {
          serverUrl,
          namespace: "scp-argo-workflows",
          token: "t",
          statePath,
          // The pins are the org's (server-injected), and name ONLY the good server.
          opsTemplatePins: [
            {
              serverUrl: good.base,
              namespace: "scp-argo-workflows",
              templateRef: "scp-ops-v1",
              runnerImageDigest: digest,
              redeemUrl
            }
          ]
        }
      });
      // 1. The editor's instance, under their own server.
      await host.start([instance(evil.base)]);
      // 2. The binding re-pointed at the pin, SAME instance id; the server resolves the new config.
      await host.start([instance(good.base)]);
      const ref = await host.executor("argo-ops-shared-id").trigger({
        kind: "workflow_dispatch",
        targetRef: "scp-ops-v1",
        idempotencyKey: randomUUID(),
        parameters: { opsRunTokenSealed: "sealed", opsRunId: "r" }
      });
      expect(ref.externalId).toContain("wf-good");
      expect(evilHits, "nothing reaches the editor's server after the re-point").toEqual([]);
      expect(goodHits.some((h) => h.startsWith("POST"))).toBe(true);
    } finally {
      await evil.close();
      await good.close();
    }
  });
});

describe("SubprocessPluginHost: the ops read-back refusal is recognised by RPC CODE, never by text", () => {
  it("FORGE PROBE: an instance id spelled like the old text marker cannot turn a network failure into a template verdict", async () => {
    // #413's pluginInstanceId charset admits every character of the old marker, and the host's
    // error message embeds the instance id — so a text match was forgeable by naming an instance.
    const id = "scp-ops-template-refused:forged";
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id), "a charset-valid instance id").toBe(
      true
    );
    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id,
        module: "argo-workflows",
        orgId: "org-1",
        scopeKey: "d",
        allowInternalEgress: true,
        config: {
          serverUrl: "http://127.0.0.1:9", // nothing listens: an ordinary, retryable failure
          namespace: "ns",
          token: "t",
          statePath: join(tmpdir(), `forge-${randomUUID()}.json`),
          opsTemplatePins: []
        }
      }
    ]);
    const err = await host
      .executor(id)
      .trigger({
        kind: "workflow_dispatch",
        targetRef: "org-template",
        idempotencyKey: randomUUID()
      })
      .catch((e: Error) => e);
    expect((err as Error).message, "the forged text IS in the host's message").toContain(
      "scp-ops-template-refused:"
    );
    expect(opsTemplateRefusalOf(err), "…and is NOT read as a template verdict").toBeUndefined();
    expect(triggerRefusalOf(err)).toBeUndefined();
  });

  it("CONTROL: a genuine read-back refusal over the real host IS recognised, by its code", async () => {
    host = new SubprocessPluginHost({ callTimeoutMs: 10_000 });
    await host.start([
      {
        id: "ops-genuine",
        module: "argo-workflows",
        orgId: "org-1",
        scopeKey: "d",
        allowInternalEgress: true,
        config: {
          serverUrl: "http://127.0.0.1:9",
          namespace: "ns",
          token: "t",
          statePath: join(tmpdir(), `genuine-${randomUUID()}.json`),
          opsTemplatePins: [] // no pin names this endpoint → refused before any request
        }
      }
    ]);
    const err = await host
      .executor("ops-genuine")
      .trigger({ kind: "workflow_dispatch", targetRef: "scp-ops-v1", idempotencyKey: randomUUID() })
      .catch((e: Error) => e);
    expect((err as Error & { rpcCode?: number }).rpcCode).toBe(OPS_TEMPLATE_REFUSED_RPC_CODE);
    expect(opsTemplateRefusalOf(err)).toContain(
      "no Argo host-ops pin names this instance's endpoint"
    );
  });
});
