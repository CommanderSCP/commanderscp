import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScpApiError } from "@scp/sdk";
import {
  COMPONENT,
  ENABLE_CONTRIBUTION,
  UNLOCK_CONTRIBUTION,
  bumpFixture,
  inventoryFixture,
  rowFixture,
  unlockFixture
} from "../test-support/dependency-fixtures";

/**
 * THE DEPENDENCIES TAB — what it renders off the wire, and what it writes
 * (docs/proposals/dependency-subscription-ui.md §4/§5).
 *
 * Plain `renderToStaticMarkup`, no DOM: every pin here is on rendered markup or on a pure builder.
 * The Radix dialogs portal nothing under a string render, so the dialog BODIES are exported and
 * rendered directly (the precedent every pipeline write test follows). The interaction half — the
 * confirm click reaching `client.policies.create` — is `component-dependencies-writes.test.tsx`.
 *
 * MUTATIONS WATCHED TO FAIL (each applied alone, then reverted):
 *   - badge label read off a local recompute (`enabled ? "enabled" : anyDisable ? "opted out" : …`)
 *     instead of `subscription.reason` → "reads reason, never recomputes" RED
 *   - `IgnoredPill` returning null → "ignored contribution is never hidden" RED
 *   - the not-recorded branch rendering the "No dependencies declared" EmptyState → trichotomy RED
 *   - `buildOptOutPolicyRequest` moving the line into `scope` → payload pin RED
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, ...rest }: { children?: React.ReactNode; "data-testid"?: string }) => (
    <a data-testid={rest["data-testid"]}>{children}</a>
  )
}));

vi.mock("../lib/client", () => ({ client: {} }));

const {
  BumpsSection,
  ComponentGateLine,
  ContributionsBody,
  DependenciesView,
  EnableDialogBody,
  InstanceUnlockLine,
  InventoryEmptyState,
  OptOutDialogBody,
  buildEnablePolicyRequest,
  buildOptOutPolicyRequest,
  policyWriteRefusal,
  DIALOG_COPY
} = await import("./component-dependencies");
type ReadState<T> = import("./component-dependencies").ReadState<T>;

const noWrite = {
  onWrite: () => {},
  writeState: { busy: false, error: null, reset: () => {}, lastSuccess: null }
};

type BumpsResponse = {
  component: typeof COMPONENT;
  dependencyManagement: {
    managedHere: boolean;
    reason: "commander" | "outpost" | "retrans" | "role_undeclared";
  };
  rows: ReturnType<typeof bumpFixture>[];
  nextCursor: null;
};
const MANAGED_HERE = { managedHere: true, reason: "commander" } as const;

function renderView(
  over: {
    inventory?: ReturnType<typeof inventoryFixture>;
    /** A response = a successful read; a ReadState = that state verbatim. */
    unlock?: ReturnType<typeof unlockFixture> | ReadState<ReturnType<typeof unlockFixture>>;
    instanceRole?: "commander" | "outpost" | "retrans" | undefined;
    bumps?: BumpsResponse | ReadState<BumpsResponse>;
  } = {}
): string {
  const unlock = over.unlock ?? unlockFixture();
  const bumps = over.bumps ?? {
    component: COMPONENT,
    dependencyManagement: MANAGED_HERE,
    rows: [],
    nextCursor: null
  };
  return renderToStaticMarkup(
    <DependenciesView
      unlock={"status" in unlock ? unlock : { status: "ok", data: unlock }}
      inventory={over.inventory ?? inventoryFixture()}
      bumps={"status" in bumps ? bumps : { status: "ok", data: bumps }}
      instanceRole={"instanceRole" in over ? over.instanceRole : "commander"}
      {...noWrite}
    />
  );
}

function badgeLabel(html: string): string | null {
  const m = html.match(/data-testid="dependency-subscription"[^>]*>([^<]*)</);
  return m ? m[1]! : null;
}

describe("the subscription badge READS `subscription.reason` (never recomputed)", () => {
  it.each([
    ["enabled", "enabled"],
    ["disabled", "opted out"],
    ["not_enabled", "not enabled"],
    ["instance_locked", "instance locked"]
  ] as const)("reason %s → badge %s", (reason, label) => {
    const html = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            subscription: { ...rowFixture().subscription, enabled: reason === "enabled", reason }
          })
        ]
      })
    });
    expect(badgeLabel(html)).toBe(label);
    expect(html).toContain(`data-reason="${reason}"`);
  });

  it("reads reason, never recomputes: a row whose contributions carry ONLY an unlock and an enable but whose reason is `disabled` renders `opted out`", () => {
    // Deliberately inconsistent with any local AND: recomputing from contributions would say
    // enabled. The server's verdict is the only verdict.
    const html = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            subscription: {
              enabled: false,
              reason: "disabled",
              granularity: "patch",
              delivery: "pull_request",
              contributions: [UNLOCK_CONTRIBUTION, ENABLE_CONTRIBUTION]
            }
          })
        ]
      })
    });
    expect(badgeLabel(html)).toBe("opted out");
  });

  it("granularity/delivery are shown only when enabled (they are meaningful only then)", () => {
    const on = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    expect(on).toContain('data-testid="dependency-terms"');
    expect(on).toContain("minor and patch · pull request");
    const off = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            subscription: { ...rowFixture().subscription, enabled: false, reason: "not_enabled" }
          })
        ]
      })
    });
    expect(off).not.toContain('data-testid="dependency-terms"');
  });
});

describe("an `ignored` contribution is NEVER hidden", () => {
  it("renders the amber unknown-tone pill with the reason in its title, beside the badge", () => {
    const html = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            subscription: {
              enabled: true,
              reason: "enabled",
              granularity: "patch",
              delivery: "pull_request",
              contributions: [
                UNLOCK_CONTRIBUTION,
                ENABLE_CONTRIBUTION,
                {
                  tier: "org",
                  source: "policy:opt-out typo@019f0000-0000-7000-8000-00000000f00d",
                  objectTypeId: "org",
                  contributed: "ignored",
                  ignoredReason: "malformed"
                }
              ]
            }
          })
        ]
      })
    });
    const pill = html.match(/<div[^>]*data-testid="dependency-ignored"[^>]*>[\s\S]*?<\/div>/);
    expect(pill).not.toBeNull();
    expect(pill![0]).toContain("text-amber-700");
    expect(pill![0]).toContain("border-dashed");
    expect(pill![0]).toContain("opt-out ignored");
    expect(pill![0]).toContain("did not parse");
    // The row still carries its (server) verdict badge beside the pill.
    expect(badgeLabel(html)).toBe("enabled");
  });

  it("a `condition_unevaluable` ignore (by contract only ever a would-be enable) says so, and is not called an opt-out", () => {
    const html = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            subscription: {
              enabled: false,
              reason: "not_enabled",
              granularity: "patch",
              delivery: "pull_request",
              contributions: [
                UNLOCK_CONTRIBUTION,
                {
                  tier: "service",
                  source: "policy:conditional@019f0000-0000-7000-8000-00000000f00e",
                  objectTypeId: "service",
                  contributed: "ignored",
                  ignoredReason: "condition_unevaluable",
                  selector: {}
                }
              ]
            }
          })
        ]
      })
    });
    expect(html).toContain('data-testid="dependency-ignored"');
    expect(html).toContain("enable ignored");
    expect(html).not.toContain("opt-out ignored");
  });

  it("no ignored contribution → no pill", () => {
    const html = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    expect(html).not.toContain('data-testid="dependency-ignored"');
  });

  it("the Why body lists the ignored contribution with its reason", () => {
    const html = renderToStaticMarkup(
      <ContributionsBody
        heading="x"
        contributions={[
          UNLOCK_CONTRIBUTION,
          {
            tier: "org",
            source: "policy:typo@019f0000-0000-7000-8000-00000000f00d",
            contributed: "ignored",
            ignoredReason: "malformed"
          }
        ]}
      />
    );
    expect(html.match(/data-testid="contribution-row"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="contribution-ignored-reason"');
    expect(html).toContain("(malformed)");
    expect(html).toContain("instance:dependency_subscription_unlock");
  });
});

describe("row honesty: latest, declared/resolved, producer", () => {
  it("`latestVersion: null` renders an em-dash titled not-observed — never a version, never a badge", () => {
    const html = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    const cell = html.match(/<td[^>]*data-testid="dependency-latest"[^>]*>[\s\S]*?<\/td>/)![0];
    expect(cell).toContain("—");
    expect(cell).toContain("Not observed yet");
    expect(cell).not.toContain("text-amber-700");
  });

  it("an observed head renders the version verbatim", () => {
    const html = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            head: {
              latestVersion: "1.9.0",
              latestDigest: null,
              latestObservedAt: "2026-08-15T00:00:00.000Z"
            }
          })
        ]
      })
    });
    const cell = html.match(/<td[^>]*data-testid="dependency-latest"[^>]*>[\s\S]*?<\/td>/)![0];
    expect(cell).toContain("1.9.0");
  });

  it("the coordinate travels verbatim (`@acme/lib`), declared → resolved as stored", () => {
    const html = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    expect(html).toContain("@acme/lib");
    expect(html).toContain("^1.2.3 →");
    expect(html).toContain("1.2.3<");
  });

  it("producer renders `internal (<name>)` ONLY when declared — nothing inferred from the coordinate", () => {
    const declared = renderView({
      inventory: inventoryFixture({
        rows: [
          rowFixture({
            producer: { objectId: "019f0000-0000-7000-8000-00000000beef", name: "acme-lib-svc" }
          })
        ]
      })
    });
    expect(declared).toContain("internal (acme-lib-svc)");
    const undeclared = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    expect(undeclared).not.toContain("internal (");
    expect(undeclared).not.toContain("third-party");
  });
});

describe("empty states never collapse to `No dependencies` for an unknown", () => {
  it("stamp null AND decision null → amber `Ingestion status not recorded — never attempted` + how to ingest, and NOT `No dependencies`", () => {
    const html = renderView({ inventory: inventoryFixture() });
    expect(html).toContain('data-kind="not-recorded"');
    expect(html).toContain("Ingestion status not recorded — never attempted");
    expect(html).toContain("text-amber-700");
    expect(html).toContain("scp dependency-subscriptions backfill-inventory");
    expect(html).not.toContain("No dependencies");
  });

  it("the how-to-ingest copy adds `runs only for enabled components` when the gate is not enabled", () => {
    const locked = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          componentGate: {
            enabled: false,
            reason: "no_enabling_contribution",
            contributions: [UNLOCK_CONTRIBUTION]
          }
        })}
      />
    );
    expect(locked).toContain("Ingestion runs only for enabled components.");
    const open = renderToStaticMarkup(<InventoryEmptyState inventory={inventoryFixture()} />);
    expect(open).not.toContain("Ingestion runs only for enabled components.");
  });

  it("stamp ok + 0 rows → `No dependencies declared — read N dependency manifests` (real pluralization)", () => {
    const one = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          ingestion: {
            lastAttemptAt: "2026-08-15T00:00:00.000Z",
            source: "backfill",
            outcome: "ok",
            rowsWritten: 0,
            detail: null,
            manifests: [
              {
                repo: "acme/checkout",
                path: "package.json",
                outcome: "ok",
                rows: 0,
                at: "2026-08-15T00:00:00.000Z"
              }
            ]
          }
        })}
      />
    );
    expect(one).toContain('data-kind="none-declared"');
    expect(one).toContain("No dependencies declared — read 1 dependency manifest ");
    const two = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          ingestion: {
            lastAttemptAt: "2026-08-15T00:00:00.000Z",
            source: "loop",
            outcome: "ok",
            rowsWritten: 0,
            detail: null,
            manifests: [
              {
                repo: "acme/checkout",
                path: "package.json",
                outcome: "ok",
                rows: 0,
                at: "2026-08-15T00:00:00.000Z"
              },
              {
                repo: "acme/checkout",
                path: "go.mod",
                outcome: "ok",
                rows: 0,
                at: "2026-08-15T00:00:00.000Z"
              }
            ]
          }
        })}
      />
    );
    expect(two).toContain("read 2 dependency manifests");
    expect(two).toContain("go.mod");
  });

  it("stamp unreadable / partial → the file list with each outcome and detail, never `No dependencies`", () => {
    const html = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          ingestion: {
            lastAttemptAt: "2026-08-15T00:00:00.000Z",
            source: "loop",
            outcome: "unreadable",
            rowsWritten: 0,
            detail: null,
            manifests: [
              {
                repo: "acme/checkout",
                path: "package.json",
                outcome: "unreadable",
                rows: 0,
                at: "2026-08-15T00:00:00.000Z",
                detail: "403 from provider"
              }
            ]
          }
        })}
      />
    );
    expect(html).toContain('data-kind="unreadable"');
    expect(html).toContain("acme/checkout:package.json — unreadable: 403 from provider");
    expect(html).not.toContain("No dependencies");
  });

  it("stamp not_enabled → says the component was not enabled when ingestion last ran", () => {
    const html = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          componentGate: { enabled: false, reason: "no_enabling_contribution", contributions: [] },
          ingestion: {
            lastAttemptAt: "2026-08-15T00:00:00.000Z",
            source: "loop",
            outcome: "not_enabled",
            rowsWritten: 0,
            detail: null,
            manifests: []
          }
        })}
      />
    );
    expect(html).toContain('data-kind="not-enabled"');
    expect(html).toContain("was not enabled when ingestion last ran");
    expect(html).not.toContain("No dependencies");
  });

  it("no stamp but a Decision with no skips → `No dependencies declared — read N`; with skips → the file list", () => {
    const clean = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          lastIngestionDecision: {
            decisionId: "019f0000-0000-7000-8000-00000000dec1",
            firstObservedAt: "2026-08-14T00:00:00.000Z",
            manifestPathsRead: ["package.json"],
            manifestPathsAbsent: ["go.mod"],
            skipped: []
          }
        })}
      />
    );
    expect(clean).toContain("No dependencies declared — read 1 dependency manifest");
    expect(clean).toContain("absent: go.mod");
    const skipped = renderToStaticMarkup(
      <InventoryEmptyState
        inventory={inventoryFixture({
          lastIngestionDecision: {
            decisionId: "019f0000-0000-7000-8000-00000000dec1",
            firstObservedAt: "2026-08-14T00:00:00.000Z",
            manifestPathsRead: [],
            manifestPathsAbsent: [],
            skipped: [{ path: "package.json", reason: "parse error" }]
          }
        })}
      />
    );
    expect(skipped).toContain('data-kind="partial"');
    expect(skipped).toContain("package.json — skipped: parse error");
    expect(skipped).not.toContain("No dependencies");
  });

  it("rows present → no empty state at all", () => {
    const html = renderView({ inventory: inventoryFixture({ rows: [rowFixture()] }) });
    expect(html).not.toContain('data-testid="inventory-empty"');
  });
});

describe("the header strip", () => {
  it("instance unlock: three states off {unlocked, updatedAt}, each read-only with the CLI pointer", () => {
    const unlocked = renderToStaticMarkup(<InstanceUnlockLine unlock={unlockFixture()} />);
    expect(unlocked).toContain('data-state="unlocked"');
    expect(unlocked).toContain("by the platform operator");
    const relocked = renderToStaticMarkup(
      <InstanceUnlockLine unlock={unlockFixture({ unlocked: false })} />
    );
    expect(relocked).toContain('data-state="locked"');
    expect(relocked).toContain("set by the platform operator");
    const never = renderToStaticMarkup(
      <InstanceUnlockLine unlock={unlockFixture({ unlocked: false, updatedAt: null })} />
    );
    expect(never).toContain('data-state="never-set"');
    expect(never).toContain("(never set)");
    for (const html of [unlocked, relocked, never]) {
      expect(html).toContain("scp dependency-subscriptions set-unlock --unlocked");
      expect(html).not.toMatch(/<button/);
    }
  });

  it("instance unlock read PENDING → a skeleton, never `could not be read`; FAILED → `—` titled could not be read + the diagnosis", () => {
    const pending = renderView({ unlock: { status: "pending" } });
    expect(pending).toContain('data-testid="instance-unlock-pending"');
    expect(pending).not.toContain("could not be read");
    expect(pending).not.toContain('data-testid="instance-unlock"');
    const failed = renderView({
      unlock: { status: "error", error: new Error("getDependencySubscriptionUnlock: 502") }
    });
    expect(failed).toContain('data-testid="instance-unlock-unreadable"');
    expect(failed).toContain(
      "The instance unlock could not be read: getDependencySubscriptionUnlock: 502"
    );
    expect(failed).not.toContain('data-testid="instance-unlock-pending"');
  });

  it("component gate: switches on componentGate.reason (its own vocabulary), naming the enabler's source and tier", () => {
    const enabled = renderToStaticMarkup(
      <ComponentGateLine gate={inventoryFixture().componentGate} onWhy={() => {}} />
    );
    expect(enabled).toContain('data-reason="enabled"');
    expect(enabled).toContain(ENABLE_CONTRIBUTION.source);
    expect(enabled).toContain("(component)");
    const none = renderToStaticMarkup(
      <ComponentGateLine
        gate={{
          enabled: false,
          reason: "no_enabling_contribution",
          contributions: [UNLOCK_CONTRIBUTION]
        }}
        onWhy={() => {}}
      />
    );
    expect(none).toContain("no enabling policy at any tier");
    const locked = renderToStaticMarkup(
      <ComponentGateLine
        gate={{ enabled: false, reason: "instance_locked", contributions: [] }}
        onWhy={() => {}}
      />
    );
    expect(locked).toContain("instance locked");
    for (const html of [enabled, none, locked])
      expect(html).toContain('data-testid="component-gate-why"');
  });

  it("the enable offer is rendered for every viewer (the server refuses; the SPA cannot pre-check)", () => {
    const html = renderView();
    expect(html).toContain('data-testid="enable-open"');
    expect(html).toContain("Enable dependency subscriptions for this component");
  });
});

describe("the two policy documents — exact wire shapes", () => {
  it("enable: objectRef scope, enforcement present, effect enabled:true with granularity/delivery, domainId = THE COMPONENT ITSELF", () => {
    expect(
      buildEnablePolicyRequest({
        component: COMPONENT,
        granularity: "minor_and_patch",
        delivery: "auto_merge"
      })
    ).toEqual({
      name: "dependency subscription: checkout-api",
      domainId: COMPONENT.id,
      properties: {
        enforcement: "advisory",
        scope: { objectRef: COMPONENT.id },
        effects: [
          {
            dependencySubscription: {
              enabled: true,
              granularity: "minor_and_patch",
              delivery: "auto_merge"
            }
          }
        ]
      }
    });
  });

  it("enable: domainId is the component's own id even when it has NO containment domain (org-root) — never the containment domain, never omitted", () => {
    // POST /policies authorizes policy:write at `domainId ?? org` and RBAC expands upward from
    // there: the containment domain would refuse a component-bound team; omitting it would refuse
    // everyone below the org root. The component itself admits component-, domain- and org-bound
    // administrators alike, and the policy lands contained by the component.
    const req = buildEnablePolicyRequest({
      component: { ...COMPONENT, domainId: null },
      granularity: "patch",
      delivery: "pull_request"
    });
    expect(req.domainId).toBe(COMPONENT.id);
    const contained = buildEnablePolicyRequest({
      component: COMPONENT,
      granularity: "patch",
      delivery: "pull_request"
    });
    expect(contained.domainId).toBe(COMPONENT.id);
    expect(contained.domainId).not.toBe(COMPONENT.domainId);
  });

  it("opt out: SAME objectRef scope, the line at the EFFECT level (coordinate verbatim, major as a string), enabled:false", () => {
    const req = buildOptOutPolicyRequest({ component: COMPONENT, line: rowFixture().line });
    expect(req).toEqual({
      name: "dependency opt-out: @acme/lib 1 for checkout-api",
      domainId: COMPONENT.id,
      properties: {
        enforcement: "advisory",
        scope: { objectRef: COMPONENT.id },
        effects: [
          {
            dependencySubscription: {
              enabled: false,
              ecosystem: "npm",
              coordinate: "@acme/lib",
              major: "1"
            }
          }
        ]
      }
    });
    // The scope carries ONLY the objectRef — no line selector, no selector, no group.
    expect(Object.keys((req.properties as { scope: Record<string, unknown> }).scope)).toEqual([
      "objectRef"
    ]);
  });

  it("neither document ever names a group scope", () => {
    for (const req of [
      buildEnablePolicyRequest({
        component: COMPONENT,
        granularity: "patch",
        delivery: "pull_request"
      }),
      buildOptOutPolicyRequest({ component: COMPONENT, line: rowFixture().line })
    ]) {
      expect(JSON.stringify(req)).not.toMatch(/group/i);
      expect(JSON.stringify(req)).not.toMatch(/selector/i);
    }
  });
});

describe("refusals are rendered, with the decision_id when the server sent one", () => {
  it("403 → names policy:write at this component (or above) + the server's detail", () => {
    const r = policyWriteRefusal(
      new ScpApiError("Forbidden", {
        status: 403,
        problem: {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "policy:write is required at org"
        }
      })
    );
    expect(r.message).toContain("policy:write at this component (or above)");
    expect(r.message).toContain("policy:write is required at org");
    expect(r.decisionId).toBeUndefined();
  });

  it("409 → the detail + the decision_id, and the body renders a Why link with that id", () => {
    const err = new ScpApiError("Conflict", {
      status: 409,
      problem: {
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "acme/checkout is updated by renovate (renovate.json)",
        decision_id: "019f0000-0000-7000-8000-00000000d0d0"
      }
    });
    const r = policyWriteRefusal(err);
    expect(r.decisionId).toBe("019f0000-0000-7000-8000-00000000d0d0");
    expect(r.message).toContain("renovate");
    const html = renderToStaticMarkup(
      <EnableDialogBody
        component={COMPONENT}
        busy={false}
        error={err}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain('data-testid="enable-error"');
    expect(html).toContain("renovate");
    expect(html).toContain('data-testid="enable-error-why"');
    expect(html).toContain("019f0000-0000-7000-8000-00000000d0d0");
    const optOut = renderToStaticMarkup(
      <OptOutDialogBody
        component={COMPONENT}
        line={rowFixture().line}
        busy={false}
        error={err}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(optOut).toContain('data-testid="opt-out-error-why"');
  });

  it("any other error → the message as received, no fabricated Why link", () => {
    const html = renderToStaticMarkup(
      <EnableDialogBody
        component={COMPONENT}
        busy={false}
        error={new Error("network down")}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain("network down");
    expect(html).not.toContain("Why?");
  });

  it("no error → no refusal rendered", () => {
    const html = renderToStaticMarkup(
      <EnableDialogBody
        component={COMPONENT}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).not.toContain('data-testid="enable-error"');
  });
});

describe("the enable dialog body", () => {
  it("offers granularity (patch | minor_and_patch) and delivery (pull_request | auto_merge) and states the first bump is always a pull request", () => {
    const html = renderToStaticMarkup(
      <EnableDialogBody
        component={COMPONENT}
        busy={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    for (const id of [
      "enable-granularity-patch",
      "enable-granularity-minor_and_patch",
      "enable-delivery-pull_request",
      "enable-delivery-auto_merge",
      "enable-confirm"
    ])
      expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("The first bump is always a pull request.");
    expect(html).toContain("every enabling policy asks for it");
    // Never a bare "Subscribe" control, never a scope picker.
    expect(html).not.toMatch(/\bsubscribe\b/i);
    expect(html).not.toMatch(/group/i);
  });
});

describe("the bumps section", () => {
  it("commander: a row per bump, PR as `#n` text only when the URL is not stored (no link), merge state + Why", () => {
    const html = renderView({
      bumps: {
        component: COMPONENT,
        dependencyManagement: MANAGED_HERE,
        rows: [
          bumpFixture(),
          bumpFixture({
            changeId: "019f0000-0000-7000-8000-00000000c4a2",
            pullRequestNumber: 43,
            mergedAt: "2026-08-16T00:00:00.000Z",
            merge: {
              verdict: "merged",
              decisionId: "019f0000-0000-7000-8000-00000000d0d1",
              evaluatedAt: "2026-08-16T00:00:00.000Z"
            }
          })
        ],
        nextCursor: null
      }
    });
    expect(html.match(/data-testid="bump-row"/g)).toHaveLength(2);
    expect(html).toContain("#42");
    expect(html).not.toMatch(/<a[^>]*href="[^"]*42/);
    expect(html).toContain("not merged");
    expect(html).toContain("merged ");
    expect(html).toContain('data-testid="bump-merge-why"');
    expect(html).toContain("1.2.3 → 1.2.4");
    expect(html).not.toContain('data-testid="bumps-not-commander"');
  });

  it("the PR cell LINKS to `pullRequestUrl` when the server stored one (external, noopener) and shows `#n` text otherwise — never a composed link", () => {
    const html = renderView({
      bumps: {
        component: COMPONENT,
        dependencyManagement: MANAGED_HERE,
        rows: [
          bumpFixture({ pullRequestUrl: "https://git.example.test/acme/checkout/pull/42" }),
          bumpFixture({
            changeId: "019f0000-0000-7000-8000-00000000c4a2",
            pullRequestNumber: 43,
            pullRequestUrl: null
          })
        ],
        nextCursor: null
      }
    });
    const link = html.match(/<a[^>]*data-testid="bump-pr-link"[^>]*>#42<\/a>/)?.[0] ?? "";
    expect(link).toContain('href="https://git.example.test/acme/checkout/pull/42"');
    expect(link).toContain('target="_blank"');
    expect(link).toMatch(/rel="[^"]*noopener[^"]*"/);
    // #43 has no stored URL: text only, and nothing composed from repo + number.
    expect(html).toContain("#43");
    expect(html).not.toMatch(/<a[^>]*href="[^"]*43/);
    expect(html).not.toMatch(/href="[^"]*acme\/checkout\/pull\/43/);
  });

  it("the server's `dependencyManagement.managedHere: false` on the bumps read → the commander pointer and NO table, even on a commander-role client (the wire is the authority)", () => {
    const html = renderToStaticMarkup(
      <BumpsSection
        bumps={{
          status: "ok",
          data: {
            component: COMPONENT,
            dependencyManagement: { managedHere: false, reason: "outpost" },
            rows: [bumpFixture()],
            nextCursor: null
          }
        }}
        instanceRole="commander"
      />
    );
    expect(html).toContain('data-testid="bumps-not-commander"');
    expect(html).not.toContain('data-testid="bump-row"');
    expect(html).not.toContain("No bumps yet.");
  });

  it("commander with a SUCCESSFUL read of zero bumps → `No bumps yet.`", () => {
    const html = renderView();
    expect(html).toContain("No bumps yet.");
    expect(html).toContain('data-testid="bumps-empty"');
  });

  it("commander while the bumps read is PENDING → a skeleton, never `No bumps yet.`", () => {
    const html = renderView({ bumps: { status: "pending" } });
    expect(html).toContain('data-testid="bumps-pending"');
    expect(html).not.toContain("No bumps yet.");
    expect(html).not.toContain('data-testid="bumps-empty"');
  });

  it("commander when the bumps read FAILED → the amber unknown pill with the diagnosis, never `No bumps yet.`", () => {
    const html = renderView({
      bumps: { status: "error", error: new Error("listComponentDependencyBumps: 503") }
    });
    expect(html).toContain('data-testid="bumps-unreadable"');
    expect(html).toContain("Bumps could not be read");
    expect(html).toContain("listComponentDependencyBumps: 503");
    expect(html).not.toContain("No bumps yet.");
    expect(html).not.toContain('data-testid="bump-row"');
  });

  it("the Merge cell is READ, never inferred: no pull request reported → `—` (not `open`); a PR number with no merge record → `not merged`", () => {
    const noPr = renderToStaticMarkup(
      <BumpsSection
        bumps={{
          status: "ok",
          data: {
            component: COMPONENT,
            dependencyManagement: MANAGED_HERE,
            rows: [bumpFixture({ pullRequestNumber: null, mergedAt: null, merge: null })],
            nextCursor: null
          }
        }}
        instanceRole="commander"
      />
    );
    const mergeCell = noPr.match(/data-testid="bump-merge"[^>]*>(.*?)<\/td>/)?.[1] ?? "";
    expect(mergeCell).toContain("—");
    expect(mergeCell).not.toMatch(/\bopen\b/);
    expect(mergeCell).not.toContain("not merged");
    expect(mergeCell).toContain("no pull request has been reported");

    const withPr = renderToStaticMarkup(
      <BumpsSection
        bumps={{
          status: "ok",
          data: {
            component: COMPONENT,
            dependencyManagement: MANAGED_HERE,
            rows: [bumpFixture({ pullRequestNumber: 42, mergedAt: null, merge: null })],
            nextCursor: null
          }
        }}
        instanceRole="commander"
      />
    );
    const withPrCell = withPr.match(/data-testid="bump-merge"[^>]*>(.*?)<\/td>/)?.[1] ?? "";
    expect(withPrCell).toContain("not merged");
    expect(withPrCell).not.toMatch(/\bopen\b/);
  });

  it.each(["outpost", "retrans", undefined] as const)(
    "instanceRole %s → the sentence `Bumps are dispatched by the commander.` and NO table",
    (role) => {
      const html = renderToStaticMarkup(
        <BumpsSection
          bumps={{
            status: "ok",
            data: {
              component: COMPONENT,
              dependencyManagement: MANAGED_HERE,
              rows: [bumpFixture()],
              nextCursor: null
            }
          }}
          instanceRole={role}
        />
      );
      expect(html).toContain('data-testid="bumps-not-commander"');
      expect(html).toContain("Bumps are dispatched by the commander.");
      expect(html).not.toContain('data-testid="bump-row"');
      expect(html).not.toContain("No bumps yet.");
    }
  );
});

describe("vocabulary and copy rules over the whole rendered tab", () => {
  const rows = [
    rowFixture(),
    rowFixture({
      line: {
        id: "019f0000-0000-7000-8000-00000000aaa2",
        ecosystem: "oci",
        coordinate: "alpine",
        major: "3.18",
        tagPattern: "3.18.*"
      },
      subscription: {
        enabled: false,
        reason: "disabled",
        granularity: "patch",
        delivery: "pull_request",
        contributions: []
      }
    })
  ];
  const tab = renderView({
    inventory: inventoryFixture({
      rows: [
        rowFixture(),
        rowFixture({
          line: {
            id: "019f0000-0000-7000-8000-00000000aaa2",
            ecosystem: "oci",
            coordinate: "alpine",
            major: "3.18",
            tagPattern: "3.18.*"
          },
          subscription: {
            enabled: false,
            reason: "disabled",
            granularity: "patch",
            delivery: "pull_request",
            contributions: []
          }
        })
      ]
    }),
    bumps: {
      component: COMPONENT,
      dependencyManagement: MANAGED_HERE,
      rows: [bumpFixture()],
      nextCursor: null
    }
  });
  // The dialogs portal nothing under a static render, so their bodies (and the empty states the
  // tab above does not show because it has rows) are rendered into the same sweep, and the dialog
  // DESCRIPTIONS are swept as the strings the JSX reads.
  const bodies = [
    <EnableDialogBody
      key="enable"
      component={COMPONENT}
      busy={false}
      error={null}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
    <OptOutDialogBody
      key="opt-out"
      component={COMPONENT}
      line={rows[0]!.line}
      busy={false}
      error={null}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
    <ContributionsBody
      key="why"
      heading="Row contributions"
      contributions={rows[0]!.subscription.contributions}
    />,
    <InventoryEmptyState key="empty" inventory={inventoryFixture()} />
  ].map((el) => renderToStaticMarkup(el));
  const html = [tab, ...bodies].join("\n");
  // Every `title="…"` attribute value is swept TOO — a tooltip is rendered copy; stripping tags
  // first would silently exempt it (the badge title once said "subscribed" and passed).
  const titles = [...html.matchAll(/\btitle="([^"]*)"/g)].map((m) => m[1]!).join("\n");
  const text = [html.replace(/<[^>]+>/g, " "), titles, ...Object.values(DIALOG_COPY)].join("\n");

  it("sweeps title attributes (a control: the badge title IS in the swept text)", () => {
    expect(titles).toContain(
      "the instance is unlocked, a policy enables it and nothing opts it out."
    );
    expect(text).toContain(
      "the instance is unlocked, a policy enables it and nothing opts it out."
    );
  });

  it("never a bare `subscribe`/`subscribed`, and every `subscription` is spelled in full as `dependency subscription`", () => {
    expect(text).not.toMatch(/\bsubscribe[ds]?\b/i);
    const bare = text.match(/(?<!dependency[- ])\bsubscriptions?\b/gi) ?? [];
    expect(bare).toEqual([]);
  });

  it("no `group` anywhere on the tab", () => {
    expect(text).not.toMatch(/\bgroup\b/i);
  });

  it("no milestone or ADR codes in rendered copy", () => {
    expect(text).not.toMatch(/\bM2\d(\.\d)?\b/);
    expect(text).not.toMatch(/ADR-\d+/);
  });
});
