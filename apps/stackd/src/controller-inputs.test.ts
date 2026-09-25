import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * WHAT CAN REACH THE CONTROLLER (M29.4 security census, ADR-0058).
 *
 * The controller holds near-cluster-admin rights, so the M28 lesson applies in full: a value that
 * decides what it applies must not be writable by anyone who could not otherwise grant cluster
 * rights. Its inputs are exactly:
 *   1. the stack SPEC, read through ONE API operation (`stack.spec`), whose schema carries no free
 *      string (packages/schemas `stack-spec-census.test.ts`), written only through the operator
 *      tier (apps/server `stack.integration.test.ts`, drizzle/0126);
 *   2. its own image (chart, helm pin) and deploy-time env / image-retarget file (`release.ts`,
 *      `values.test.ts`'s census).
 * This file holds the SOURCE to (1): the controller builds one API client, uses four operations on
 * it — read the spec, write the status, and (M29.2) hand a wiring over and withdraw it — and has no
 * other network path to scpd. And to the one thing M29.2 added that reaches OUT: the client for the
 * backends' own APIs (`backend-http.ts`) is called only by `wiring.ts`, and only with URLs built
 * from an endpoint the controller derived from its own render.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(HERE)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, text: readFileSync(path.join(HERE, f), "utf8") }));

/** Strips // and /* *\/ comments, so a commented-out call is not counted as code. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the stack controller's inputs", () => {
  it("finds the controller's sources (known-positive control)", () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        "controller.ts",
        "reconcile.ts",
        "values.ts",
        "release.ts",
        "main.ts"
      ])
    );
  });

  it("constructs exactly one API client, in controller.ts, with no session token", () => {
    const sites = sources.filter((s) => /new ScpClient\(/.test(code(s.text)));
    expect(sites.map((s) => s.file)).toEqual(["controller.ts"]);
    const ctor = /new ScpClient\(([^)]*)\)/.exec(code(sites[0]!.text))![1]!;
    expect(ctor.replace(/\s/g, "")).toBe("{baseUrl}");
  });

  it("calls exactly seven API operations: the spec read, the status write, the wiring hand-off and its withdrawal, and (M29.5) the sealing key, the sealed deliveries and their confirmation", () => {
    const calls = new Set<string>();
    for (const s of sources) {
      for (const m of code(s.text).matchAll(/client\.(\w+)\.(\w+)\(/g))
        calls.add(`${m[1]}.${m[2]}`);
      for (const m of code(s.text).matchAll(/client\.(\w+)\(/g)) calls.add(m[1]!);
    }
    expect([...calls].sort()).toEqual([
      "stack.ackCredentialDelivery",
      "stack.credentialDeliveries",
      "stack.deleteWiring",
      "stack.putSealingKey",
      "stack.putStatus",
      "stack.putWiring",
      "stack.spec"
    ]);
  });

  it("has no other way to reach scpd: no fetch, no undici, no ad-hoc HTTP client to the API", () => {
    for (const s of sources) {
      const c = code(s.text);
      expect(c, `${s.file} calls fetch`).not.toMatch(/\bfetch\(/);
      expect(c, `${s.file} imports undici`).not.toMatch(/from "undici"/);
    }
    // node:http(s) is the Kubernetes transport, the health server and (M29.2) the backends' own
    // APIs — and only there.
    const httpUsers = sources
      .filter((s) => /from "node:https?"/.test(code(s.text)))
      .map((s) => s.file)
      .sort();
    expect(httpUsers).toEqual(["backend-http.ts", "kube.ts", "main.ts"]);
  });

  it("the backend HTTP client is used only by wiring.ts, and only against an endpoint derived from the render", () => {
    const users = sources
      .filter(
        (s) =>
          s.file !== "backend-http.ts" &&
          /\bnodeBackendHttp\(|\.http\b|requireHttp\(/.test(code(s.text))
      )
      .map((s) => s.file)
      .sort();
    // controller.ts constructs it; wiring.ts is its only caller.
    expect(users).toEqual(["controller.ts", "wiring.ts"]);
    const wiring = code(sources.find((s) => s.file === "wiring.ts")!.text);
    const urls = [...wiring.matchAll(/\burl:\s*([^,\n]+)/g)].map((m) => m[1]!.trim());
    expect(urls.length).toBeGreaterThan(5);
    for (const u of urls) expect(u, u).toMatch(/^`\$\{ep\.serverUrl\}\//);
    // …and `ep` only ever comes from backendEndpoint (the render) or the unwire's fixed Service.
    expect(wiring).toMatch(/const ep = backendEndpoint\(deps\.release, backend, objects\)/);
  });

  it("reads from the spec only its enumerated fields: backend, enabled, sizeTier, purgeGeneration, the settings and the integrity digests", () => {
    const fields = new Set<string>();
    for (const s of sources) {
      for (const m of code(s.text).matchAll(/\bspec\.(\w+)/g)) fields.add(m[1]!);
      for (const m of code(s.text).matchAll(/\bsettings\.(\w+)/g)) fields.add(`settings.${m[1]}`);
    }
    // `spec.settings` / `spec.backends` are the document; the rest are StackBackendSpec's fields.
    // (`spec.group` / `spec.versions` / `spec.template` read RENDERED objects' spec, not the API's.)
    const allowed = new Set([
      "settings",
      "backends",
      "backend",
      "enabled",
      "sizeTier",
      // A counter: a purge acts only when it exceeds what the controller last acted on.
      "purgeGeneration",
      // sha256 hex or null (stack-spec-census): only ever COMPARED with the controller's own
      // digests, so it can make the controller refuse its stored state, never act on other state.
      "integrity",
      "settings.updatePolicy",
      "settings.upgradeGeneration",
      // M29.2: a counter — a rotation acts only when it exceeds what the recorded wiring satisfied.
      "rotateGeneration",
      // M29.2: per backend, a sha256 and a counter (stack-spec-census) — compared with the hash of
      // facts the controller derives itself; it can make the controller re-wire, never re-point.
      "wiring",
      // M29.5: a sha256 or null — compared with the controller's own key id, it can make the
      // controller re-publish its PUBLIC key, never use another.
      "credentialSealingKeySha256",
      // M29.5: enumerated slot + enumerated provider + that provider's anchored pattern
      // (stack-spec-census), re-validated by `validWorkloadIdentities` before it is used.
      "workloadIdentities",
      "group",
      "versions",
      "replicas",
      "template"
    ]);
    expect([...fields].filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("M29.5: a sealed delivery reaches exactly one writer, whose namespace is derived from the backend and whose Secret and key are held to the catalog", () => {
    const creds = code(sources.find((s) => s.file === "credentials.ts")!.text);
    // The deliveries are read in one place, and each is re-parsed there.
    const readers = sources
      .filter((s) => /\.credentialDeliveries\(/.test(code(s.text)))
      .map((s) => s.file)
      .sort();
    expect(readers).toEqual(["controller.ts", "credentials.ts"]);
    expect(creds).toMatch(/StackCredentialDeliverySchema\.safeParse\(item\)/);
    // The write step: the namespace is the backend's own, the target is a catalog entry.
    const writer = creds.slice(creds.indexOf("export async function writeCredential"));
    expect(writer).toMatch(/if \(!isCatalogTarget\(d\.backend, d\.secretName, d\.key\)\)/);
    expect(writer).toMatch(/const namespace = backendNamespace\(deps\.release, d\.backend/);
    // …and nothing else in the controller writes a backend Secret from a delivery.
    const writers = sources
      .filter((s) => /\bwriteCredential\(/.test(code(s.text)))
      .map((s) => s.file)
      .sort();
    expect(writers).toEqual(["credentials.ts"]);
    // The opened value is never logged: no log line in credentials.ts interpolates it.
    for (const m of creds.matchAll(/deps\.log\(([\s\S]*?)\);/g)) {
      expect(m[1], m[1]).not.toMatch(/plaintext|opened\.|\bvalue\b/);
    }
  });
});
