/** Wires this plugin into the generic executor conformance suite. See docs/plugins.md §546. */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import nock from "nock";
import { runExecutorConformanceSuite, mkdtempTracked } from "@scp/plugin-testkit";
import { createTerraformExecutorPlugin } from "./index.js";
import { realHttpPluginContext } from "./test-support/real-http-client.js";

const BASE_URL = "http://pipeline.test";

beforeAll(() => {
  nock.disableNetConnect();
  // A UNIQUE run id per POST — so the cross-restart dedup conformance test (MAJOR #4) is
  // non-vacuous: a broken (non-durable) dedup would POST again and get a DIFFERENT id, while a
  // durable one returns the cached id without POSTing. A constant id would let a broken dedup
  // pass by coincidence.
  nock(BASE_URL)
    .persist()
    .post("/trigger")
    .reply(200, () => ({ id: `run-${randomUUID()}` }));
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
  const statePath = join(
    await mkdtempTracked(join(tmpdir(), "terraform-conformance-")),
    "state.json"
  );
  const build = (): {
    plugin: ReturnType<typeof createTerraformExecutorPlugin>;
    ctx: ReturnType<typeof realHttpPluginContext>;
  } => ({
    plugin: createTerraformExecutorPlugin(),
    ctx: realHttpPluginContext({
      triggerUrl: `${BASE_URL}/trigger`,
      statusUrl: `${BASE_URL}/status/{externalId}`,
      abortUrl: `${BASE_URL}/abort/{externalId}`,
      // statePath makes dedup durable across the simulated restart (MAJOR #4).
      statePath
    })
  });
  return { ...build(), restart: async () => build() };
});
