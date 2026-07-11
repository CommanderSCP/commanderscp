/**
 * Wires `@scp/plugin-terraform` into `@scp/plugin-testkit`'s generic `ExecutorPlugin`
 * conformance suite (BUILD_AND_TEST.md §4.2: "every shipped plugin runs the relevant `@scp/
 * plugin-testkit` suite in its own package tests"). The suite itself lives in plugin-testkit and
 * knows nothing about terraform specifics — this file is only the fixture factory.
 *
 * Unlike the fake-executor/webhook-control conformance fixtures (which stub `ctx.http.request`
 * directly), this fixture backs `ctx.http` with `test-support/real-http-client.ts`'s REAL
 * `node:http`-based client and fixtures the wire with `nock` — Mode 1 (DESIGN.md §12) is
 * genuinely an HTTP-calling plugin, so this is the conformance fixture that proves the plugin's
 * ACTUAL network path (URL templating, response parsing) satisfies the generic contract, not a
 * hand-rolled stub standing in for it.
 *
 * The generic suite calls trigger/status/abort/observe in an order and cadence this file doesn't
 * control (and shouldn't need to know — that's the whole point of a shared conformance suite).
 * Every interceptor below is `.persist()`ed so it answers an unbounded number of times with one
 * deterministic, contract-satisfying response, rather than trying to predict exact call counts —
 * that precision belongs in index.test.ts, which asserts exact request shapes and exact call
 * counts for the dedup/idempotency behavior this suite only smoke-tests (see
 * plugin-testkit's own idempotencyKey conformance assertion, which this fixture also satisfies:
 * the SAME idempotencyKey reuses the module-level dedup cache and never re-POSTs).
 */
import { afterAll, beforeAll } from "vitest";
import nock from "nock";
import { runExecutorConformanceSuite } from "@scp/plugin-testkit";
import { createTerraformExecutorPlugin } from "./index.js";
import { realHttpPluginContext } from "./test-support/real-http-client.js";

const BASE_URL = "http://pipeline.test";

beforeAll(() => {
  nock.disableNetConnect();
  nock(BASE_URL).persist().post("/trigger").reply(200, { id: "run-conformance-1" });
  nock(BASE_URL)
    .persist()
    .get(/^\/status\//)
    .reply(200, { status: "applied" });
  nock(BASE_URL)
    .persist()
    .post(/^\/abort\//)
    .reply(200, {});
});

afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

runExecutorConformanceSuite("terraform", async () => {
  const plugin = createTerraformExecutorPlugin();
  const ctx = realHttpPluginContext({
    triggerUrl: `${BASE_URL}/trigger`,
    statusUrl: `${BASE_URL}/status/{externalId}`,
    abortUrl: `${BASE_URL}/abort/{externalId}`
  });
  return { plugin, ctx };
});
