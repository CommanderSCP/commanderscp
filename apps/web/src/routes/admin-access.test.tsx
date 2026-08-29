// @vitest-environment happy-dom
import { act } from "react";
import { readFile } from "node:fs/promises";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScpApiError } from "@scp/sdk";
import type { EffectivePermissionsResponse, Role, RoleBinding } from "@scp/schemas";
import { fire, render, typeInto } from "../test-support/render-dom";

/**
 * ADMIN › ACCESS — the wired-up page against a stubbed SDK (role-model.md §5 steps 5, 6, 10).
 *
 * What is pinned, and the mutation each pin exists to catch:
 *
 *   - the page READS all three surfaces (`roles.list`, `roleBindings.list`, `authz.effective`) —
 *     a `return;` in any of them, or a component that renders static text instead of querying,
 *     goes RED on the call log;
 *   - INSTANCE-TIER CREDENTIALS ARE NEVER REACHED FROM THE BROWSER, pinned the two ways Admin ›
 *     Governance had to pin the same property: clicking every control never records an
 *     `operatorCredentials.*` call, AND the page's own source never mentions the methods. The
 *     first pin alone was defeated on that page by a real wired button named off-pattern, so both
 *     are kept here;
 *   - `authz.effective` is called with the SCOPE THE USER TYPED, not the default — a form that
 *     ignored its input would otherwise answer confidently about the wrong object;
 *   - a DENY binding renders as `danger`, never as an ordinary row: a deny overrides every allow
 *     at any matching scope, and a reader who skims past it has the answer backwards;
 *   - a role's `deprecated` flag renders as "no new bindings", not "deprecated" — D5 leaves every
 *     EXISTING binding resolving, and "deprecated" reads as inert;
 *   - an empty effective-permission set renders "you hold no permissions", never an empty table —
 *     "nothing here" and "we could not ask" are different facts and the endpoint distinguishes them.
 */

const ORG_ID = "019f0000-0000-7000-8000-0000000000f1";
const OTHER_ID = "019f0000-0000-7000-8000-0000000000c1";

const BUILTIN: Role = {
  id: "019f0000-0000-7000-8000-0000000000r1",
  orgId: null,
  name: "Owner",
  permissions: ["object:write", "object:read"],
  bindableAt: null,
  deprecated: false,
  deprecationReason: null
};
const DEPRECATED: Role = {
  ...BUILTIN,
  id: "019f0000-0000-7000-8000-0000000000r2",
  name: "Administrator",
  deprecated: true,
  deprecationReason: "use OrgAdmin instead"
};
const ORG_ROLE: Role = {
  id: "019f0000-0000-7000-8000-0000000000r3",
  orgId: ORG_ID,
  name: "Release Captain",
  permissions: ["change:accept"],
  bindableAt: ["service"],
  deprecated: false,
  deprecationReason: null
};

const ALLOW: RoleBinding = {
  id: "019f0000-0000-7000-8000-0000000000b1",
  subjectId: "019f0000-0000-7000-8000-0000000000s1",
  roleId: BUILTIN.id,
  roleName: "Owner",
  scopeObjectId: ORG_ID,
  effect: "allow",
  createdAt: "2026-08-28T00:00:00.000Z"
};
const DENY: RoleBinding = {
  ...ALLOW,
  id: "019f0000-0000-7000-8000-0000000000b2",
  roleName: "Viewer",
  effect: "deny"
};

const calls: { method: string; arg?: unknown }[] = [];

let rolesImpl = async (): Promise<{ items: Role[] }> => ({
  items: [BUILTIN, DEPRECATED, ORG_ROLE]
});
let bindingsImpl = async (): Promise<{ items: RoleBinding[]; nextCursor: string | null }> => ({
  items: [ALLOW, DENY],
  nextCursor: null
});
let effectiveImpl = async (scopeObjectId: string): Promise<EffectivePermissionsResponse> => ({
  scopeObjectId,
  permissions: ["object:read"],
  contributingBindings: [
    {
      roleId: BUILTIN.id,
      roleName: "Owner",
      scopeObjectId,
      viaSubjectId: "019f0000-0000-7000-8000-0000000000s1",
      effect: "allow"
    }
  ]
});

const RESET_ROLES = rolesImpl;
const RESET_BINDINGS = bindingsImpl;
const RESET_EFFECTIVE = effectiveImpl;

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
    <a href={to}>{children}</a>
  )
}));

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      orgId: ORG_ID,
      orgName: "acme",
      instanceRole: "commander",
      userId: "019f0000-0000-7000-8000-00000000u001",
      username: "admin",
      subjectObjectId: "019f0000-0000-7000-8000-00000000ad01"
    },
    isLoading: false,
    refresh: async () => {}
  })
}));

vi.mock("../lib/client", () => ({
  client: {
    roles: {
      list: async () => {
        calls.push({ method: "roles.list" });
        return rolesImpl();
      },
      /** STUBBED SO A CALL WOULD BE VISIBLE — the page offers no authoring form today. */
      create: async () => {
        calls.push({ method: "roles.create" });
        return BUILTIN;
      }
    },
    roleBindings: {
      list: async () => {
        calls.push({ method: "roleBindings.list" });
        return bindingsImpl();
      }
    },
    authz: {
      effective: async (scopeObjectId: string) => {
        calls.push({ method: "authz.effective", arg: scopeObjectId });
        return effectiveImpl(scopeObjectId);
      }
    },
    /** STUBBED PURELY SO A CALL WOULD BE VISIBLE. The page must never reach these — the write is
     *  gated by `x-scp-operator-token`, a deployment credential this browser never holds. */
    operatorCredentials: {
      list: async () => {
        calls.push({ method: "operatorCredentials.list" });
        return { items: [], callerMechanism: "credential" as const };
      },
      create: async () => {
        calls.push({ method: "operatorCredentials.create" });
        throw new Error("must never be called from the browser");
      },
      revoke: async () => {
        calls.push({ method: "operatorCredentials.revoke" });
        throw new Error("must never be called from the browser");
      }
    }
  }
}));

const { AdminAccessPage } = await import("./admin-access");

/** Each mount gets its OWN QueryClient — a shared one would let a previous case's cached read
 *  satisfy the next, and every call-log assertion here would then depend on test order. */
async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <AdminAccessPage />
    </QueryClientProvider>
  );
  // Poll until the reads have painted. A fixed zero-delay tick is not enough — react-query
  // resolves across several microtask turns, and asserting too early reads as "the page renders
  // nothing", which is indistinguishable from a genuinely broken page.
  // Wait on the CALL LOG, not on rendered text. The first version waited for "Roles" and matched
  // the section heading, which is painted before any query resolves — so every content assertion
  // ran against an empty table and read as a broken page.
  await waitUntil(
    () =>
      calls.some((c) => c.method === "roles.list") &&
      calls.some((c) => c.method === "roleBindings.list"),
    "the reads to be issued"
  );
  await settle();
  await settle();
  return view;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(() => {
  calls.length = 0;
  rolesImpl = RESET_ROLES;
  bindingsImpl = RESET_BINDINGS;
  effectiveImpl = RESET_EFFECTIVE;
  vi.restoreAllMocks();
});

describe("Admin › Access", () => {
  it("reads all three surfaces on mount", async () => {
    const { container } = await mount();
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("roles.list");
    expect(methods).toContain("roleBindings.list");
    // The default scope is the org root, so the effective query runs without the user typing.
    expect(methods).toContain("authz.effective");
    expect(container.textContent).toContain("Release Captain");
  });

  it("renders a deprecated built-in as 'no new bindings', never as inert", async () => {
    const { container } = await mount();
    // D5 leaves every EXISTING binding resolving; "deprecated" alone would read as switched off,
    // which is both wrong and alarming to somebody who holds it.
    expect(container.textContent).toContain("no new bindings");
    expect(container.textContent).toContain("use OrgAdmin instead");
  });

  it("distinguishes built-in from organization roles", async () => {
    const { container } = await mount();
    expect(container.textContent).toContain("built-in");
    expect(container.textContent).toContain("organization");
  });

  it("renders a DENY binding as a danger badge", async () => {
    const { container } = await mount();
    // A deny overrides every allow at any matching scope. If it renders like an ordinary row, a
    // reader skimming the table has the answer exactly backwards.
    const denyCells = [...container.querySelectorAll("div")].filter(
      (el) => el.textContent === "deny"
    );
    expect(denyCells.length).toBeGreaterThan(0);
    expect(denyCells.some((el) => el.className.includes("red"))).toBe(true);
  });

  it("asks about the scope the USER TYPED, not the default", async () => {
    const { container } = await mount();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Object id"]');
    expect(input).not.toBeNull();
    await typeInto(input!, OTHER_ID);
    const form = container.querySelector("form");
    fire(form!, new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    // A form that ignored its input would answer confidently about the wrong object — the worst
    // failure this page can have, because the answer still looks authoritative.
    const asked = calls.filter((c) => c.method === "authz.effective").map((c) => c.arg);
    expect(asked).toContain(OTHER_ID);
  });

  it("says 'you hold no permissions' rather than rendering an empty table", async () => {
    effectiveImpl = async (scopeObjectId) => ({
      scopeObjectId,
      permissions: [],
      contributingBindings: []
    });
    const { container } = await mount();
    // "You hold nothing here" and "we could not ask" are different facts; the endpoint returns 200
    // vs 404 precisely so a UI can tell them apart, and an empty table would blur them.
    expect(container.textContent).toContain("You hold no permissions at this object");
  });

  it("renders the SERVER'S refusal when the bindings read is forbidden", async () => {
    bindingsImpl = async () => {
      // Message carries the detail, which is what the real SDK produces and what
      // `queryErrorMessage` renders — a stub whose message were only "Forbidden" would make this
      // assertion test the stub rather than the page.
      throw new ScpApiError("Forbidden: requires 'audit:read' at the organization root", {
        status: 403
      });
    };
    const { container } = await mount();
    // The offer-the-write rule's other half: a viewer without `audit:read` must see WHY, not an
    // empty table that reads as "nobody holds anything".
    expect(container.textContent).toContain("audit:read");
  });

  it("NEVER calls an operator-credential method, however hard the page is clicked", async () => {
    const { container } = await mount();
    for (const el of container.querySelectorAll("button, a, [role='button']")) {
      fire(el, new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    await settle();
    // Pin 1 of 2. The write is gated by a deployment credential this browser never holds, so a
    // form here could only ever 403 — and a LISTING would mean sending that token from a browser.
    expect(calls.filter((c) => c.method.startsWith("operatorCredentials."))).toEqual([]);
  });

  it("and the page's own source never mentions those methods", async () => {
    const source = await readFile(`${process.cwd()}/src/routes/admin-access.tsx`, "utf8");
    expect(source.length).toBeGreaterThan(1000);
    // Pin 2 of 2, and the reason it exists: on Admin › Governance the click-based pin alone was
    // defeated twice by a real wired control — once named off-pattern, once with no testid — and
    // the suite stayed green both times. A source check cannot be dodged that way.
    expect(source).not.toMatch(/operatorCredentials\s*\.\s*(create|revoke|list)/);
    // The section must still EXIST and name the CLI, or an operator concludes the surface does not.
    expect(source).toContain("scp operator-credential");
  });
});
