import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "./app.js";
import { createDb, createPool } from "./db/client.js";
import { loadConfig } from "./config.js";

/** Snapshot every Object.prototype key, not three named ones. See docs/server.md §65. */
const OBJECT_PROTOTYPE_KEYS_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort().join(",");

/** The wiring test for the global JSON content-type parser. See docs/server.md §66. */

describe("app.ts JSON body parser", () => {
  let app: FastifyInstance;
  let pool: Pool;

  beforeAll(async () => {
    process.env.SCP_DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
    const config = loadConfig();
    pool = createPool(config.databaseUrl);
    app = await buildApp({ db: createDb(pool), config }, { logger: false });
    app.post("/__json_parser_probe", (request) => ({
      keys: Object.keys((request.body ?? {}) as object),
      sawRawBody: Buffer.isBuffer(request.rawBody)
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const post = (payload: string) =>
    app.inject({
      method: "POST",
      url: "/__json_parser_probe",
      headers: { "content-type": "application/json" },
      payload
    });

  describe("REFUSES prototype-poisoned bodies", () => {
    it.each([
      ["a top-level __proto__ key", '{"ok":1,"__proto__":{"polluted":"yes"}}'],
      ["a nested __proto__ key", '{"properties":{"__proto__":{"polluted":"yes"}}}'],
      ["a __proto__ key inside an array", '{"list":[{"__proto__":{"x":1}}]}'],
      ["a __proto__ key written with unicode escapes", '{"\\u005f\\u005fproto\\u005f\\u005f":{}}'],
      ["a constructor.prototype gadget", '{"constructor":{"prototype":{"isAdmin":true}}}']
    ])("400, not 2xx: %s", async (_label, payload) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ status: 400, title: "Bad Request" });
    });

    it("says WHY, so a rejection is not mistaken for a schema failure", async () => {
      const res = await post('{"__proto__":{"x":1}}');
      expect(res.json()).toMatchObject({
        detail: expect.stringContaining("forbidden prototype property") as unknown as string
      });
    });

    /** The regression this whole change exists for. See docs/server.md §67. */
    it("NEVER accepts-and-strips: the response is a refusal, not a partial success", async () => {
      const res = await post('{"ok":1,"__proto__":{"polluted":"yes"}}');
      expect(res.statusCode).not.toBe(201);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain('"keys"');
    });
  });

  describe("ACCEPTS ordinary bodies (the guard must not over-refuse)", () => {
    it.each([
      ["an ordinary object", '{"ok":1,"nested":{"a":[1,2]}}', ["ok", "nested"]],
      ["a bare constructor string", '{"constructor":"harmless"}', ["constructor"]],
      ["a key merely named prototype", '{"prototype":{"a":1}}', ["prototype"]],
      ["a key containing the substring __proto__", '{"my__proto__key":1}', ["my__proto__key"]],
      ["a string value that reads __proto__", '{"note":"__proto__"}', ["note"]]
    ])("200: %s", async (_label, payload, expectedKeys) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { keys: string[] }).keys.sort()).toEqual([...expectedKeys].sort());
    });

    it("still captures rawBody for webhook signature verification (M7)", async () => {
      const res = await post('{"ok":1}');
      expect((res.json() as { sawRawBody: boolean }).sawRawBody).toBe(true);
    });

    it("still parses an empty body to undefined (the deliberate Fastify divergence)", async () => {
      const res = await post("");
      expect(res.statusCode).toBe(200);
      expect((res.json() as { keys: string[] }).keys).toEqual([]);
    });
  });

  describe("malformed JSON", () => {
    /** Was 500 Internal Server Error on the base commit. See docs/server.md §68. */
    it("is 400, not 500", async () => {
      const res = await post("{not json");
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ status: 400, detail: "Malformed JSON body" });
    });
  });

  it("leaves Object.prototype unmutated across every request above", () => {
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.isAdmin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
    expect(Object.getOwnPropertyNames(Object.prototype).sort().join(",")).toBe(
      OBJECT_PROTOTYPE_KEYS_AT_LOAD
    );
  });
});
