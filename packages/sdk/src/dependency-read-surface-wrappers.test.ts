import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "./client.js";
import { ScpResponseValidationError } from "./errors.js";

/**
 * M21.6 — the two dependency READ wrappers, `dependencySubscriptions.inventory()` and
 * `dependencySubscriptions.bumps()`, driven through the REAL generated client against a loopback
 * HTTP server (the same harness as `response-validation.test.ts`).
 *
 * DELETE-THE-WIRING: each test dies if its wrapper line is removed from `client.ts` (the method is
 * gone), if the wrapper is pointed at the wrong generated request (the recorded URL changes), or if
 * the wrapper stops passing the path/query through (the recorded URL loses the id or the page
 * query). The response bodies are well-formed on purpose: `sdk.gen.ts`'s per-operation
 * `responseValidator` runs on this path too, so a body the schema refuses would fail the test for
 * the WRONG reason — and the last case pins that the validator IS on this path.
 */

const COMPONENT_ID = "33333333-3333-4333-8333-333333333333";
const LINE_ID = "44444444-4444-4444-8444-444444444444";
const CHANGE_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "66666666-6666-4666-8666-666666666666";

interface JsonObject {
  [key: string]: unknown;
}

function subject(): JsonObject {
  return { id: COMPONENT_ID, name: "checkout-api", domainId: null };
}

/** A well-formed `ComponentDependencyInventoryResponse` with one row. */
function wellFormedInventory(): JsonObject {
  return {
    component: subject(),
    ingestion: null,
    lastIngestionDecision: null,
    componentGate: { enabled: true, reason: "enabled", contributions: [] },
    rows: [
      {
        line: {
          id: LINE_ID,
          ecosystem: "npm",
          coordinate: "@acme/lib",
          major: "1",
          tagPattern: null
        },
        manifestPath: "package.json",
        declaredVersion: "^1.2.3",
        resolvedVersion: "1.2.3",
        resolvedDigest: null,
        observedRepo: "acme/checkout-api",
        observedRef: "refs/heads/main",
        observedAt: "2026-08-16T12:00:00Z",
        head: {
          latestVersion: "1.4.0",
          latestDigest: null,
          latestObservedAt: "2026-08-16T11:00:00Z"
        },
        producer: null,
        subscription: {
          enabled: true,
          reason: "enabled",
          granularity: "patch",
          delivery: "pull_request",
          contributions: []
        }
      }
    ],
    nextCursor: null
  };
}

/** A well-formed `ComponentDependencyBumpsResponse` with one row. */
function wellFormedBumps(): JsonObject {
  return {
    component: subject(),
    rows: [
      {
        changeId: CHANGE_ID,
        changeName: "bump @acme/lib 1.2.3 → 1.4.0",
        line: { id: LINE_ID, ecosystem: "npm", coordinate: "@acme/lib", major: "1" },
        manifestPath: "package.json",
        fromVersion: "1.2.3",
        toVersion: "1.4.0",
        repo: "acme/checkout-api",
        baseBranch: "main",
        authoredRef: `refs/heads/scp/dep-bump/${CHANGE_ID}`,
        pullRequestNumber: 42,
        pullRequestUrl: null,
        headCommit: null,
        dispatchedAt: "2026-08-16T12:00:00Z",
        mergedAt: null,
        delivery: "pull_request",
        deliveryReason: "first look is always a pull request",
        merge: { verdict: "withheld", decisionId: DECISION_ID, evaluatedAt: "2026-08-16T12:05:00Z" }
      }
    ],
    nextCursor: null
  };
}

describe("SDK dependencySubscriptions read wrappers (M21.6)", () => {
  let server: Server;
  let baseUrl: string;
  let body: unknown;
  let requests: { method: string | undefined; url: string | undefined }[];

  beforeEach(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  });

  function client(): ScpClient {
    return new ScpClient({ baseUrl });
  }

  it("inventory() GETs /components/{idOrUrn}/dependency-inventory with the page query and returns the body", async () => {
    body = wellFormedInventory();

    const result = await client().dependencySubscriptions.inventory(COMPONENT_ID, {
      limit: 50,
      cursor: "abc"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    const url = new URL(requests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe(`/components/${COMPONENT_ID}/dependency-inventory`);
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("abc");
    expect(result).toEqual(wellFormedInventory());
    // The coordinate travels verbatim — never slugified on the way back either.
    expect(result.rows[0]?.line.coordinate).toBe("@acme/lib");
  });

  it("inventory() accepts a URN and sends no page query when none is given", async () => {
    body = wellFormedInventory();
    const urn = "urn:scp:component:checkout-api";

    await client().dependencySubscriptions.inventory(urn);

    const url = new URL(requests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe(`/components/${encodeURIComponent(urn)}/dependency-inventory`);
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it("bumps() GETs /components/{idOrUrn}/dependency-bumps with the page query and returns the body", async () => {
    body = wellFormedBumps();

    const result = await client().dependencySubscriptions.bumps(COMPONENT_ID, { limit: 5 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    const url = new URL(requests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe(`/components/${COMPONENT_ID}/dependency-bumps`);
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(result).toEqual(wellFormedBumps());
    // `pullRequestUrl` is a typed slot, not composed from repo + number.
    expect(result.rows[0]?.pullRequestUrl).toBeNull();
  });

  it("both wrappers sit behind the response validator (ADR-0023) — a body missing `rows` is refused, naming the operation", async () => {
    const inventory = wellFormedInventory();
    delete inventory.rows;
    body = inventory;
    const invError = (await client()
      .dependencySubscriptions.inventory(COMPONENT_ID)
      .catch((e: unknown) => e)) as ScpResponseValidationError;
    expect(invError).toBeInstanceOf(ScpResponseValidationError);
    expect(invError.operation).toBe("GET /components/{idOrUrn}/dependency-inventory");
    expect(invError.issues.map((i) => i.path)).toContain("rows");

    const bumps = wellFormedBumps();
    delete bumps.rows;
    body = bumps;
    const bumpsError = (await client()
      .dependencySubscriptions.bumps(COMPONENT_ID)
      .catch((e: unknown) => e)) as ScpResponseValidationError;
    expect(bumpsError).toBeInstanceOf(ScpResponseValidationError);
    expect(bumpsError.operation).toBe("GET /components/{idOrUrn}/dependency-bumps");
    expect(bumpsError.issues.map((i) => i.path)).toContain("rows");
  });
});
