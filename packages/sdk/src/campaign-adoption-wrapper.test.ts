import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "./client.js";
import { ScpResponseValidationError } from "./errors.js";

/**
 * M25.5 — `client.campaigns.adoption()`, "has each of this campaign's components migrated yet?".
 * `GET /campaigns/{id}/adoption` already existed; only the hand-written `ScpClient` wrapper (and
 * the CLI command on top of it) was missing.
 *
 * Driven through the REAL generated client against a loopback HTTP server, same harness as
 * `dependency-read-surface-wrappers.test.ts` — DELETE THE WIRING: this test dies if the wrapper
 * line is removed from `client.ts` or points at the wrong generated request.
 */

const CAMPAIGN_ID = "77777777-7777-4777-8777-777777777777";

function wellFormedCampaignAdoption(): unknown {
  return {
    campaignObjectId: CAMPAIGN_ID,
    evidence: { kind: "delivered" },
    targets: [
      {
        targetObjectId: "88888888-8888-4888-8888-888888888888",
        targetUrn: "urn:scp:component:checkout-api",
        targetName: "checkout-api",
        verdict: "adopted",
        summary: "delivered at 2026-08-30",
        observations: ["change delivered at 2026-08-30T12:00:00Z"]
      }
    ],
    unresolvedTargets: []
  };
}

describe("SDK wiring: client.campaigns.adoption()", () => {
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

  it("GETs /campaigns/{id}/adoption and returns the body verbatim", async () => {
    body = wellFormedCampaignAdoption();

    const result = await client().campaigns.adoption(CAMPAIGN_ID);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    const url = new URL(requests[0]?.url ?? "", baseUrl);
    expect(url.pathname).toBe(`/campaigns/${CAMPAIGN_ID}/adoption`);
    expect(result).toEqual(wellFormedCampaignAdoption());
    expect(result.targets[0]?.verdict).toBe("adopted");
  });

  it("sits behind the response validator (ADR-0023) — a body missing `targets` is refused", async () => {
    const malformed = wellFormedCampaignAdoption() as { targets?: unknown };
    delete malformed.targets;
    body = malformed;
    const err = (await client()
      .campaigns.adoption(CAMPAIGN_ID)
      .catch((e: unknown) => e)) as ScpResponseValidationError;
    expect(err).toBeInstanceOf(ScpResponseValidationError);
    expect(err.operation).toBe("GET /campaigns/{id}/adoption");
    expect(err.issues.map((i) => i.path)).toContain("targets");
  });
});
