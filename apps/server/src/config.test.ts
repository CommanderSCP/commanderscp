import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

/** `publicBaseUrl` (SCP_PUBLIC_BASE_URL) parsing — the human-facing counterpart to
 *  `internalBaseUrl`. See docs/server.md §105 and routes/device-flow.ts. */
describe("loadConfig — publicBaseUrl", () => {
  it("is undefined when SCP_PUBLIC_BASE_URL is unset", () => {
    const config = loadConfig({});
    expect(config.publicBaseUrl).toBeUndefined();
  });

  it("is undefined when SCP_PUBLIC_BASE_URL is set to an empty/whitespace string", () => {
    expect(loadConfig({ SCP_PUBLIC_BASE_URL: "" }).publicBaseUrl).toBeUndefined();
    expect(loadConfig({ SCP_PUBLIC_BASE_URL: "   " }).publicBaseUrl).toBeUndefined();
  });

  it("accepts an absolute https URL", () => {
    const config = loadConfig({ SCP_PUBLIC_BASE_URL: "https://scp.example.com" });
    expect(config.publicBaseUrl).toBe("https://scp.example.com");
  });

  it("accepts an absolute http URL", () => {
    const config = loadConfig({ SCP_PUBLIC_BASE_URL: "http://scp.internal.example" });
    expect(config.publicBaseUrl).toBe("http://scp.internal.example");
  });

  it("strips a trailing slash so call sites can uniformly do `${publicBaseUrl}/path`", () => {
    const config = loadConfig({ SCP_PUBLIC_BASE_URL: "https://scp.example.com/" });
    expect(config.publicBaseUrl).toBe("https://scp.example.com");
  });

  it("rejects a scheme-relative / non-absolute value", () => {
    expect(() => loadConfig({ SCP_PUBLIC_BASE_URL: "scp.example.com" })).toThrow(
      /SCP_PUBLIC_BASE_URL must be an absolute http\(s\) URL/
    );
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => loadConfig({ SCP_PUBLIC_BASE_URL: "ftp://scp.example.com" })).toThrow(
      /SCP_PUBLIC_BASE_URL must be an absolute http\(s\) URL/
    );
  });

  it("rejects garbage that isn't a URL at all", () => {
    expect(() => loadConfig({ SCP_PUBLIC_BASE_URL: "not a url" })).toThrow(
      /SCP_PUBLIC_BASE_URL must be an absolute http\(s\) URL/
    );
  });
});

/** M29.4 — the chart-generated `scp_operator` password becomes a connection at the RUNTIME
 *  connection's address; an explicit URL always wins; nothing generated means nothing derived. */
describe("loadConfig — operatorDatabaseUrl from a generated password", () => {
  const runtime = "postgres://scp_app:app-pw@db.internal:5433/scp";

  it("derives scp_operator at the runtime connection's host, port and database", () => {
    const config = loadConfig({
      SCP_SKIP_MIGRATIONS: "true",
      SCP_RUNTIME_DATABASE_URL: runtime,
      SCP_OPERATOR_DATABASE_PASSWORD: "gen/p@ss"
    });
    const url = new URL(config.operatorDatabaseUrl!);
    expect(url.username).toBe("scp_operator");
    expect(decodeURIComponent(url.password)).toBe("gen/p@ss");
    expect(url.host).toBe("db.internal:5433");
    expect(url.pathname).toBe("/scp");
  });

  it("an explicit SCP_OPERATOR_DATABASE_URL wins over the generated password", () => {
    const config = loadConfig({
      SCP_SKIP_MIGRATIONS: "true",
      SCP_RUNTIME_DATABASE_URL: runtime,
      SCP_OPERATOR_DATABASE_URL: "postgres://scp_operator:mine@elsewhere/scp",
      SCP_OPERATOR_DATABASE_PASSWORD: "gen"
    });
    expect(config.operatorDatabaseUrl).toBe("postgres://scp_operator:mine@elsewhere/scp");
  });

  it("with neither, an api/worker pod (no self-migration) has no operator connection", () => {
    const config = loadConfig({ SCP_SKIP_MIGRATIONS: "true", SCP_RUNTIME_DATABASE_URL: runtime });
    expect(config.operatorDatabaseUrl).toBeUndefined();
  });
});
