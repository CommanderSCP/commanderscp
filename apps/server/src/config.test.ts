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
