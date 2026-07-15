import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveInternalEgress,
  assertNotReservedInstanceId,
  executionSystemInstanceId,
  EXECUTION_SYSTEM_INSTANCE_PREFIX
} from "./executor-bindings-repo.js";

/**
 * The plugin-host instance keyspace is ONE flat namespace shared by executor, notification and
 * control bindings, and `SubprocessPluginHost.start()` silently skips an id that is already
 * registered. Execution-system instance ids are deterministic (`execution-system:<uuid>`), so a
 * caller-supplied id squatting that prefix would win the race and silently re-point a real system's
 * coordination traffic at tenant-controlled config. Enforced at the REPO layer (every binding type's
 * upsert) rather than per-route, so a future write path can't reintroduce the hole by forgetting it.
 */
describe("assertNotReservedInstanceId — reserved execution-system instance namespace", () => {
  it("rejects a caller-supplied id squatting the reserved prefix", () => {
    expect(() =>
      assertNotReservedInstanceId(`${EXECUTION_SYSTEM_INSTANCE_PREFIX}019f5da9-7a22-75aa-b134-8db9d49218c7`)
    ).toThrow(/reserved/);
    expect(() => assertNotReservedInstanceId("execution-system:anything")).toThrow(/reserved/);
    // Bare prefix alone is still inside the namespace.
    expect(() => assertNotReservedInstanceId(EXECUTION_SYSTEM_INSTANCE_PREFIX)).toThrow(/reserved/);
  });

  it("allows ordinary caller-chosen instance ids", () => {
    for (const id of ["my-argocd", "github-prod", "execution", "execution-system", "exec-system:x"]) {
      expect(() => assertNotReservedInstanceId(id)).not.toThrow();
    }
  });

  it("the SERVER-derived execution-system id is exactly what the guard reserves (they must agree)", () => {
    const derived = executionSystemInstanceId("019f5da9-7a22-75aa-b134-8db9d49218c7");
    expect(derived.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)).toBe(true);
    // The server-derived id is only legitimate because callers can never mint one.
    expect(() => assertNotReservedInstanceId(derived)).toThrow(/reserved/);
  });
});

/**
 * Two-layer internal-egress resolution (ADR-0003). The whole point of this design is that NEITHER
 * layer grants anything alone:
 *  - layer 1 = SCP_INTERNAL_EGRESS_HOSTS, the operator's host-level allowlist (the hard boundary,
 *    outside the graph so it can't depend on RBAC/graph state being right);
 *  - layer 2 = the execution-system object's `allowInternalEgress` property (declared intent).
 *
 * The regression these tests guard is the one an adversarial review caught pre-merge: an earlier cut
 * trusted the PROPERTY alone, which any tenant with plain `object:write` could set on a
 * self-registered execution-system pointing anywhere — a straight SSRF. Here, a tenant declaring the
 * property on an un-allowlisted host must get NOTHING.
 */
describe("resolveInternalEgress — two-layer (operator allowlist AND declared intent)", () => {
  const ENV = "SCP_INTERNAL_EGRESS_HOSTS";
  const original = process.env[ENV];

  beforeEach(() => {
    delete process.env[ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it("permits ONLY when both layers agree", () => {
    process.env[ENV] = "argocd-server.argocd.svc.cluster.local";
    expect(
      resolveInternalEgress("http://argocd-server.argocd.svc.cluster.local", true)
    ).toBe(true);
  });

  it("REFUSES when the tenant declares intent but the operator never allowlisted the host (the SSRF regression)", () => {
    process.env[ENV] = "argocd-server.argocd.svc.cluster.local";
    // A tenant self-registers an execution-system aimed at internal infrastructure and sets the
    // property. Layer 1 has never heard of this host ⇒ no allowance, no SSRF.
    expect(resolveInternalEgress("http://10.0.0.5:6443", true)).toBe(false);
    expect(resolveInternalEgress("http://127.0.0.1:9200", true)).toBe(false);
    expect(resolveInternalEgress("http://169.254.169.254/latest/meta-data", true)).toBe(false);
  });

  it("REFUSES when the operator allowlisted the host but the system never declared intent", () => {
    process.env[ENV] = "argocd-server.argocd.svc.cluster.local";
    expect(resolveInternalEgress("http://argocd-server.argocd.svc.cluster.local", false)).toBe(
      false
    );
  });

  it("is fail-closed by default — an unset allowlist permits nothing (posture unchanged for every existing deployment)", () => {
    expect(resolveInternalEgress("http://argocd-server.argocd.svc.cluster.local", true)).toBe(
      false
    );
    expect(resolveInternalEgress("http://10.0.0.5", true)).toBe(false);
  });

  it("fails closed on unparseable/missing serverUrl rather than throwing", () => {
    process.env[ENV] = "argocd-server.argocd.svc.cluster.local";
    expect(resolveInternalEgress("not-a-url", true)).toBe(false);
    expect(resolveInternalEgress(undefined, true)).toBe(false);
    expect(resolveInternalEgress("", true)).toBe(false);
  });

  it("matches on HOST only — not scheme, port, path, or a substring of the allowlisted name", () => {
    process.env[ENV] = "argocd-server.argocd.svc.cluster.local";
    // Same host, different scheme/port/path ⇒ still the same allowlisted host.
    expect(resolveInternalEgress("https://argocd-server.argocd.svc.cluster.local:443/api", true)).toBe(
      true
    );
    // A look-alike host an attacker controls must NOT match by prefix/suffix/substring.
    expect(resolveInternalEgress("http://evil-argocd-server.argocd.svc.cluster.local", true)).toBe(
      false
    );
    expect(resolveInternalEgress("http://argocd-server.argocd.svc.cluster.local.evil.com", true)).toBe(
      false
    );
  });

  it("accepts a comma-separated list, tolerates whitespace, and is case-insensitive", () => {
    process.env[ENV] = " argocd-server.argocd.svc.cluster.local , GITLAB.internal ";
    expect(resolveInternalEgress("http://gitlab.internal", true)).toBe(true);
    expect(resolveInternalEgress("http://ARGOCD-SERVER.argocd.svc.cluster.local", true)).toBe(true);
    expect(resolveInternalEgress("http://other.internal", true)).toBe(false);
  });

  it("an empty-string allowlist is not a wildcard", () => {
    process.env[ENV] = "";
    expect(resolveInternalEgress("http://10.0.0.5", true)).toBe(false);
    process.env[ENV] = " , , ";
    expect(resolveInternalEgress("http://10.0.0.5", true)).toBe(false);
  });
});
