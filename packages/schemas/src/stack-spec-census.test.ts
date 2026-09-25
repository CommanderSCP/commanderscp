import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PutStackBackendRequestSchema,
  PutStackSettingsRequestSchema,
  PutStackWiringRequestSchema,
  StackSpecDocumentSchema
} from "./stack.js";
import { STACK_WORKLOAD_IDENTITY_PROVIDERS } from "./stack-credentials.js";

/**
 * THE STACK CONTROLLER'S INPUT HAS NO FREE STRING (M29.4, ADR-0058).
 *
 * The controller renders manifests from exactly the document below. Every leaf must be an enum, a
 * boolean or an integer; a plain string (a URL, a repo, an image, a "values" blob) would be a way
 * for whoever writes the spec to put content into what a near-cluster-admin process applies. The
 * operator writes the spec — but the M28 lesson is that the next field added "just for convenience"
 * is the hole, so the rule is enforced on the SCHEMA, where the next field lands.
 */

type Json = {
  type?: string | string[];
  pattern?: string;
  enum?: unknown[];
  properties?: Record<string, Json>;
  items?: Json;
  anyOf?: Json[];
  oneOf?: Json[];
  additionalProperties?: unknown;
  const?: unknown;
};

const SHA256_HEX = "^[0-9a-f]{64}$";

/** M29.5: a declared workload identity's identifier — an IAM role ARN, a Google service account
 *  email, a GUID — each bound by its provider's anchored pattern, and only at that one path. The
 *  controller writes it as an ANNOTATION VALUE on an object it builds itself (never through helm),
 *  so it cannot become YAML, a key or a different object. */
const IDENTIFIER_PATTERNS = new Set<string>(
  // As zod emits it: the RegExp source (which escapes `/`).
  Object.values(STACK_WORKLOAD_IDENTITY_PROVIDERS).map((p) => new RegExp(p.pattern).source)
);
const IDENTIFIER_PATH = /^\$\.workloadIdentities\[\]\|\d+\.identifier$/;

function leaves(schema: Json, at: string): { at: string; schema: Json }[] {
  if (schema.properties) {
    return Object.entries(schema.properties).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
  }
  if (schema.items) return leaves(schema.items, `${at}[]`);
  for (const alt of [schema.anyOf, schema.oneOf])
    if (alt) return alt.flatMap((s, i) => leaves(s, `${at}|${i}`));
  return [{ at, schema }];
}

function freeStringLeaves(s: z.ZodType): string[] {
  const json = z.toJSONSchema(s, { io: "input" }) as Json;
  return leaves(json, "$")
    .filter(({ at, schema }) => {
      if (schema.enum || schema.const !== undefined) return false;
      if (
        schema.type === "string" &&
        IDENTIFIER_PATH.test(at) &&
        schema.pattern !== undefined &&
        IDENTIFIER_PATTERNS.has(schema.pattern)
      )
        return false;
      // A sha256 in lowercase hex is the one permitted string: it can only be COMPARED against
      // bytes the controller already holds, never rendered into a manifest.
      if (schema.type === "string" && schema.pattern === SHA256_HEX) return false;
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      return !types.every((t) => t === "boolean" || t === "integer" || t === "null");
    })
    .map(({ at, schema }) => `${at}: ${JSON.stringify(schema)}`);
}

describe("the stack spec is enumerated values only", () => {
  it("every leaf of the controller's input document is an enum, a boolean or an integer", () => {
    expect(freeStringLeaves(StackSpecDocumentSchema)).toEqual([]);
  });

  it("…and so is everything a write to it can carry", () => {
    expect(freeStringLeaves(PutStackBackendRequestSchema)).toEqual([]);
    expect(freeStringLeaves(PutStackSettingsRequestSchema)).toEqual([]);
  });

  it("M29.5: a workload identity's identifier is pattern-bound, and the exemption is that path and those patterns only", () => {
    // Every pattern is anchored at both ends, so no identifier can carry anything past it.
    for (const p of IDENTIFIER_PATTERNS) expect(p).toMatch(/^\^.*\$$/);
    // The same pattern anywhere else is still a free string.
    const pattern = [...IDENTIFIER_PATTERNS][0]!;
    const elsewhere = StackSpecDocumentSchema.extend({
      note: z.string().regex(new RegExp(pattern))
    });
    expect(freeStringLeaves(elsewhere)).toEqual([expect.stringMatching(/^\$\.note: /)]);
  });

  it("the census fires on a schema that has a free string (known-positive control)", () => {
    const widened = StackSpecDocumentSchema.extend({ carrierRepoUrl: z.string() });
    expect(freeStringLeaves(widened)).toEqual([expect.stringMatching(/^\$\.carrierRepoUrl: /)]);
  });

  it("M29.2: what scpd hands back of a wiring is a sha256 and a counter per backend — never an endpoint", () => {
    // Covered by the leaf walk above; pinned by name so a widened wiring entry is a named failure.
    const shape = z.toJSONSchema(StackSpecDocumentSchema, { io: "input" }) as unknown as {
      properties: { wiring: { items: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(shape.properties.wiring.items.properties).sort()).toEqual([
      "backend",
      "factsSha256",
      "rotationGeneration"
    ]);
  });

  it("M29.2: a wiring hand-off can only name an in-cluster Service — no path, no credentials, no other host", () => {
    const ok = (serverUrl: string) =>
      PutStackWiringRequestSchema.safeParse({
        serverUrl,
        namespace: null,
        caPem: null,
        account: "a",
        token: "t",
        factsSha256: "a".repeat(64),
        rotationGeneration: 0
      }).success;
    expect(ok("http://argocd-server.scp-argocd.svc")).toBe(true);
    expect(ok("https://argo-server.scp-argo-workflows.svc:2746")).toBe(true);
    expect(ok("http://scp-gitea-http.scp-gitea.svc.cluster.local:3000")).toBe(true);
    for (const bad of [
      "https://attacker.example.com",
      "http://argocd-server.scp-argocd.svc/api",
      "http://user:pw@argocd-server.scp-argocd.svc",
      "http://argocd-server.scp-argocd.svc?x=1",
      "ftp://argocd-server.scp-argocd.svc",
      "http://10.0.0.1"
    ]) {
      expect(ok(bad), bad).toBe(false);
    }
  });

  it("the write bodies are strict: an unknown key is refused, not silently dropped", () => {
    expect(
      PutStackBackendRequestSchema.safeParse({ enabled: true, values: { a: 1 } }).success
    ).toBe(false);
    expect(
      PutStackSettingsRequestSchema.safeParse({ updatePolicy: "manual", chart: "x" }).success
    ).toBe(false);
  });
});
