// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CreateObjectRequest,
  DiscoveryProposal,
  GraphObject,
  PluginManifest
} from "@scp/schemas";
import { flush, render, typeInto } from "../test-support/render-dom";

/**
 * B1/B3/B4 (docs/proposals/outpost-ui.md §4 Lane B) — `/connect/$kind`'s guarantees that must hold
 * with no browser and no server, mirroring `connect-argocd.test.tsx`'s house pattern:
 *
 *   - B1: the generalized wizard is driven by the server's OWN manifest catalog, and a module whose
 *     secret field the execution-system-backed merge cannot forward (`github-discovery`'s
 *     `privateKeySecretKey`) is excluded by DERIVATION, not a hand-maintained list.
 *   - B4: a proposed `deployment-target` object gets the identical review-list/skip treatment as a
 *     `component` — but ONLY when the proposal actually contains one, and skip is withdrawn the
 *     moment the proposal carries relationships it cannot safely re-filter.
 *   - B3: the accept response's positional correspondence to the SUBMITTED proposal is what lets the
 *     triage list name and assign each imported component.
 *   - The Argo CD credential hazard (`connect-argocd.test.tsx` hazard (b)) generalizes: the secret
 *     still reaches `putSecret` and nowhere else, for a module OTHER than argocd.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const listManifestsSpy = vi.fn(async () => ({ items: [] as PluginManifest[] }));
vi.mock("../lib/client", () => ({
  client: { plugins: { listManifests: listManifestsSpy } }
}));

const {
  connectableKinds,
  runConfigFields,
  groupObjectsByType,
  filterProposal,
  RegisterStepGeneric,
  EnumerateStepGeneric,
  ReviewStepGeneric,
  ConnectGenericPage
} = await import("./connect");

const SENTINEL = "gitea-pat-DO-NOT-LEAK-7c1e9a";

// -------------------------------------------------------------------------------------------
// Fixture manifests — shaped exactly like the bundled plugins' real `configSchema`s
// (packages/plugins/{argocd,gitea,gitlab,github}/src/index.ts), not invented.
// -------------------------------------------------------------------------------------------

function manifest(id: string, configSchema: Record<string, unknown>): PluginManifest {
  return { id, kind: "discovery", version: "0.1.0", configSchema };
}

const ARGOCD_DISCOVERY = manifest("argocd-discovery", {
  type: "object",
  required: ["serverUrl"],
  properties: { serverUrl: { type: "string" }, tokenSecretKey: { type: "string" } }
});
const GITEA_DISCOVERY = manifest("gitea-discovery", {
  type: "object",
  required: ["owner", "repo"],
  properties: {
    baseUrl: { type: "string" },
    serverUrl: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    tokenSecretKey: { type: "string" },
    defaultWorkflowId: { type: "string" }
  }
});
const GITLAB_DISCOVERY = manifest("gitlab-discovery", {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    serverUrl: { type: "string" },
    projectPath: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    tokenSecretKey: { type: "string" },
    defaultRef: { type: "string" }
  }
});
const GITHUB_DISCOVERY = manifest("github-discovery", {
  type: "object",
  required: ["appId", "installationId", "owner", "repo"],
  properties: {
    appId: { type: "string" },
    installationId: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    privateKeySecretKey: { type: "string" },
    serverUrl: { type: "string" }
  }
});
const ALL_MANIFESTS = [ARGOCD_DISCOVERY, GITEA_DISCOVERY, GITLAB_DISCOVERY, GITHUB_DISCOVERY];

function doorsDouble() {
  const calls: string[] = [];
  return {
    calls,
    putSecret: vi.fn(async (key: string, value: string) => {
      void key;
      void value;
      calls.push("putSecret");
    }),
    createExecutionSystem: vi.fn(async (req: CreateObjectRequest) => {
      void req;
      calls.push("createExecutionSystem");
      return {
        id: "019f0000-0000-7000-8000-0000000000aa",
        urn: "urn:scp:execution-system:gitea1",
        typeId: "execution-system",
        name: "gitea1",
        properties: { kind: "gitea" },
        labels: {},
        revision: 1,
        version: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z"
      } as unknown as GraphObject;
    }),
    listExecutionSystems: vi.fn(async () => [] as GraphObject[]),
    runDiscovery: vi.fn(async () => ({ objects: [], relationships: [] }) as DiscoveryProposal),
    listServices: vi.fn(async () => [] as GraphObject[]),
    setService: vi.fn(async () => ({}))
  };
}

function withQueryClient(node: React.ReactElement): React.ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
}

// -------------------------------------------------------------------------------------------
// B1 — the connectable set is DERIVED, not hardcoded
// -------------------------------------------------------------------------------------------

describe("connectableKinds: derived from the server's own manifest catalog", () => {
  it("includes argocd/gitea/gitlab and excludes github (no tokenSecretKey)", () => {
    const kinds = connectableKinds(ALL_MANIFESTS).map((k: { kind: string }) => k.kind);
    expect(kinds).toEqual(["argocd", "gitea", "gitlab"]);
    expect(kinds).not.toContain("github");
  });

  it("MUTATION CHECK: a module declaring tokenSecretKey under a different kind is still excluded", () => {
    // Guards against "any -discovery manifest passes" — the executor half must not leak in.
    const executorOnly = manifest("gitea", ARGOCD_DISCOVERY.configSchema);
    (executorOnly as { kind: string }).kind = "executor";
    const kinds = connectableKinds([executorOnly]);
    expect(kinds).toEqual([]);
  });

  it("an empty catalog yields an empty set, never a hardcoded fallback", () => {
    expect(connectableKinds([])).toEqual([]);
  });
});

describe("runConfigFields: per-run config, never the system-level fields", () => {
  it("gitea: owner+repo required (from the schema), serverUrl/tokenSecretKey/baseUrl excluded", () => {
    const fields = runConfigFields({
      kind: "gitea",
      discoveryModule: "gitea-discovery",
      manifest: GITEA_DISCOVERY
    });
    const names = fields.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(["defaultWorkflowId", "owner", "repo"]);
    expect(fields.find((f: { name: string }) => f.name === "owner")?.required).toBe(true);
    expect(fields.find((f: { name: string }) => f.name === "repo")?.required).toBe(true);
    expect(fields.find((f: { name: string }) => f.name === "defaultWorkflowId")?.required).toBe(
      false
    );
  });

  it("gitlab: owner+repo required by the CLIENT override, since the schema declares none", () => {
    const fields = runConfigFields({
      kind: "gitlab",
      discoveryModule: "gitlab-discovery",
      manifest: GITLAB_DISCOVERY
    });
    expect(fields.find((f: { name: string }) => f.name === "owner")?.required).toBe(true);
    expect(fields.find((f: { name: string }) => f.name === "repo")?.required).toBe(true);
    expect(fields.find((f: { name: string }) => f.name === "projectPath")?.required).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// B4 — target rows, and where skip is (and is not) safely offered
// -------------------------------------------------------------------------------------------

describe("groupObjectsByType", () => {
  it("groups a deployment-target apart from components, in first-seen order", () => {
    const groups = groupObjectsByType([
      { typeId: "component", name: "api" },
      { typeId: "deployment-target", name: "prod-us" },
      { typeId: "component", name: "worker" }
    ]);
    expect(groups).toEqual([
      ["component", [0, 2]],
      ["deployment-target", [1]]
    ]);
  });
});

describe("ReviewStepGeneric: the step scaffolds instead of importing", () => {
  // THE THREE CASES THAT WERE HERE DESCRIBED AN AFFORDANCE THAT NO LONGER EXISTS (ADR-0047): a
  // grouped list of proposed objects with a checkbox per row, so an operator could accept a SUBSET,
  // plus the rule that the checkboxes withdrew when relationships made a subset unsafe to submit.
  //
  // There is no submission now. The step emits IaC, and a proposal is not something you accept part
  // of — you decide which components belong to which service and commit the result. Keeping the
  // checkbox cases would have meant keeping a selection UI whose only consumer was the removed
  // write.
  //
  // What replaces them lives in `components/scaffold/scaffold-panel.test.tsx`, which tests the
  // decision that actually matters now: grouping, and what happens to a component nobody grouped.
  it("renders the scaffolder, and offers no way to write to the graph", () => {
    const view = render(
      withQueryClient(
        <ReviewStepGeneric
          proposal={
            {
              objects: [{ typeId: "component", name: "api" }],
              relationships: []
            } as DiscoveryProposal
          }
        />
      )
    );
    expect(view.html()).toContain("connect-scaffold-panel");
    // The old step's submit control is gone by NAME as well as by behaviour — a rename would have
    // left this passing while the write returned under a different label.
    expect(view.html()).not.toContain("connect-accept-submit");
  });
});

describe("filterProposal: skipping an object drops only ITS bindings/sourceMappings", () => {
  it("keeps the kept object's binding, drops the skipped object's", () => {
    const proposal: DiscoveryProposal = {
      objects: [
        { typeId: "component", name: "keep-me" },
        { typeId: "component", name: "skip-me" }
      ],
      relationships: [],
      bindings: [
        { objectName: "keep-me", executionSystemId: "sys-1" },
        { objectName: "skip-me", executionSystemId: "sys-1" }
      ],
      sourceMappings: [
        { objectName: "keep-me", sourceKind: "gitea", repoPattern: "o/r" },
        { objectName: "skip-me", sourceKind: "gitea", repoPattern: "o/r2" }
      ]
    };
    const filtered = filterProposal(proposal, new Set([1]));
    expect(filtered.objects.map((o: { name: string }) => o.name)).toEqual(["keep-me"]);
    expect(filtered.bindings?.map((b: { objectName: string }) => b.objectName)).toEqual([
      "keep-me"
    ]);
    expect(filtered.sourceMappings?.map((m: { objectName: string }) => m.objectName)).toEqual([
      "keep-me"
    ]);
  });

  it("is a no-op (same object identity semantics) when nothing is unchecked", () => {
    const proposal: DiscoveryProposal = {
      objects: [{ typeId: "component", name: "a" }],
      relationships: []
    };
    expect(filterProposal(proposal, new Set())).toEqual(proposal);
  });
});

// -------------------------------------------------------------------------------------------
// B3 IS GONE, AND SO IS WHAT IT DESCRIBED (ADR-0047).
//
// It pinned the POSITIONAL correspondence between the accept response's `createdObjectIds` and the
// proposal that was submitted — the join that let the triage list name each imported component —
// and then that the triage screen appeared exactly when components had landed without a service.
//
// Both describe a graph write that no longer happens. `discovery.accept` is removed; the wizard
// emits IaC and a component cannot be emitted without a service, so there is no created-object list
// to zip against and no orphan to triage. The concern moved one step earlier, to
// `scaffold-panel.test.tsx`'s ungrouped case, which is where ADR-0047 put it: at authoring time,
// where a human is present.

describe("RegisterStepGeneric: the secret still reaches putSecret and nowhere else", () => {
  it("stores the token under the derived key and stamps the right execution-system kind", async () => {
    const doors = doorsDouble();
    const onRegistered = vi.fn();
    const view = render(
      withQueryClient(
        <RegisterStepGeneric
          connectable={{
            kind: "gitea",
            discoveryModule: "gitea-discovery",
            manifest: GITEA_DISCOVERY
          }}
          doors={doors}
          existing={[]}
          onRegistered={onRegistered}
        />
      )
    );

    const secretInput = view.byTestId("connect-secret-input") as HTMLInputElement;
    expect(secretInput.type).toBe("password");

    typeInto(view.byTestId("connect-name-input") as HTMLInputElement, "gitea1");
    typeInto(
      view.byTestId("connect-server-url-input") as HTMLInputElement,
      "https://gitea.example.com"
    );
    typeInto(secretInput, SENTINEL);

    view.click("connect-register-submit");
    await flush();

    expect(doors.putSecret).toHaveBeenCalledTimes(1);
    expect(doors.putSecret).toHaveBeenCalledWith("gitea1-gitea-token", SENTINEL);
    expect(onRegistered).toHaveBeenCalledTimes(1);

    const created = doors.createExecutionSystem.mock.calls[0]![0];
    expect(JSON.stringify(created)).not.toContain(SENTINEL);
    const props = created.properties as { kind: string; tokenSecretKey: string; serverUrl: string };
    expect(props.kind).toBe("gitea");
    expect(props.tokenSecretKey).toBe("gitea1-gitea-token");
    expect(props.serverUrl).toBe("https://gitea.example.com");

    expect(view.html(), "the rendered DOM after a successful submit").not.toContain(SENTINEL);
    view.unmount();
  });
});

describe("EnumerateStepGeneric: run config assembly", () => {
  it("sends executionSystemId plus the per-run fields the operator filled, coerced by schema type", async () => {
    const doors = doorsDouble();
    const system = {
      id: "019f0000-0000-7000-8000-0000000000bb",
      name: "gitea1"
    } as GraphObject;
    const view = render(
      withQueryClient(
        <EnumerateStepGeneric
          connectable={{
            kind: "gitea",
            discoveryModule: "gitea-discovery",
            manifest: GITEA_DISCOVERY
          }}
          doors={doors}
          system={system}
          onProposal={() => {}}
          onBack={() => {}}
        />
      )
    );
    typeInto(view.byTestId("connect-run-field-owner") as HTMLInputElement, "acme");
    typeInto(view.byTestId("connect-run-field-repo") as HTMLInputElement, "widgets");
    // defaultWorkflowId left blank — must be OMITTED, not sent as "".
    view.click("connect-enumerate-submit");
    await flush();

    expect(doors.runDiscovery).toHaveBeenCalledTimes(1);
    expect(doors.runDiscovery).toHaveBeenCalledWith("gitea-discovery", "gitea1", {
      executionSystemId: system.id,
      owner: "acme",
      repo: "widgets"
    });
    view.unmount();
  });
});

// -------------------------------------------------------------------------------------------
// The page: only server-known kinds get the real wizard
// -------------------------------------------------------------------------------------------

// The manifest catalog is SEEDED directly into the QueryClient cache rather than awaited through
// `listManifestsSpy`'s promise: TanStack Query batches its post-fetch notification outside a plain
// microtask (a `flush()` awaits only `Promise.resolve()`), so asserting on the settled state needs
// either a real timer tick or — far more deterministic here — never going through the fetch at all.
// `connectableKinds`'s own unit tests above already pin the exclusion logic; this only needs to pin
// that the PAGE wires that result into the right branch.
function seededQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient.setQueryData(["plugin-manifests"], { items: ALL_MANIFESTS });
  queryClient.setQueryData(["execution-systems"], [] as GraphObject[]);
  return queryClient;
}

describe("ConnectGenericPage: renders only server-known kinds", () => {
  it("kind=github (excluded — see connectableKinds) shows the unsupported message, listing gitea/gitlab", () => {
    const queryClient = seededQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectGenericPage kind="github" doors={doorsDouble()} />
      </QueryClientProvider>
    );
    expect(view.html()).toContain("connect-unsupported-kind");
    expect(view.html()).not.toContain("connect-register-card");
    expect(view.html()).toContain("Gitea");
    expect(view.html()).toContain("GitLab");
    view.unmount();
  });

  it("kind=gitea (a real discovery module) renders the register step", () => {
    const queryClient = seededQueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectGenericPage kind="gitea" doors={doorsDouble()} />
      </QueryClientProvider>
    );
    expect(view.html()).toContain("connect-register-card");
    expect(view.html()).not.toContain("connect-unsupported-kind");
    view.unmount();
  });
});
