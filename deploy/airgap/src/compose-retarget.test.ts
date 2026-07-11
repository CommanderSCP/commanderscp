import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { buildAirgapCompose, POSTGRES_IMAGE_PLACEHOLDER, SCPD_IMAGE_PLACEHOLDER } from "./compose-retarget.js";
import { COMPOSE_FILE } from "./repo-paths.js";

const SAMPLE = `
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: scp
  scp:
    build:
      context: ../..
      dockerfile: Dockerfile
    environment:
      SCP_ROLE: all
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
volumes:
  scp-postgres-data:
`;

describe("buildAirgapCompose — synthetic fixture", () => {
  it("replaces services.scp's build: with a placeholder image:", () => {
    const out = buildAirgapCompose(SAMPLE);
    const parsed = parseYaml(out) as { services: { scp: Record<string, unknown> } };
    expect(parsed.services.scp.build).toBeUndefined();
    expect(parsed.services.scp.image).toBe(SCPD_IMAGE_PLACEHOLDER);
  });

  it("pins services.postgres's image: to a placeholder", () => {
    const out = buildAirgapCompose(SAMPLE);
    const parsed = parseYaml(out) as { services: { postgres: Record<string, unknown> } };
    expect(parsed.services.postgres.image).toBe(POSTGRES_IMAGE_PLACEHOLDER);
  });

  it("preserves unrelated fields (env, ports, depends_on, volumes)", () => {
    const out = buildAirgapCompose(SAMPLE);
    const parsed = parseYaml(out) as {
      services: { scp: Record<string, unknown>; postgres: Record<string, unknown> };
      volumes: Record<string, unknown>;
    };
    expect(parsed.services.scp.environment).toEqual({ SCP_ROLE: "all" });
    expect(parsed.services.scp.ports).toEqual(["8080:8080"]);
    expect(parsed.services.scp.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
    expect(parsed.services.postgres.environment).toEqual({ POSTGRES_USER: "scp" });
    expect(parsed.volumes).toHaveProperty("scp-postgres-data");
  });

  it("throws a clear error when services.scp has no build: to retarget", () => {
    const noBuild = `
services:
  postgres:
    image: postgres:16
  scp:
    image: already-an-image:latest
`;
    expect(() => buildAirgapCompose(noBuild)).toThrow(/no 'build' key/);
  });

  it("throws when the compose file has no services.scp/services.postgres at all", () => {
    expect(() => buildAirgapCompose("services:\n  other:\n    image: x\n")).toThrow(/services\.scp/);
    expect(() =>
      buildAirgapCompose("services:\n  scp:\n    build:\n      context: ../..\n")
    ).toThrow(/services\.postgres/);
  });
});

describe("buildAirgapCompose — against the real deploy/compose/docker-compose.yml", () => {
  it("transforms the actual repo file without throwing, catching drift between this module and the real compose file's shape", async () => {
    const real = await readFile(COMPOSE_FILE, "utf8");
    const out = buildAirgapCompose(real);
    const parsed = parseYaml(out) as { services: { scp: Record<string, unknown>; postgres: Record<string, unknown> } };
    expect(parsed.services.scp.image).toBe(SCPD_IMAGE_PLACEHOLDER);
    expect(parsed.services.scp.build).toBeUndefined();
    expect(parsed.services.postgres.image).toBe(POSTGRES_IMAGE_PLACEHOLDER);
  });
});
