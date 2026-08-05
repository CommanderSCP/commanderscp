import { describe, expect, it } from "vitest";
import { executionSystemConsoleBase, executorConsoleUrl, repoConsoleUrl } from "./console-urls.js";

/**
 * A LINK IS ONLY EVER RETURNED WHEN IT IS KNOWN.
 *
 * These are the cases where the tempting answer is a plausible URL and the correct answer is null.
 * A dead link in an operator console is a claim that something is over there; plain text is not.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | drop the glob check from `repoConsoleUrl` | the pattern test FAILS — `org/*` would link to a repo literally named `*` |
 * | fall back to `gitlab.com` for a gitlab mapping | the self-hosted test FAILS — that URL points at a stranger's repo |
 * | prefer `serverUrl` over `webUrl` | the console-base test FAILS — the operator's browsable address loses to the in-cluster one |
 */
describe("repo console URLs", () => {
  it("links a literal github repo", () => {
    expect(repoConsoleUrl("github", "AgentKitProject/agentkit")).toBe(
      "https://github.com/AgentKitProject/agentkit"
    );
  });

  it("refuses a PATTERN — it names a set of repos, not a page", () => {
    // `source_mappings.repo_pattern` is a pattern by definition. Linking `org/*` would open a repo
    // literally called `*`.
    expect(repoConsoleUrl("github", "AgentKitProject/*")).toBeNull();
  });

  it("refuses a self-hosted provider whose host nobody told us", () => {
    // A `source_mappings` row carries no execution-system reference, so there is nothing to read a
    // GitLab/Gitea host from — and `gitlab.com` would be someone else's repo entirely.
    expect(repoConsoleUrl("gitlab", "team/app")).toBeNull();
    expect(repoConsoleUrl("gitea", "team/app")).toBeNull();
  });

  it("refuses a mapping with no repo at all", () => {
    expect(repoConsoleUrl("github", null)).toBeNull();
  });
});

describe("execution-system console base", () => {
  it("prefers the operator's browsable webUrl over the coordination serverUrl", () => {
    // The live homelab's Argo CD `serverUrl` is `http://argocd-server.argocd.svc.cluster.local` —
    // correct for the server to call, useless in a browser.
    expect(
      executionSystemConsoleBase({
        kind: "argocd",
        serverUrl: "http://argocd-server.argocd.svc.cluster.local",
        webUrl: "https://argocd.example.com/"
      })
    ).toBe("https://argocd.example.com");
  });

  it("falls back to serverUrl, which for most deployments IS the browsable host", () => {
    expect(executionSystemConsoleBase({ serverUrl: "https://argocd.example.com" })).toBe(
      "https://argocd.example.com"
    );
  });

  it("is null when the system names no address at all", () => {
    expect(executionSystemConsoleBase({ kind: "argocd" })).toBeNull();
    expect(executionSystemConsoleBase(null)).toBeNull();
  });
});

describe("executor console URLs", () => {
  it("opens the Argo CD application, not the API", () => {
    expect(
      executorConsoleUrl({
        kind: "argocd",
        base: "https://argocd.example.com",
        externalRef: "market"
      })
    ).toBe("https://argocd.example.com/applications/market");
  });

  it("falls back to the Argo CD root when the binding names no app", () => {
    // Both live `image` bindings have an EMPTY external_ref; the system's own page is still useful.
    expect(
      executorConsoleUrl({ kind: "argocd", base: "https://argocd.example.com", externalRef: "" })
    ).toBe("https://argocd.example.com");
  });

  it("opens a GitHub binding's Actions tab, ignoring the API base", () => {
    expect(
      executorConsoleUrl({
        kind: "github",
        base: "https://api.github.com",
        externalRef: "AgentKitProject/agentkit"
      }),
      "the API host is exactly the URL a person must not be sent to"
    ).toBe("https://github.com/AgentKitProject/agentkit/actions");
  });

  it("refuses a github binding whose ref is not an owner/repo", () => {
    expect(
      executorConsoleUrl({ kind: "github", base: null, externalRef: "just-a-name" })
    ).toBeNull();
  });

  it("is null when there is no address and no rule", () => {
    expect(executorConsoleUrl({ kind: "argocd", base: null, externalRef: "market" })).toBeNull();
    expect(executorConsoleUrl({ kind: null, base: null, externalRef: "x" })).toBeNull();
  });
});
