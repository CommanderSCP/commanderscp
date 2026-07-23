import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DeliveryTargetSchema } from "@scp/schemas";
import {
  assertDeliveryTargetRooted,
  dropDeliveryFile,
  isDeliveryS3EndpointAllowed,
  isUnderDeliveryRoot,
  listInbox,
  normalizeS3Origin,
  parseDeliveryRoots,
  parseDeliveryS3Endpoints,
  requireInboundDir,
  requireOutboundDir,
  resolveDeliveryTarget
} from "./delivery-target.js";
import { deliveryTargetSecretKey, parseDeliveryS3Credential } from "./retrans-relay.js";

/**
 * M13.2a — DeliveryTarget VIEW resolution (proposal §13.2), unit-proven per gap:
 * per-peer beats env, env fallback is exactly today's behavior, BOTH-absent is a named
 * fail-closed problem (never a silent default path), a hostile stored dir never resolves
 * (and never silently falls back), and the inbox listing keeps the PR #112 traversal
 * guard — names only.
 */

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "scp-delivery-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const fsTarget = (dirs: { outDir?: string; inDir?: string }) =>
  ({ provider: "filesystem" as const, ...dirs });

/** ProblemError puts the human text in `.detail` (`.message` is the RFC 9457 title). */
function problemDetail(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { detail?: string }).detail ?? "";
  }
  throw new Error("expected the call to throw a ProblemError");
}

async function rejectedDetail(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { detail?: string }).detail ?? "";
  }
  throw new Error("expected the promise to reject with a ProblemError");
}

describe("resolveDeliveryTarget — the validated per-peer view (M15.6 shape)", () => {
  it("uses the peer's own target when set (per direction, source 'peer')", () => {
    const view = resolveDeliveryTarget(
      { name: "high-side", deliveryTarget: fsTarget({ outDir: "/drops/out", inDir: "/drops/in" }) },
      { outDir: "/env/out", inDir: "/env/in" },
      ["/drops"] // operator-declared roots: per-peer dirs are honored only inside them
    );
    expect(view.valid).toBe(true);
    expect(view.problems).toEqual([]);
    expect(view.outbound).toEqual({ dir: "/drops/out", source: "peer", problem: null });
    expect(view.inbound).toEqual({ dir: "/drops/in", source: "peer", problem: null });
  });

  it("falls back to the instance env when the peer configures nothing — today's behavior", () => {
    for (const peer of [null, { name: "plain-peer", deliveryTarget: null }]) {
      const view = resolveDeliveryTarget(peer, { outDir: "/env/out", inDir: "/env/in" });
      expect(view.valid).toBe(true);
      expect(view.outbound).toEqual({ dir: "/env/out", source: "env", problem: null });
      expect(view.inbound).toEqual({ dir: "/env/in", source: "env", problem: null });
    }
  });

  it("resolves per DIRECTION independently (peer outDir + env inDir mix)", () => {
    const view = resolveDeliveryTarget(
      { name: "mixed", deliveryTarget: fsTarget({ outDir: "/drops/out" }) },
      { outDir: "/env/out", inDir: "/env/in" },
      ["/drops"]
    );
    expect(view.valid).toBe(true);
    expect(view.outbound).toEqual({ dir: "/drops/out", source: "peer", problem: null });
    expect(view.inbound).toEqual({ dir: "/env/in", source: "env", problem: null });
  });

  it("BOTH absent -> per-gap fail-closed problems NAMING each gap (peer + env var)", () => {
    const view = resolveDeliveryTarget({ name: "gapped", deliveryTarget: null }, {});
    expect(view.valid).toBe(false);
    expect(view.problems).toHaveLength(2);
    expect(view.outbound.dir).toBeNull();
    expect(view.outbound.problem).toContain("peer 'gapped'");
    expect(view.outbound.problem).toContain("SCP_RELAY_OUT_DIR");
    expect(view.outbound.problem).toContain("fail-closed");
    expect(view.inbound.problem).toContain("SCP_RELAY_IN_DIR");
  });

  it("no peer in play + no env -> problems name the env vars", () => {
    const view = resolveDeliveryTarget(null, {});
    expect(view.valid).toBe(false);
    expect(view.outbound.problem).toContain("SCP_RELAY_OUT_DIR");
    expect(view.inbound.problem).toContain("SCP_RELAY_IN_DIR");
  });

  it("a hostile STORED dir (relative / traversal) is a fail-closed problem and NEVER falls back to env", () => {
    for (const hostile of ["relative/dir", "/inbox/../../etc", "/inbox/./x/.."]) {
      const view = resolveDeliveryTarget(
        { name: "tampered", deliveryTarget: fsTarget({ outDir: hostile }) },
        { outDir: "/env/out", inDir: "/env/in" }
      );
      expect(view.valid).toBe(false);
      expect(view.outbound.dir).toBeNull(); // no silent env fallback masking the misconfig
      expect(view.outbound.problem).toContain("not an absolute, traversal-free");
      // The untouched direction still resolves normally.
      expect(view.inbound.dir).toBe("/env/in");
    }
  });

  it("require*Dir throws a 400 problem carrying the named gap", () => {
    const view = resolveDeliveryTarget({ name: "gapped", deliveryTarget: null }, {});
    expect(problemDetail(() => requireOutboundDir(view))).toContain("SCP_RELAY_OUT_DIR");
    expect(problemDetail(() => requireInboundDir(view))).toContain("SCP_RELAY_IN_DIR");
  });
});

describe("DeliveryTargetSchema — config-time validation (the same predicate, at the API edge)", () => {
  it("accepts absolute traversal-free dirs; refuses relative and traversal-bearing ones", () => {
    expect(
      DeliveryTargetSchema.safeParse(fsTarget({ outDir: "/drops/out", inDir: "/drops/in" })).success
    ).toBe(true);
    for (const bad of ["relative/dir", "/in/../out", "/in/.", "../up"]) {
      expect(DeliveryTargetSchema.safeParse(fsTarget({ inDir: bad })).success).toBe(false);
      expect(DeliveryTargetSchema.safeParse(fsTarget({ outDir: bad })).success).toBe(false);
    }
  });
});

describe("SCP_DELIVERY_ROOTS — the operator root bound on per-peer dirs (#110 pattern)", () => {
  const rootedPeer = (dir: string) => ({ name: "tenant", deliveryTarget: fsTarget({ outDir: dir }) });

  it("parseDeliveryRoots: comma/colon-separated absolutes, normalized; non-absolute dropped", () => {
    expect(parseDeliveryRoots("/a,/b:/c")).toEqual(["/a", "/b", "/c"]);
    expect(parseDeliveryRoots(" /a , /b ")).toEqual(["/a", "/b"]);
    expect(parseDeliveryRoots("/data/roots/../escape")).toEqual(["/data/escape"]); // normalized
    expect(parseDeliveryRoots("relative,,  ")).toEqual([]); // non-absolute + empties dropped
    expect(parseDeliveryRoots(undefined)).toEqual([]);
  });

  it("isUnderDeliveryRoot: segment-safe — honors nested, rejects the /root-evil prefix trick", () => {
    expect(isUnderDeliveryRoot("/root", ["/root"])).toBe(true); // the root itself
    expect(isUnderDeliveryRoot("/root/sub/x", ["/root"])).toBe(true);
    expect(isUnderDeliveryRoot("/root-evil", ["/root"])).toBe(false); // sibling, NOT under /root
    expect(isUnderDeliveryRoot("/root-evil/x", ["/root"])).toBe(false);
    expect(isUnderDeliveryRoot("/other", ["/root"])).toBe(false);
  });

  it("a per-peer dir INSIDE a declared root is honored (source 'peer')", () => {
    const view = resolveDeliveryTarget(rootedPeer("/roots/tenant-a/out"), {}, ["/roots"]);
    // Outbound (the configured direction) resolves cleanly; inbound is intentionally unset here.
    expect(view.outbound).toEqual({ dir: "/roots/tenant-a/out", source: "peer", problem: null });
  });

  it("a per-peer dir OUTSIDE every declared root is a fail-closed problem — NEVER an env fallback", () => {
    const view = resolveDeliveryTarget(
      rootedPeer("/etc/other-tenant-in"),
      { outDir: "/env/out" }, // env fallback present — must NOT mask the out-of-root dir
      ["/roots"]
    );
    expect(view.valid).toBe(false);
    expect(view.outbound.dir).toBeNull();
    expect(view.outbound.source).toBeNull();
    expect(view.outbound.problem).toContain("outside every operator-declared delivery root");
    expect(view.outbound.problem).toContain("SCP_DELIVERY_ROOTS");
  });

  it("the /root-evil prefix trick does NOT satisfy the /root root (fail-closed)", () => {
    const view = resolveDeliveryTarget(rootedPeer("/root-evil/drop"), {}, ["/root"]);
    expect(view.valid).toBe(false);
    expect(view.outbound.dir).toBeNull();
    expect(view.outbound.problem).toContain("outside every operator-declared delivery root");
  });

  it("UNSET roots + a per-peer dir => FAIL-CLOSED (the honest multi-tenant default)", () => {
    const view = resolveDeliveryTarget(rootedPeer("/anywhere/writable"), { outDir: "/env/out" }, []);
    expect(view.valid).toBe(false);
    expect(view.outbound.dir).toBeNull();
    expect(view.outbound.problem).toContain("no operator delivery roots are declared");
    expect(view.outbound.problem).toContain("SCP_DELIVERY_ROOTS is unset");
  });

  it("ENV-FALLBACK (no per-peer dir) works with roots UNSET — single-org deploys need no new config", () => {
    for (const peer of [null, { name: "plain", deliveryTarget: null }]) {
      const view = resolveDeliveryTarget(peer, { outDir: "/env/out", inDir: "/env/in" }, []);
      expect(view.valid).toBe(true);
      expect(view.outbound).toEqual({ dir: "/env/out", source: "env", problem: null });
      expect(view.inbound).toEqual({ dir: "/env/in", source: "env", problem: null });
    }
  });

  describe("assertDeliveryTargetRooted — the pair-time gate", () => {
    it("accepts an in-root dir; passes null/undefined through (clear/preserve — env fallback)", () => {
      expect(() =>
        assertDeliveryTargetRooted(fsTarget({ outDir: "/roots/a/out" }), ["/roots"])
      ).not.toThrow();
      expect(() => assertDeliveryTargetRooted(null, [])).not.toThrow();
      expect(() => assertDeliveryTargetRooted(undefined, [])).not.toThrow();
    });

    it("refuses an out-of-root dir at pair time (never stored)", () => {
      expect(problemDetail(() =>
        assertDeliveryTargetRooted(fsTarget({ inDir: "/etc/victim-in" }), ["/roots"])
      )).toContain("outside every operator-declared delivery root");
    });

    it("refuses the /root-evil prefix trick at pair time", () => {
      expect(problemDetail(() =>
        assertDeliveryTargetRooted(fsTarget({ outDir: "/root-evil/out" }), ["/root"])
      )).toContain("outside every operator-declared delivery root");
    });

    it("UNSET roots + a per-peer dir => refused at pair time (fail-closed default)", () => {
      expect(problemDetail(() =>
        assertDeliveryTargetRooted(fsTarget({ outDir: "/somewhere" }), [])
      )).toContain("no operator delivery roots are declared");
    });
  });
});

describe("dropDeliveryFile — the filesystem write seam", () => {
  it("writes into the resolved outbound dir (creating it) and returns the absolute path", async () => {
    const base = await tempDir();
    const outDir = path.join(base, "not-yet-created");
    const view = resolveDeliveryTarget({ name: "p", deliveryTarget: fsTarget({ outDir }) }, {}, [
      base
    ]);
    const written = await dropDeliveryFile(view, "bundle.scpbundle", "{}");
    expect(written).toBe(path.join(outDir, "bundle.scpbundle"));
  });

  it("refuses a traversal-hostile file NAME (the resolveUnderDir guard survives)", async () => {
    const outDir = await tempDir();
    const view = resolveDeliveryTarget({ name: "p", deliveryTarget: fsTarget({ outDir }) }, {}, [
      outDir
    ]);
    expect(await rejectedDetail(dropDeliveryFile(view, "../escape.scpbundle", "{}"))).toContain(
      "does not resolve inside"
    );
  });
});

describe("listInbox — the §13.1a read surface: names only, no traversal", () => {
  it("lists regular-file NAMES (sorted); subdirectories and nested paths never appear", async () => {
    const inDir = await tempDir();
    await writeFile(path.join(inDir, "b-relay.tar.gz"), "x");
    await writeFile(path.join(inDir, "a-bundle.scpbundle"), "{}");
    await mkdir(path.join(inDir, "subdir"));
    await writeFile(path.join(inDir, "subdir", "nested.scpbundle"), "{}");
    const names = await listInbox({ name: "p", deliveryTarget: fsTarget({ inDir }) }, {}, [inDir]);
    expect(names).toEqual(["a-bundle.scpbundle", "b-relay.tar.gz"]);
  });

  it("an inbox that does not exist yet lists as empty (nothing has arrived)", async () => {
    const base = await tempDir();
    const names = await listInbox(
      { name: "p", deliveryTarget: fsTarget({ inDir: path.join(base, "never-created") }) },
      {},
      [base]
    );
    expect(names).toEqual([]);
  });

  it("a traversal-hostile stored inDir REFUSES the listing fail-closed (no env fallback)", async () => {
    expect(
      await rejectedDetail(
        listInbox(
          { name: "tampered", deliveryTarget: fsTarget({ inDir: "/inbox/../../etc" }) },
          { inDir: "/env/in" }
        )
      )
    ).toContain("not an absolute, traversal-free");
  });

  it("an unresolvable inbound direction refuses with the named gap", async () => {
    expect(await rejectedDetail(listInbox({ name: "gapped", deliveryTarget: null }, {}))).toContain(
      "SCP_RELAY_IN_DIR"
    );
  });
});

// ===========================================================================================
// M13.2b — the s3-compatible provider: the endpoint/bucket allowlist (ADR-0019 §4 symmetry) and
// the fail-closed resolution. The MinIO round-trip (put/list/get + multipart) is proven in the
// integration suite; these unit tests pin the ALLOWLIST predicate + the fail-closed resolution.
// ===========================================================================================

const s3Target = (t: {
  endpoint: string;
  bucket: string;
  outPrefix?: string;
  inPrefix?: string;
}) => ({ provider: "s3-compatible" as const, ...t });

const s3Peer = (t: { endpoint: string; bucket: string; outPrefix?: string; inPrefix?: string }) => ({
  name: "s3-tenant",
  deliveryTarget: s3Target(t)
});

describe("SCP_DELIVERY_S3_ENDPOINTS — the endpoint/bucket allowlist (endpoint-shaped, NOT path-shaped)", () => {
  it("parseDeliveryS3Endpoints: comma/newline-separated; endpoint normalized to origin; +bucket pins", () => {
    expect(parseDeliveryS3Endpoints("https://minio.a:9000, https://minio.b:9000+bundles")).toEqual([
      { origin: "https://minio.a:9000", bucket: null },
      { origin: "https://minio.b:9000", bucket: "bundles" }
    ]);
    // Colons inside the URL are NOT entry separators (unlike SCP_DELIVERY_ROOTS): a lone endpoint
    // with a port survives as one entry.
    expect(parseDeliveryS3Endpoints("https://host:9000")).toEqual([
      { origin: "https://host:9000", bucket: null }
    ]);
    // Trailing path / uppercase host normalize to the bare origin (lowercased).
    expect(parseDeliveryS3Endpoints("https://MinIO.A:9000/ignored/path")).toEqual([
      { origin: "https://minio.a:9000", bucket: null }
    ]);
    expect(parseDeliveryS3Endpoints("not-a-url, ,  ")).toEqual([]); // unparseable + empties dropped
    expect(parseDeliveryS3Endpoints(undefined)).toEqual([]);
  });

  it("normalizeS3Origin: absolute http(s) only; strips path; lowercases host; rejects other schemes", () => {
    expect(normalizeS3Origin("https://Host:9000/x")).toBe("https://host:9000");
    expect(normalizeS3Origin("http://h")).toBe("http://h");
    expect(normalizeS3Origin("ftp://h")).toBeNull();
    expect(normalizeS3Origin("relative")).toBeNull();
  });

  it("isDeliveryS3EndpointAllowed: origin EQUALITY (never string-prefix), bucket-pin honored", () => {
    const allow = parseDeliveryS3Endpoints("https://minio:9000, https://pinned:9000+only");
    // Allowed: endpoint with no bucket-pin → any bucket.
    expect(isDeliveryS3EndpointAllowed("https://minio:9000", "anything", allow)).toBe(true);
    // Prefix-trick: a look-alike host must NOT match by string prefix.
    expect(isDeliveryS3EndpointAllowed("https://minio:9000.evil.net", "b", allow)).toBe(false);
    expect(isDeliveryS3EndpointAllowed("https://minio:90000", "b", allow)).toBe(false);
    // Bucket-pin: only the exact bucket at that endpoint is allowed.
    expect(isDeliveryS3EndpointAllowed("https://pinned:9000", "only", allow)).toBe(true);
    expect(isDeliveryS3EndpointAllowed("https://pinned:9000", "other", allow)).toBe(false);
    // Empty allowlist → nothing allowed (fail-closed).
    expect(isDeliveryS3EndpointAllowed("https://minio:9000", "b", [])).toBe(false);
  });
});

describe("resolveDeliveryTarget — s3-compatible (allowlist-gated, fail-closed)", () => {
  const allow = parseDeliveryS3Endpoints("https://minio:9000");

  it("an ALLOWLISTED endpoint resolves both directions; prefix normalized to end with '/'", () => {
    const view = resolveDeliveryTarget(
      s3Peer({ endpoint: "https://minio:9000", bucket: "drop", outPrefix: "out", inPrefix: "in/" }),
      {},
      [],
      allow
    );
    expect(view.provider).toBe("s3-compatible");
    expect(view.valid).toBe(true);
    expect(view.outboundS3).toEqual({ endpoint: "https://minio:9000", bucket: "drop", prefix: "out/" });
    expect(view.inboundS3).toEqual({ endpoint: "https://minio:9000", bucket: "drop", prefix: "in/" });
    // The filesystem-shaped direction stays byte-identical (dir null, no problem) — census: fs
    // consumers keyed on `.dir` correctly skip s3 rather than misread it.
    expect(view.outbound).toEqual({ dir: null, source: "peer", problem: null });
  });

  it("omitted prefixes resolve to the bucket ROOT ('')", () => {
    const view = resolveDeliveryTarget(
      s3Peer({ endpoint: "https://minio:9000", bucket: "drop" }),
      {},
      [],
      allow
    );
    expect(view.outboundS3?.prefix).toBe("");
    expect(view.inboundS3?.prefix).toBe("");
  });

  it("UNSET allowlist + an s3 target => FAIL-CLOSED (both directions), never used", () => {
    const view = resolveDeliveryTarget(
      s3Peer({ endpoint: "https://minio:9000", bucket: "drop" }),
      {},
      [],
      []
    );
    expect(view.valid).toBe(false);
    expect(view.outboundS3).toBeNull();
    expect(view.inboundS3).toBeNull();
    expect(view.outbound.problem).toContain("SCP_DELIVERY_S3_ENDPOINTS is unset");
    expect(view.inbound.problem).toContain("SCP_DELIVERY_S3_ENDPOINTS is unset");
  });

  it("an OUT-OF-ALLOWLIST endpoint is a fail-closed problem (both directions), never used", () => {
    const view = resolveDeliveryTarget(
      s3Peer({ endpoint: "https://evil:9000", bucket: "drop" }),
      {},
      [],
      allow
    );
    expect(view.valid).toBe(false);
    expect(view.outboundS3).toBeNull();
    expect(view.outbound.problem).toContain("not in the operator s3 delivery allowlist");
  });
});

describe("assertDeliveryTargetRooted — the pair-time gate, s3 sibling", () => {
  const allow = parseDeliveryS3Endpoints("https://minio:9000+bundles");

  it("accepts an allowlisted s3 target (endpoint+bucket pin satisfied)", () => {
    expect(() =>
      assertDeliveryTargetRooted(
        s3Target({ endpoint: "https://minio:9000", bucket: "bundles" }),
        [],
        allow
      )
    ).not.toThrow();
  });

  it("refuses an out-of-allowlist s3 target at pair time (never stored)", () => {
    expect(
      problemDetail(() =>
        assertDeliveryTargetRooted(
          s3Target({ endpoint: "https://minio:9000", bucket: "other" }),
          [],
          allow
        )
      )
    ).toContain("not in the operator s3 delivery allowlist");
  });

  it("UNSET allowlist + an s3 target => refused at pair time (fail-closed default)", () => {
    expect(
      problemDetail(() =>
        assertDeliveryTargetRooted(s3Target({ endpoint: "https://minio:9000", bucket: "b" }), [], [])
      )
    ).toContain("no operator s3 delivery endpoints are declared");
  });
});

describe("delivery credentials (ADR-0019 §3 artifact-store class)", () => {
  it("deliveryTargetSecretKey: per-peer, per-direction, lowercased", () => {
    expect(deliveryTargetSecretKey("High-Side", "out")).toBe("delivery/high-side/out");
    expect(deliveryTargetSecretKey("high-side", "in")).toBe("delivery/high-side/in");
  });

  it("parseDeliveryS3Credential: first-colon split; malformed => null (fail-closed)", () => {
    expect(parseDeliveryS3Credential("AKID:secret/with+base64=chars")).toEqual({
      accessKeyId: "AKID",
      secretAccessKey: "secret/with+base64=chars"
    });
    expect(parseDeliveryS3Credential("no-colon")).toBeNull();
    expect(parseDeliveryS3Credential(":secret")).toBeNull();
    expect(parseDeliveryS3Credential("akid:")).toBeNull();
    expect(parseDeliveryS3Credential(undefined)).toBeNull();
  });
});
