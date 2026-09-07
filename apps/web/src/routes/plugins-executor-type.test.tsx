import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutorTypeSchema } from "@scp/schemas";

/** A2 (docs/proposals/outpost-ui.md §3). See docs/web.md §443. */
const { ExecutorBindingTypeField, buildExecutorBindingPayload } = await import("./plugins");

describe("A2 — executor binding Type", () => {
  it("ExecutorBindingTypeField renders a labeled, testid-bearing field naming what build/infrastructure/configuration each route", () => {
    const html = renderToStaticMarkup(
      <ExecutorBindingTypeField value="configuration" onChange={() => {}} />
    );
    expect(html).toContain('data-testid="executor-binding-type-select"');
    expect(html).toContain(">Type<");
    // The one help line (task spec: "naming what each Type routes") — no ADR/milestone citation in
    // the rendered copy (design-system.md copy rule 2), those stay in the code comment beside it.
    expect(html).toContain("build");
    expect(html).toContain("infrastructure");
    expect(html).toContain("configuration");
    expect(html).not.toMatch(/ADR-|M\d+\.\d/);
  });

  it("buildExecutorBindingPayload always includes `type` — never omits it back to a silent default", () => {
    for (const type of ExecutorTypeSchema.options) {
      const payload = buildExecutorBindingPayload({
        pluginModule: "argocd",
        pluginInstanceId: "prod",
        config: {},
        allowedHosts: [],
        type
      });
      expect(payload.type).toBe(type);
    }
  });

  it("buildExecutorBindingPayload rides a non-default Type through untouched — the operator's own choice, not a fallback", () => {
    const payload = buildExecutorBindingPayload({
      pluginModule: "terraform-cloud",
      pluginInstanceId: "prod-infra",
      config: { workspace: "prod" },
      allowedHosts: [],
      type: "infrastructure"
    });
    expect(payload).toMatchObject({
      pluginModule: "terraform-cloud",
      pluginInstanceId: "prod-infra",
      config: { workspace: "prod" },
      type: "infrastructure"
    });
    expect(payload.allowedHosts).toBeUndefined();
  });

  it("buildExecutorBindingPayload omits allowedHosts when empty, and carries it through when set (existing behavior, unchanged by A2)", () => {
    const withHosts = buildExecutorBindingPayload({
      pluginModule: "argocd",
      pluginInstanceId: "prod",
      config: {},
      allowedHosts: ["argocd.internal"],
      type: "configuration"
    });
    expect(withHosts.allowedHosts).toEqual(["argocd.internal"]);

    const withoutHosts = buildExecutorBindingPayload({
      pluginModule: "argocd",
      pluginInstanceId: "prod",
      config: {},
      allowedHosts: [],
      type: "configuration"
    });
    expect(withoutHosts.allowedHosts).toBeUndefined();
  });
});
