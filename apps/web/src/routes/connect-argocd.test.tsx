// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AcceptDiscoveryResponse,
  CreateObjectRequest,
  DiscoveryProposal,
  GraphObject
} from "@scp/schemas";
import { flush, render, typeInto } from "../test-support/render-dom";

/**
 * M19.1 — the two "Connect Argo CD" wizard guarantees that must hold on EVERY PR, with no browser
 * and no server. The Playwright spec (`e2e/connect-argocd.spec.ts`) proves the flow works against a
 * real server and a fake Argo CD; it runs in CI job 9, which is minutes and a compose stack. These
 * are the two claims that would be silently wrong rather than loudly broken, so they belong in the
 * unit job:
 *
 *   (b) THE CREDENTIAL LEAVES BY ONE DOOR. Proven by SEARCHING FOR THE TOKEN, not by reading the
 *       code: a sentinel is typed and submitted, then asserted ABSENT from the query cache, the
 *       mutation cache (where `mutate(vars)` would have parked it), the rendered markup and the
 *       URL — while `putSecret` is asserted to have RECEIVED it, so the test cannot pass by way of
 *       a token that never existed. That anti-vacuity half is the point: "the token is nowhere" is
 *       trivially true of a form that never captured one.
 *
 *   (c) THE ORPHAN NOTICE FOLLOWS THE DATA. `discovery accept` creates components and bindings but
 *       no relationships, so the success screen must not imply a graph link that is not there —
 *       AND must not hardcode that absence, because the day the plugin emits relationships a
 *       hardcoded "not part of any service" becomes the lie instead. Both directions are asserted.
 *
 * MUTATION LOG (each applied alone against this file, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | `mutationFn: async (vars) => …` + `register.mutate(draft)` (the token as mutation variables) | token-in-mutation-cache FAILS |
 * | drop `setDraft(prev => ({...prev, token: ""}))` from `onSuccess` | token-in-markup FAILS |
 * | `type="password"` -> `type="text"` on the token input | the password-input case FAILS |
 * | `relationships === 0` -> `true` (always show the orphan notice) | the non-zero case FAILS |
 * | render a literal `0` for the relationship count | the non-zero case FAILS |
 * | `...(draft.allowInternalEgress ? {allowInternalEgress: true} : {})` -> always `true` | the unchecked-checkbox case FAILS |
 * | `putSecret` after `createExecutionSystem` | the ordering case FAILS |
 * | `config: {executionSystemId, serverUrl}` in `sdkDoors.runDiscovery` | the "only the system id" case FAILS |
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

/** Typed with its request parameter so `.mock.calls[0][0]` is the body — the "step 2 sends nothing
 *  else" case below reads it, and an argument-less `vi.fn()` would make that read a cast. */
const runDiscoverySpy = vi.fn(async (req: Record<string, unknown>) => {
  void req;
  return { objects: [], relationships: [] };
});
vi.mock("../lib/client", () => ({
  client: {
    secrets: { put: vi.fn(async () => ({ key: "k", configured: true })) },
    object: () => ({
      create: vi.fn(async () => systemFixture()),
      list: vi.fn(async () => ({ items: [] }))
    }),
    discovery: { run: runDiscoverySpy, accept: vi.fn(async () => acceptFixture()) }
  }
}));

const {
  ImportSummary,
  RegisterStep,
  argoCdSystems,
  defaultTokenKey,
  normalizeServerUrl,
  proposalTypeCounts,
  registerExecutionSystem,
  sdkDoors
} = await import("./connect-argocd");

const SENTINEL = "argocd-api-token-DO-NOT-LEAK-9f3a2b";
const SYSTEM_ID = "019f0000-0000-7000-8000-0000000000aa";

function systemFixture(): GraphObject {
  return {
    id: SYSTEM_ID,
    urn: "urn:scp:execution-system:prod",
    typeId: "execution-system",
    name: "prod",
    properties: { kind: "argocd", serverUrl: "https://argocd.example.com" },
    labels: {},
    revision: 1,
    version: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  } as unknown as GraphObject;
}

function acceptFixture(overrides: Partial<AcceptDiscoveryResponse> = {}): AcceptDiscoveryResponse {
  return {
    createdObjectIds: [],
    createdRelationshipIds: [],
    createdBindingIds: [],
    createdSourceMappingIds: [],
    ...overrides
  };
}

function ids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `019f0000-0000-7000-8000-0000000000${String(i).padStart(2, "0")}`
  );
}

/** A double for the four doors the wizard may use, recording call ORDER as well as arguments — the
 *  secret must be written before the system that references it. */
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
      return systemFixture();
    }),
    listExecutionSystems: vi.fn(async () => [] as GraphObject[]),
    runDiscovery: vi.fn(async (): Promise<DiscoveryProposal> => ({
      objects: [],
      relationships: []
    })),
    acceptProposal: vi.fn(async () => acceptFixture())
  };
}

function withQueryClient(node: React.ReactElement): {
  element: React.ReactElement;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return {
    queryClient,
    element: <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  };
}

// ---------------------------------------------------------------------------------------------
// (b) The credential
// ---------------------------------------------------------------------------------------------

describe("hazard (b): the Argo CD token reaches secrets.put and nothing else", () => {
  it("is submitted, stored, and then findable NOWHERE the browser keeps state", async () => {
    const doors = doorsDouble();
    const onRegistered = vi.fn();
    const { element, queryClient } = withQueryClient(
      <RegisterStep doors={doors} existing={[]} onRegistered={onRegistered} />
    );
    const view = render(element);

    const tokenInput = view.byTestId("argocd-token-input") as HTMLInputElement;
    // A credential field is a password field. Cheap, and the one thing a screenshot or a shoulder
    // would otherwise leak before anything else in this test can matter.
    expect(tokenInput.type).toBe("password");
    expect(tokenInput.autocomplete).toBe("off");

    typeInto(view.byTestId("argocd-name-input") as HTMLInputElement, "prod");
    typeInto(view.byTestId("argocd-url-input") as HTMLInputElement, "https://argocd.example.com");
    typeInto(tokenInput, SENTINEL);

    view.click("argocd-register-submit");
    await flush();

    // ANTI-VACUITY FIRST. Everything below asserts an ABSENCE, which a form that never captured the
    // token would satisfy perfectly. This is the assertion that says the token was real and went
    // exactly where it was supposed to go.
    expect(doors.putSecret).toHaveBeenCalledTimes(1);
    expect(doors.putSecret).toHaveBeenCalledWith("prod-argocd-token", SENTINEL);
    expect(onRegistered).toHaveBeenCalledTimes(1);

    // The registration body references the secret BY KEY and never carries the value.
    const created = doors.createExecutionSystem.mock.calls[0]![0];
    expect(JSON.stringify(created)).not.toContain(SENTINEL);
    expect((created.properties as { tokenSecretKey?: string }).tokenSecretKey).toBe(
      "prod-argocd-token"
    );

    // The four places a browser would keep it.
    const queries = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => ({ key: q.queryKey, state: q.state }))
    );
    const mutations = JSON.stringify(
      queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state)
    );
    expect(queries, "TanStack query cache").not.toContain(SENTINEL);
    expect(
      mutations,
      "TanStack mutation cache (mutate(vars) parks its argument here)"
    ).not.toContain(SENTINEL);
    expect(view.html(), "the rendered DOM after a successful submit").not.toContain(SENTINEL);
    expect(window.location.href, "the URL").not.toContain(SENTINEL);

    view.unmount();
  });
});

// ---------------------------------------------------------------------------------------------
// (c) The orphan notice
// ---------------------------------------------------------------------------------------------

describe("hazard (c): the success screen reports what the SERVER returned", () => {
  it("says the components are not part of any service when NO relationship was created", () => {
    const html = renderToStaticMarkup(
      <ImportSummary
        result={acceptFixture({
          createdObjectIds: ids(3),
          createdBindingIds: ids(3),
          createdSourceMappingIds: ids(2),
          createdRelationshipIds: []
        })}
        systemName="prod"
      />
    );
    expect(html).toContain("argocd-orphan-notice");
    expect(html).toContain("not part of any service yet");
    // Each count comes off the response — three DIFFERENT numbers, so a summary reading the wrong
    // field cannot coincidentally agree with all of them.
    expect(html).toMatch(/argocd-created-graph-objects[\s\S]*?>3</);
    expect(html).toMatch(/argocd-created-executor-bindings[\s\S]*?>3</);
    expect(html).toMatch(/argocd-created-source-mappings[\s\S]*?>2</);
    expect(html).toMatch(/argocd-created-graph-relationships[\s\S]*?>0</);
  });

  it("does NOT say it when relationships WERE created — the notice follows the data, not a belief", () => {
    // argocd-discovery returns `relationships: []` today. If it ever stops doing so, a hardcoded
    // orphan notice becomes the lie, which is why this direction is pinned too.
    const html = renderToStaticMarkup(
      <ImportSummary
        result={acceptFixture({ createdObjectIds: ids(2), createdRelationshipIds: ids(2) })}
        systemName="prod"
      />
    );
    expect(html).not.toContain("argocd-orphan-notice");
    expect(html).not.toContain("not part of any service yet");
    expect(html).toMatch(/argocd-created-graph-relationships[\s\S]*?>2</);
  });
});

// ---------------------------------------------------------------------------------------------
// What step 1 writes, and what step 2 sends
// ---------------------------------------------------------------------------------------------

describe("step 1 writes the same thing `scp connect argocd` writes", () => {
  it("stores the secret BEFORE creating the system that references it", async () => {
    const doors = doorsDouble();
    await registerExecutionSystem(doors, {
      name: "prod",
      serverUrl: "https://argocd.example.com",
      token: SENTINEL,
      tokenKey: "",
      allowInternalEgress: false
    });
    // Reversed, the system would name a secret that does not exist yet and step 2 would fail with
    // an error about the wrong thing.
    expect(doors.calls).toEqual(["putSecret", "createExecutionSystem"]);
  });

  it("omits allowInternalEgress unless the operator ticked the box, and sets true when they did", async () => {
    const off = doorsDouble();
    await registerExecutionSystem(off, {
      name: "prod",
      serverUrl: "https://argocd.example.com",
      token: SENTINEL,
      tokenKey: "",
      allowInternalEgress: false
    });
    const offProps = off.createExecutionSystem.mock.calls[0]![0].properties as Record<
      string,
      unknown
    >;
    expect(offProps).not.toHaveProperty("allowInternalEgress");

    const on = doorsDouble();
    await registerExecutionSystem(on, {
      name: "prod",
      serverUrl: "http://argocd-server.argocd.svc",
      token: SENTINEL,
      tokenKey: "",
      allowInternalEgress: true
    });
    const onProps = on.createExecutionSystem.mock.calls[0]![0].properties as Record<
      string,
      unknown
    >;
    expect(onProps.allowInternalEgress).toBe(true);
  });

  it("normalizes the URL and derives the CLI's default token key", async () => {
    const doors = doorsDouble();
    await registerExecutionSystem(doors, {
      name: "  prod  ",
      serverUrl: "https://argocd.example.com///",
      token: SENTINEL,
      tokenKey: "",
      allowInternalEgress: false
    });
    const req = doors.createExecutionSystem.mock.calls[0]![0];
    expect(req.name).toBe("prod");
    expect((req.properties as { serverUrl: string }).serverUrl).toBe("https://argocd.example.com");
    expect(doors.putSecret).toHaveBeenCalledWith("prod-argocd-token", SENTINEL);
    expect(normalizeServerUrl("https://x/")).toBe("https://x");
    expect(defaultTokenKey("prod")).toBe("prod-argocd-token");
  });

  it("honours an explicit token key, like `--token-key`", async () => {
    const doors = doorsDouble();
    await registerExecutionSystem(doors, {
      name: "prod",
      serverUrl: "https://argocd.example.com",
      token: SENTINEL,
      tokenKey: "shared-argocd",
      allowInternalEgress: false
    });
    expect(doors.putSecret).toHaveBeenCalledWith("shared-argocd", SENTINEL);
    expect(
      (doors.createExecutionSystem.mock.calls[0]![0].properties as { tokenSecretKey: string })
        .tokenSecretKey
    ).toBe("shared-argocd");
  });
});

describe("step 2 names the execution system and sends NOTHING else", () => {
  it("passes only `config.executionSystemId` — never a caller-supplied serverUrl or token", async () => {
    runDiscoverySpy.mockClear();
    await sdkDoors.runDiscovery(SYSTEM_ID, "prod");
    expect(runDiscoverySpy).toHaveBeenCalledTimes(1);
    const req = runDiscoverySpy.mock.calls[0]![0];
    const config = req.config as Record<string, unknown>;
    expect(req.pluginModule).toBe("argocd-discovery");
    expect(req.pluginInstanceId).toBe("prod");
    // The whole ADR-0003 point: the PERSISTED system is the source of truth for where the plugin
    // may talk and with what. A `serverUrl` here would be a caller-supplied address riding an
    // internal-egress grant that was made for a different one.
    expect(Object.keys(config)).toEqual(["executionSystemId"]);
    expect(config.executionSystemId).toBe(SYSTEM_ID);
    expect(req.secretRefs).toBeUndefined();
    expect(req.allowedHosts).toBeUndefined();
  });
});

describe("resuming: only Argo CD systems are offered", () => {
  it("filters by the stored `kind`, and omits a system that declares none", () => {
    const withKind = (kind: unknown): GraphObject =>
      ({ ...systemFixture(), properties: kind === undefined ? {} : { kind } }) as GraphObject;
    // `execution-system` is one type shared by every imported backend — offering a Gitea here would
    // run argocd-discovery against it and fail server-side naming a plugin nobody chose.
    const kept = argoCdSystems([withKind("argocd"), withKind("gitea"), withKind(undefined)]);
    expect(kept).toHaveLength(1);
    expect((kept[0]!.properties as { kind: string }).kind).toBe("argocd");
    expect(argoCdSystems(undefined)).toEqual([]);
  });
});

describe("the review screen counts the proposal it was given", () => {
  it("groups proposed objects by type", () => {
    const proposal: DiscoveryProposal = {
      objects: [
        { typeId: "component", name: "b" },
        { typeId: "component", name: "a" },
        { typeId: "deployment-target", name: "c" }
      ],
      relationships: []
    };
    expect(proposalTypeCounts(proposal)).toEqual([
      ["component", 2],
      ["deployment-target", 1]
    ]);
  });
});
