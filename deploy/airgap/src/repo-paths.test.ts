import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { ASSETS_DIR, BUILD_AND_TEST_DOC, COMPOSE_FILE, DESIGN_DOC, HELM_CHART_DIR, REPO_ROOT } from "./repo-paths.js";

describe("repo-paths — resolution sanity", () => {
  it("resolves REPO_ROOT to a directory containing this monorepo's root package.json", () => {
    expect(existsSync(`${REPO_ROOT}/package.json`)).toBe(true);
    expect(existsSync(`${REPO_ROOT}/pnpm-workspace.yaml`)).toBe(true);
  });

  it("resolves every path this package depends on bundling", () => {
    expect(existsSync(HELM_CHART_DIR)).toBe(true);
    expect(existsSync(`${HELM_CHART_DIR}/Chart.yaml`)).toBe(true);
    expect(existsSync(COMPOSE_FILE)).toBe(true);
    expect(existsSync(BUILD_AND_TEST_DOC)).toBe(true);
    expect(existsSync(DESIGN_DOC)).toBe(true);
    expect(existsSync(ASSETS_DIR)).toBe(true);
    expect(existsSync(`${ASSETS_DIR}/install.sh`)).toBe(true);
  });
});
