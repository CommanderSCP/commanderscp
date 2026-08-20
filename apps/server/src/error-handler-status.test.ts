import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp } from "./app.js";
import { createDb, createPool } from "./db/client.js";
import { loadConfig } from "./config.js";
import { frameworkClientProblem } from "./errors.js";

/**
 * THE WIRING TEST for `app.ts`'s `setErrorHandler` honouring a framework-supplied status.
 *
 * Every case here answered **500 Internal Server Error** before this change, on this branch and on
 * `origin/main` — including on the commit that fixed prototype poisoning, which repaired one
 * member of this class (a raw `SyntaxError` from the replacement JSON parser) and left the rest.
 *
 * Routed through the real `buildApp`, not through `frameworkClientProblem` directly, for the
 * reason `json-body-parser.test.ts` gives: a helper that is correct but not installed is this
 * repo's dominant failure mode. Delete the `frameworkClientProblem` branch from `app.ts` and
 * every case in "framework client errors keep their own status" dies while the unit-level
 * "discriminates ..." cases below stay green.
 *
 * No database: `buildApp` connects lazily and none of these requests reaches a route handler.
 */
describe("app.ts setErrorHandler", () => {
  let app: FastifyInstance;
  let pool: Pool;

  beforeAll(async () => {
    process.env.SCP_DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
    const config = loadConfig();
    pool = createPool(config.databaseUrl);
    app = await buildApp({ db: createDb(pool), config }, { logger: false });
    app.post("/__error_handler_probe", () => ({ ok: true }));
    // Throws something the framework did NOT mint, carrying an upstream-looking `statusCode` and a
    // secret in its message — the `undici` error shape, reproduced without depending on undici.
    app.get("/__error_handler_probe/upstream", () => {
      const err = Object.assign(new Error("403 from https://argocd.internal?token=SECRET-TOKEN"), {
        statusCode: 403,
        code: "UND_ERR_RESPONSE"
      });
      throw err;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe("framework client errors keep their own status, not 500", () => {
    it("415 Unsupported Media Type when the body has no content-type at all", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        payload: "hello"
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ status: 415, title: "Unsupported Media Type" });
    });

    it("415 Unsupported Media Type for a content-type nothing parses", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        headers: { "content-type": "application/xml" },
        payload: "<a/>"
      });
      expect(res.statusCode).toBe(415);
    });

    it("400 Bad Request when content-length does not match the bytes sent", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        headers: { "content-type": "application/json", "content-length": "999" },
        payload: '{"a":1}'
      });
      expect(res.statusCode).toBe(400);
    });

    it("413 Content Too Large past the 64 MiB bodyLimit", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        headers: { "content-type": "application/json" },
        payload: `{"a":"${"x".repeat(65 * 1024 * 1024)}"}`
      });
      expect(res.statusCode).toBe(413);
    });

    it("answers application/problem+json, like every other refusal in this server", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        payload: "hello"
      });
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json()).toMatchObject({
        type: "about:blank",
        status: 415,
        instance: "/__error_handler_probe",
        detail: expect.stringContaining("Unsupported Media Type") as unknown as string
      });
    });
  });

  describe("what must NOT be honoured", () => {
    /**
     * The reason `frameworkClientProblem` tests a marker rather than reading `err.statusCode`.
     * `undici` — a direct dependency, used by the executor plugins — puts the UPSTREAM response's
     * status on `statusCode` and the upstream body on `.body`. Honouring it would make an Argo CD
     * 403 into SCP's own 403 and put the upstream's message on the wire.
     */
    it("a non-framework error carrying statusCode is still 500, with no message leaked", async () => {
      const res = await app.inject({ method: "GET", url: "/__error_handler_probe/upstream" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        instance: "/__error_handler_probe/upstream"
      });
      expect(res.body).not.toContain("SECRET-TOKEN");
      expect(res.body).not.toContain("argocd.internal");
    });
  });

  describe("cases the parser already owns are unchanged", () => {
    it("malformed JSON is still the parser's own 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        headers: { "content-type": "application/json" },
        payload: "{not json"
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ detail: "Malformed JSON body" });
    });

    it("an empty body is still the deliberate `undefined` divergence, not 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/__error_handler_probe",
        headers: { "content-type": "application/json" },
        payload: ""
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe("frameworkClientProblem", () => {
  /** The marker `@fastify/error`'s `createError` puts on every error class it builds. */
  const marker = Symbol.for("fastify-error-generic");
  const framework = (statusCode: unknown): Error =>
    Object.assign(
      Object.create(Object.assign(Object.create(Error.prototype), { [marker]: true })),
      {
        message: "m",
        statusCode
      }
    ) as Error;

  it("discriminates a framework 4xx from an identical-looking foreign error", () => {
    expect(frameworkClientProblem(framework(415))).toMatchObject({
      status: 415,
      message: "Unsupported Media Type",
      detail: "m"
    });
    expect(frameworkClientProblem(Object.assign(new Error("m"), { statusCode: 415 }))).toBe(
      undefined
    );
  });

  it("refuses a framework 5xx, so honouring statusCode never leaks a server fault's message", () => {
    expect(frameworkClientProblem(framework(500))).toBeUndefined();
    expect(frameworkClientProblem(framework(503))).toBeUndefined();
  });

  it.each([[undefined], [null], ["415"], [Number.NaN], [415.5], [399], [600]])(
    "refuses a non-integer or out-of-range statusCode: %s",
    (statusCode) => {
      expect(frameworkClientProblem(framework(statusCode))).toBeUndefined();
    }
  );

  it.each([[null], [undefined], ["string"], [42]])("refuses a non-object: %s", (value) => {
    expect(frameworkClientProblem(value)).toBeUndefined();
  });
});
