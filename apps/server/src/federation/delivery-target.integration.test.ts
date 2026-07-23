import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DeliveryTarget, SyncBundle } from "@scp/schemas";
import { buildTestServer, createTestOrg, type TestServer, type TestOrg } from "../test-support/harness.js";

/**
 * M13.2a — the DeliveryTarget SUBSTRATE (proposal §13.2), proven at the real API surface
 * (real Postgres, real routes — the same parity plane the SDK/CLI ride):
 *
 *   1. PARITY — `deliveryTarget` is settable + visible through the EXISTING federation peer
 *      surfaces (pair/list), additive within /v1, with `cosignPublicKey`'s tri-state re-pair
 *      discipline: absent preserves, object sets, explicit null clears.
 *   2. CONFIG-TIME VALIDATION — a traversal-hostile directory never enters the DB (400 at pair).
 *   3. WRITE SEAM, PER-PEER — `deliver: true` on the sync export drops the bundle document into
 *      the PEER's configured outDir, even when the instance env points elsewhere.
 *   4. WRITE SEAM, ENV FALLBACK — a peer with NO target delivers into `SCP_RELAY_OUT_DIR`
 *      (today's instance-level behavior; the retrans-relay suite — unmodified — is the
 *      byte-identical proof for the relay emission itself).
 *   5. FAIL-CLOSED — BOTH absent refuses 400 with a problem NAMING the gap (peer + env var);
 *      and the relay route resolves its outbound drop the same way (per-peer config carries it
 *      past delivery resolution; both-absent refuses before anything else runs).
 */

function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("M13.2a DeliveryTarget substrate (API surface)", () => {
  let server: TestServer;
  let org: TestOrg;
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "scp-delivery-int-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "delivery-target");
    savedEnv.SCP_RELAY_OUT_DIR = process.env.SCP_RELAY_OUT_DIR;
    savedEnv.SCP_RELAY_IN_DIR = process.env.SCP_RELAY_IN_DIR;

    const init = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/init",
      headers: authHeader(org.adminToken),
      payload: { name: "low-side", role: "outpost" }
    });
    expect(init.statusCode, init.body).toBe(200);
  });

  afterEach(() => {
    // Every test starts from a clean instance env — no cross-test bleed through process.env.
    for (const key of ["SCP_RELAY_OUT_DIR", "SCP_RELAY_IN_DIR"]) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    delete process.env.SCP_RELAY_OUT_DIR;
    delete process.env.SCP_RELAY_IN_DIR;
  });

  afterAll(async () => {
    for (const key of ["SCP_RELAY_OUT_DIR", "SCP_RELAY_IN_DIR"]) {
      const saved = savedEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    await server.close();
  });

  async function pairPeer(
    name: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/peers",
      headers: authHeader(org.adminToken),
      payload: {
        domainId: (extra.domainId as string) ?? randomUUID(),
        name,
        role: "retrans",
        publicKey: "dGVzdC1rZXk=",
        ...extra
      }
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  async function listPeers(): Promise<Array<{ name: string; deliveryTarget: DeliveryTarget | null }>> {
    const response = await server.app.inject({
      method: "GET",
      url: "/api/v1/federation/peers",
      headers: authHeader(org.adminToken)
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Array<{ name: string; deliveryTarget: DeliveryTarget | null }>;
  }

  it("PARITY: deliveryTarget is settable + visible via pair/list, with tri-state re-pair semantics", async () => {
    const outDir = await tempDir();
    const inDir = await tempDir();
    const domainId = randomUUID();
    const target = { provider: "filesystem", outDir, inDir };

    // Set at pair time — echoed on the 201 and on list.
    const paired = await pairPeer("parity-peer", { domainId, deliveryTarget: target });
    expect(paired.statusCode, JSON.stringify(paired.body)).toBe(201);
    expect(paired.body.deliveryTarget).toEqual(target);
    expect((await listPeers()).find((p) => p.name === "parity-peer")?.deliveryTarget).toEqual(
      target
    );

    // Re-pair WITHOUT the field (an older client) — the configured target is PRESERVED.
    const repaired = await pairPeer("parity-peer", { domainId });
    expect(repaired.statusCode).toBe(201);
    expect(repaired.body.deliveryTarget).toEqual(target);

    // Re-pair with EXPLICIT null — cleared back to the instance-env fallback.
    const cleared = await pairPeer("parity-peer", { domainId, deliveryTarget: null });
    expect(cleared.statusCode).toBe(201);
    expect(cleared.body.deliveryTarget).toBeNull();
    expect((await listPeers()).find((p) => p.name === "parity-peer")?.deliveryTarget).toBeNull();
  });

  it("CONFIG-TIME VALIDATION: traversal-hostile / relative dirs are refused at the API edge (400)", async () => {
    for (const hostile of ["/inbox/../../etc", "relative/dir"]) {
      for (const field of ["outDir", "inDir"]) {
        const refused = await pairPeer("hostile-peer", {
          deliveryTarget: { provider: "filesystem", [field]: hostile }
        });
        expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      }
    }
  });

  it("WRITE SEAM, PER-PEER: deliver:true drops the sync bundle into the PEER's outDir, not the env's", async () => {
    const peerOut = await tempDir();
    const envOut = await tempDir();
    process.env.SCP_RELAY_OUT_DIR = envOut;
    const paired = await pairPeer("drop-peer", {
      deliveryTarget: { provider: "filesystem", outDir: peerOut }
    });
    expect(paired.statusCode, JSON.stringify(paired.body)).toBe(201);

    const exported = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/exports",
      headers: authHeader(org.adminToken),
      payload: { peer: "drop-peer", deliver: true }
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const bundle = exported.json() as SyncBundle;

    const fileName = `scp-sync-${bundle.header.exporterDomainId}-${bundle.header.throughSequence}.scpbundle`;
    const dropped = JSON.parse(await readFile(path.join(peerOut, fileName), "utf8")) as SyncBundle;
    // The dropped document IS the exported bundle (same signed document the CLI's --out writes).
    expect(dropped).toEqual(bundle);
    // The per-peer target WON — nothing landed in the instance-env dir.
    expect(await readdir(envOut)).toEqual([]);
  });

  it("WRITE SEAM, ENV FALLBACK: a peer with NO target delivers into SCP_RELAY_OUT_DIR (today's behavior)", async () => {
    const envOut = await tempDir();
    process.env.SCP_RELAY_OUT_DIR = envOut;
    const paired = await pairPeer("env-peer");
    expect(paired.statusCode).toBe(201);

    const exported = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/exports",
      headers: authHeader(org.adminToken),
      payload: { peer: "env-peer", deliver: true }
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const bundle = exported.json() as SyncBundle;
    const fileName = `scp-sync-${bundle.header.exporterDomainId}-${bundle.header.throughSequence}.scpbundle`;
    const dropped = JSON.parse(await readFile(path.join(envOut, fileName), "utf8")) as SyncBundle;
    expect(dropped).toEqual(bundle);
  });

  it("FAIL-CLOSED: BOTH absent refuses 400 with a problem NAMING the gap — and a plain export still works", async () => {
    const paired = await pairPeer("gapped-peer");
    expect(paired.statusCode).toBe(201);

    // deliver with neither per-peer config nor env → fail-closed, named per-gap problem.
    const refused = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/exports",
      headers: authHeader(org.adminToken),
      payload: { peer: "gapped-peer", deliver: true }
    });
    expect(refused.statusCode, refused.body).toBe(400);
    const problem = refused.json() as { detail?: string };
    expect(problem.detail).toContain("gapped-peer");
    expect(problem.detail).toContain("SCP_RELAY_OUT_DIR");
    expect(problem.detail).toContain("fail-closed");

    // The plain (non-deliver) export is untouched by all of this — today's behavior.
    const plain = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/exports",
      headers: authHeader(org.adminToken),
      payload: { peer: "gapped-peer" }
    });
    expect(plain.statusCode, plain.body).toBe(200);
  });

  it("RELAY ROUTE: the outbound drop resolves through the peer's DeliveryTarget (fail-closed when unresolvable)", async () => {
    // BOTH absent → the route refuses 400 with the named gap BEFORE any relay work runs.
    const refused = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/relay",
      headers: authHeader(org.adminToken),
      payload: { change: randomUUID() }
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect((refused.json() as { detail?: string }).detail).toContain("SCP_RELAY_OUT_DIR");

    // Naming a peer WITH a configured outDir carries resolution — the refusal is now the
    // (expected, downstream) retrans ROLE gate, proving the per-peer drop resolved.
    const outDir = await tempDir();
    const paired = await pairPeer("relay-dest", {
      deliveryTarget: { provider: "filesystem", outDir }
    });
    expect(paired.statusCode).toBe(201);
    const roleGated = await server.app.inject({
      method: "POST",
      url: "/api/v1/federation/relay",
      headers: authHeader(org.adminToken),
      payload: { change: randomUUID(), peer: "relay-dest" }
    });
    expect(roleGated.statusCode, roleGated.body).toBe(409);
    expect((roleGated.json() as { detail?: string }).detail).toContain(
      "requires federation role 'retrans'"
    );
  });
});
