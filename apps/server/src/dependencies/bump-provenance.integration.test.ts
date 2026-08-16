import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import { v7 as uuidv7 } from "uuid";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, objects } from "../db/schema.js";
import { processChangeSourceEvents } from "../coordination/webhook-processor.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { insertControlRun, upsertControlBinding } from "../governance/controls-repo.js";
import {
  assertComponentNotDelegated,
  readAuthoredBumpClaim,
  recordBumpChange,
  resolveEffectiveDelivery
} from "./bump-actuator.js";
import { DEPENDENCY_DELEGATION_DECISION_KIND } from "./delegation-detection.js";
import { readBumpAuthorship } from "./bump-authorship-repo.js";
import { upsertDependencyLine } from "./dependency-inventory-repo.js";

/**
 * M21.5 — THE TWO THINGS THE SERVER SIDE OF `scp-managed-dep` HAS TO GET RIGHT, END TO END
 * (charter amendment 2026-08-13; ADR-0032 §8, §9).
 *
 * ================================================================================================
 * 1. THE ENABLEMENT-TIME CONFLICT REFUSAL — at the choke point, not at the route
 * ================================================================================================
 * "CommanderSCP refuses to enable dependency subscriptions for a component whose repository already
 * delegates the same manifests to another dependency-update system." That refusal is what makes
 * "opting a component in is itself the gate-1 flip" (ADR-0032 §8) a true statement instead of an
 * aspiration: a flip only means something if it is exclusive, and two actuators editing one file is
 * the failure it invites.
 *
 * It is installed at `graph/objects-repo.ts`'s `createObject`/`updateObject` for exactly the reasons
 * `subscription-authoring-guard.ts`'s header sets out and `subscription-guard-write-doors.integration.test.ts`
 * MEASURED for its sibling: the typed `/policies` route is not the boundary, and three free-form-`typeId`
 * doors reach `createObject` with the same document. So this file exercises the typed route AND the
 * IaC door AND hand-fill, because a refusal installed in one of them is a refusal with three holes.
 *
 * ================================================================================================
 * 2. THE PROVENANCE LOOP — SCP's own commit must come back as itself
 * ================================================================================================
 * ADR-0032 §9: "A commit SCP authors is observed back in via the normal webhook path, so the bump
 * change must be recorded such that the returning event CORRELATES TO IT rather than minting a
 * second, unrelated change."
 *
 * The webhook is REPLAYED here, through the real `extractHint` → real github adapter → real
 * `processChangeSourceEvents`, with a real GitHub push payload. The assertion that matters is the
 * NEGATIVE one: no second change object exists afterwards. A test that only checked the event was
 * attached would pass while a duplicate sat beside it.
 *
 * The forgery case is the other half and is not optional: the branch name is attacker-typable, so a
 * push to `scp/dep-bump/<some-uuid>` from a repository the change never claimed must NOT attach.
 */
describe("M21.5 scp-managed-dep: enablement conflict refusal + the provenance loop (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "managed-dep");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  const inOrg = <T>(fn: (tx: Parameters<typeof insertDecision>[0]) => Promise<T>): Promise<T> =>
    withTenantTx(server.deps.db, org.orgId, fn);

  /** Record the standing "this repository delegates" verdict the guards read — the same row
   *  `recordDelegationProbe` writes, planted directly so this test is about the REFUSAL rather than
   *  about a provider read. */
  async function plantDelegation(componentObjectId: string, configPath: string): Promise<string> {
    const decision = await inOrg((tx) =>
      insertDecision(tx, {
        orgId: org.orgId,
        kind: DEPENDENCY_DELEGATION_DECISION_KIND,
        subjectId: componentObjectId,
        verdict: "block",
        inputContext: {
          repo: "acme/widget",
          ref: "refs/heads/main",
          collisions: [
            {
              configPath,
              tool: configPath.includes("dependabot") ? "dependabot" : "renovate",
              manifestPaths: ["package.json"]
            }
          ]
        },
        reasonTree: { summary: "delegated" }
      })
    );
    return decision.id;
  }

  async function expectApiError(call: Promise<unknown>, status: number, detail: RegExp) {
    await call.then(
      () => {
        throw new Error(`expected the call to fail with HTTP ${status}, but it succeeded`);
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(ScpApiError);
        const apiError = err as ScpApiError;
        expect(apiError.status, `detail was: ${apiError.problem?.detail ?? "<none>"}`).toBe(status);
        expect(apiError.problem?.detail ?? "").toMatch(detail);
      }
    );
  }

  async function policyRowsByUrn(urn: string) {
    return inOrg((tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "policy"),
            eq(objects.urn, urn),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  // ---------------------------------------------------------------------------------------------
  // 1. THE ENABLEMENT-TIME CONFLICT REFUSAL
  // ---------------------------------------------------------------------------------------------

  it("refuses to ENABLE subscriptions for a component whose repo delegates — naming the file found", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-deleg-${randomUUID().slice(0, 8)}`
    });
    const decisionId = await plantDelegation(component.id, ".github/dependabot.yml");
    const urn = `urn:scp:${org.orgId}:policy:enable-${randomUUID().slice(0, 8)}`;

    await admin.policies
      .create({
        name: "enable-on-a-delegated-component",
        urn,
        properties: {
          scope: { objectRef: component.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      })
      .then(
        () => {
          throw new Error("expected a 409 refusal");
        },
        (err: unknown) => {
          const apiError = err as ScpApiError;
          expect(apiError.status).toBe(409);
          // THE MESSAGE NAMES THE FILE. An operator cannot act on "a conflict was detected".
          expect(apiError.problem?.detail ?? "").toContain(".github/dependabot.yml");
          // …and carries the probe's decision id (charter principle 6: every blocked response does).
          expect((apiError.problem as { decision_id?: string } | undefined)?.decision_id).toBe(
            decisionId
          );
        }
      );

    expect(
      await policyRowsByUrn(urn),
      "a refusal that still stored the row is not a refusal"
    ).toHaveLength(0);
  });

  it("does NOT refuse an OPT-OUT — turning authoring off for a delegated component is the right direction", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-optout-${randomUUID().slice(0, 8)}`
    });
    await plantDelegation(component.id, "renovate.json");

    const policy = await admin.policies.create({
      name: `optout-${randomUUID().slice(0, 8)}`,
      urn: `urn:scp:${org.orgId}:policy:optout-${randomUUID().slice(0, 8)}`,
      properties: {
        scope: { objectRef: component.id },
        enforcement: "advisory",
        effects: [{ dependencySubscription: { enabled: false } }]
      }
    });
    expect(policy.id).toBeTruthy();
  });

  it("does NOT refuse an enable for a component with NO delegation on record — absent means not observed", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-clean-${randomUUID().slice(0, 8)}`
    });
    const policy = await admin.policies.create({
      name: `clean-${randomUUID().slice(0, 8)}`,
      urn: `urn:scp:${org.orgId}:policy:clean-${randomUUID().slice(0, 8)}`,
      properties: {
        scope: { objectRef: component.id },
        enforcement: "advisory",
        effects: [{ dependencySubscription: { enabled: true } }]
      }
    });
    expect(policy.id).toBeTruthy();
  });

  it("refuses through the IaC door too — the typed route was never the boundary", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-iac-${randomUUID().slice(0, 8)}`
    });
    await plantDelegation(component.id, "renovate.json");

    const stackName = `dep-iac-${randomUUID().slice(0, 8)}`;
    const urn = `urn:scp:${stackName}:policy:smuggled-enable`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn,
          typeId: "policy",
          name: "smuggled-enable",
          properties: {
            scope: { objectRef: component.id },
            enforcement: "advisory",
            effects: [{ dependencySubscription: { enabled: true } }]
          }
        }
      ],
      relationships: []
    };
    const plan = await admin.plans.create(manifest);
    await expectApiError(admin.plans.apply(plan.id), 409, /renovate\.json/);
    expect(await policyRowsByUrn(urn)).toHaveLength(0);
  });

  it("refuses an UPDATE that turns an inert policy into an enabling one", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-upd-${randomUUID().slice(0, 8)}`
    });
    await plantDelegation(component.id, ".renovaterc");

    const created = await admin.policies.create({
      name: `later-${randomUUID().slice(0, 8)}`,
      urn: `urn:scp:${org.orgId}:policy:later-${randomUUID().slice(0, 8)}`,
      properties: {
        scope: { objectRef: component.id },
        enforcement: "advisory",
        effects: [{ dependencySubscription: { enabled: false } }]
      }
    });

    // `updateObject` replaces `properties` wholesale, so an author blocked at create could otherwise
    // land the opt-out above and flip it one PATCH later.
    await expectApiError(
      admin.policies.update(created.id, {
        properties: {
          scope: { objectRef: component.id },
          enforcement: "advisory",
          effects: [{ dependencySubscription: { enabled: true } }]
        }
      }),
      409,
      /\.renovaterc/
    );
  });

  it("the actuator seam refuses too — which is what covers a SELECTOR-scoped enable the guard cannot see", async () => {
    const component = await createTestComponent(admin, {
      name: `dep-act-${randomUUID().slice(0, 8)}`
    });
    await plantDelegation(component.id, ".github/dependabot.yml");

    await expect(
      inOrg((tx) => assertComponentNotDelegated(tx, org.orgId, component.id))
    ).rejects.toMatchObject({ status: 409 });
  });

  // ---------------------------------------------------------------------------------------------
  // 2. AUTO-MERGE IS EVIDENCED BY A GOVERNED CONTROL — no new gate
  // ---------------------------------------------------------------------------------------------

  it("downgrades auto_merge to a pull request when NO governed control has evidenced anything", async () => {
    const { changeObjectId } = await authorBump("acme/widget", "auto_merge");
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo: "acme/widget"
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/absent never means passed/);
  });

  /** A `control` object BOUND to a plugin module, with one run whose evidence names `ref` — the
   *  shape `governance/control-runner.ts` deposits, and the only place the KIND of question a
   *  control asked is recorded. */
  async function plantControlRun(input: {
    changeObjectId: string;
    status: "pass" | "fail" | "expired";
    ref: string;
    /** WHICH REPOSITORY the control looked at — recorded as the API URL `@scp/plugin-github-check`
     *  actually queries, which is the only field in its evidence that says so. */
    repo: string;
    module?: string;
  }): Promise<string> {
    const controlObjectId = randomUUID();
    const pluginModule = input.module ?? "github-check";
    await inOrg(async (tx) => {
      await upsertControlBinding(tx, {
        orgId: org.orgId,
        controlObjectId,
        pluginModule,
        pluginInstanceId: `ctl-${randomUUID()}`
      });
      await insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId,
        changeObjectId: input.changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: { fromState: "validating", toState: "approved" },
        status: input.status,
        // STAMPED ON THE RUN, exactly as `control-runner.ts` does — never left to a join against the
        // CURRENT binding, which a later re-point would rewrite the meaning of.
        pluginModule,
        evidence: {
          url: `https://api.github.com/repos/${input.repo}/commits/${input.ref}/check-runs`,
          ref: input.ref,
          checkRuns: []
        }
      });
    });
    return controlObjectId;
  }

  const OBSERVED_COMMIT = "cafebabe".repeat(5);

  it("grants auto_merge only for the component's OWN checks, on the bump's OWN commit", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId, authoredRef, componentObjectId } = await authorBump(repo, "auto_merge");
    await admin.changeSources.createMapping("github", {
      repoPattern: repo,
      component: componentObjectId
    });
    // The bump's own push coming back is what records the commit its branch is at. Until then there
    // is nothing to bind CI evidence TO — which is why a FIRST dispatch can never auto-merge.
    await deliverGithubPush(repo, authoredRef);
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    const claim = await inOrg((tx) => readAuthoredBumpClaim(tx, org.orgId, changeObjectId));
    expect(claim?.headCommit).toBe(OBSERVED_COMMIT);
    // AND IN SERVER-OWNED STORAGE, which is the copy every merge decision actually reads. The
    // readable claim above is the explanation; this is the authority (ADR-0032 §8f).
    const authorship = await inOrg((tx) => readBumpAuthorship(tx, org.orgId, changeObjectId));
    expect(authorship?.headCommit).toBe(OBSERVED_COMMIT);
    expect(authorship?.repo).toBe(repo);

    const controlObjectId = await plantControlRun({
      changeObjectId,
      status: "pass",
      ref: OBSERVED_COMMIT,
      repo
    });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo: authorship?.repo,
        authoredHeadCommit: authorship?.headCommit
      })
    );
    expect(resolved.delivery).toBe("auto_merge");
    expect(resolved.controlObjectId).toBe(controlObjectId);
  });

  /**
   * ==============================================================================================
   * THE MODULE NAME BINDS THE EVIDENCE TO NOTHING ON ITS OWN
   * ==============================================================================================
   * "The component's OWN checks" was enforced as a MODULE-NAME STRING plus a commit id. A commit id
   * is a content hash and travels between repositories freely — a fork, a mirror, a vendored copy —
   * so a `github-check` control an operator configured against an UNRELATED repository containing
   * the same commit object reported green for exactly the right commit and the merge was granted.
   */
  it("an own-check PASS in a DIFFERENT repository grants nothing", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    // Right module, right status, right commit — wrong repository.
    await plantControlRun({
      changeObjectId,
      status: "pass",
      ref: OBSERVED_COMMIT,
      repo: "someone-else/fork"
    });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo,
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/cannot be attributed to/);
  });

  it("an own-check PASS whose evidence names NO repository at all grants nothing", async () => {
    // A control run from an older build, or a module added to the own-check list later, can carry
    // any evidence shape. One this cannot attribute is not a grant — the fail-closed direction,
    // which costs a pull request rather than an unattended merge on evidence nobody can place.
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    const controlObjectId = randomUUID();
    await inOrg(async (tx) => {
      await upsertControlBinding(tx, {
        orgId: org.orgId,
        controlObjectId,
        pluginModule: "github-check",
        pluginInstanceId: `ctl-${randomUUID()}`
      });
      await insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId,
        changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: {},
        status: "pass",
        pluginModule: "github-check",
        evidence: { ref: OBSERVED_COMMIT }
      });
    });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo,
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
  });

  /**
   * ==============================================================================================
   * A BINDING RE-POINTED LATER MUST NOT RE-NARRATE WHAT AN OLD RUN EVIDENCED
   * ==============================================================================================
   * The module used to be read from the CURRENT `control_bindings` row by LEFT JOIN, and a binding
   * is mutable: re-pointing one control from `webhook-control` to `github-check` retroactively
   * relabelled every historical pass of that control as an own-check pass — and this grant reads
   * historical runs. It is now stamped on the run at insert (migration 0063).
   */
  it("re-pointing a control's binding does NOT retroactively relabel its old runs as own-checks", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    // The run happened while the control asked a DIFFERENT question — an operator-configured webhook.
    const controlObjectId = await plantControlRun({
      changeObjectId,
      status: "pass",
      ref: OBSERVED_COMMIT,
      repo,
      module: "webhook-control"
    });
    // ...and the binding is later re-pointed at the component's CI.
    await inOrg((tx) =>
      upsertControlBinding(tx, {
        orgId: org.orgId,
        controlObjectId,
        pluginModule: "github-check",
        pluginInstanceId: `ctl-${randomUUID()}`
      })
    );
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo,
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/webhook-control/);
  });

  it("a PASS from a control that is NOT the component's own checks grants nothing", async () => {
    // The defect this closes: the runs were read unfiltered, so ANY passing control satisfied "the
    // component's own checks passed" — a scan verdict, a webhook approval pointed at an operator's
    // own URL, a commander promotion-scan row. Each is a governed control; none is CI on this bump.
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    await plantControlRun({
      changeObjectId,
      status: "pass",
      ref: OBSERVED_COMMIT,
      repo,
      module: "scan-result-control"
    });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo,
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(
      /came from a control that evidences the component's OWN checks/
    );
  });

  it("an own-check PASS for a DIFFERENT commit grants nothing — green on main is not green here", async () => {
    // The sharper half. `github-check` falls back to its operator-pinned `expectedRef` when the
    // change tracks no commit, so without the commit binding a control could report CI green for the
    // BASE branch and the bump would merge into it on exactly that evidence.
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    await plantControlRun({ changeObjectId, status: "pass", ref: "deadbeef".repeat(5), repo });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo,
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/other than the bump's own head/);
  });

  it("an own-check PASS grants nothing while the bump's own commit has not been observed back", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId } = await authorBump(repo, "auto_merge");
    await plantControlRun({ changeObjectId, status: "pass", ref: OBSERVED_COMMIT, repo });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, { changeObjectId, requested: "auto_merge", repo })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/has not been observed back yet/);
  });

  it("a single objecting control defeats a passing one — the same asymmetry the merge itself uses", async () => {
    const { changeObjectId } = await authorBump("acme/widget", "auto_merge");
    await inOrg(async (tx) => {
      await insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: randomUUID(),
        changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: {},
        status: "pass",
        evidence: {}
      });
      await insertControlRun(tx, {
        orgId: org.orgId,
        controlObjectId: randomUUID(),
        changeObjectId,
        gateKind: "lifecycle_edge",
        gateRef: {},
        status: "fail",
        evidence: {}
      });
    });
    const resolved = await inOrg((tx) =>
      resolveEffectiveDelivery(tx, org.orgId, {
        changeObjectId,
        requested: "auto_merge",
        repo: "acme/widget",
        authoredHeadCommit: OBSERVED_COMMIT
      })
    );
    expect(resolved.delivery).toBe("pull_request");
    expect(resolved.reason).toMatch(/reported 'fail'/);
  });

  // ---------------------------------------------------------------------------------------------
  // 3. THE PROVENANCE LOOP — replay the webhook the bump's own push produces
  // ---------------------------------------------------------------------------------------------

  /** Record a bump change exactly as the actuator seam does. Returns its id and authored ref. */
  async function authorBump(
    repo: string,
    delivery: "pull_request" | "auto_merge"
  ): Promise<{ changeObjectId: string; authoredRef: string; componentObjectId: string }> {
    const component = await createTestComponent(admin, {
      name: `dep-bump-${randomUUID().slice(0, 8)}`
    });
    // A REAL dependency line: `dependency_bump_authorships` carries a composite `(org_id, line_id)`
    // foreign key into `dependency_lines`, the same cross-org barrier 0061 established for the
    // inventory. A synthetic uuid here would not just fail the constraint — it would mean the
    // fixture was recording an authorship for a subscription that cannot exist.
    const line = await inOrg((tx) =>
      upsertDependencyLine(tx, org.orgId, {
        ecosystem: "npm",
        coordinate: `@acme/lib-${randomUUID().slice(0, 8)}`,
        major: "1"
      })
    );
    const changeObjectId = randomUUID();
    const recorded = await inOrg((tx) =>
      recordBumpChange(tx, {
        orgId: org.orgId,
        changeObjectId,
        requestId: `test-${randomUUID()}`,
        componentObjectId: component.id,
        // The line the bump is for — what `bump-gate.ts` re-resolves the subscription by.
        lineId: line.id,
        repo,
        baseBranch: "main",
        ecosystem: "npm",
        coordinate: "@acme/lib",
        manifestPath: "package.json",
        declaredManifestPaths: ["package.json"],
        fromVersion: "^1.2.3",
        toVersion: "^1.4.0",
        delivery: { delivery, reason: "test" }
      })
    );
    return { ...recorded, componentObjectId: component.id };
  }

  /** Persist a raw GitHub `push` delivery, exactly as `routes/change-sources.ts`'s webhook route
   *  does (that route is a plain INSERT — persist-then-PROCESS, DESIGN §8). */
  async function deliverGithubPush(repo: string, ref: string): Promise<string> {
    const id = uuidv7();
    await inOrg((tx) =>
      tx.insert(changeSourceEvents).values({
        id,
        orgId: org.orgId,
        sourceKind: "github",
        signatureVerified: true,
        dedupeKey: `delivery-${id}`,
        headers: { "x-github-event": "push" },
        payload: {
          ref,
          after: "cafebabe".repeat(5),
          repository: { full_name: repo },
          head_commit: { id: "cafebabe".repeat(5), modified: ["package.json"] },
          commits: [{ id: "cafebabe".repeat(5), modified: ["package.json"] }]
        }
      })
    );
    return id;
  }

  async function liveChangeCount(): Promise<number> {
    const rows = await inOrg((tx) =>
      tx.select({ id: changes.objectId }).from(changes).where(eq(changes.orgId, org.orgId))
    );
    return rows.length;
  }

  it("the push SCP's own bump produces attaches to the ORIGINATING change and mints no second one", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId, authoredRef, componentObjectId } = await authorBump(
      repo,
      "pull_request"
    );
    // The component has an ORDINARY source mapping on that repo — which is exactly what would have
    // minted the duplicate. Without it this test would pass for the wrong reason.
    await admin.changeSources.createMapping("github", {
      repoPattern: repo,
      component: componentObjectId
    });

    const before = await liveChangeCount();
    const eventId = await deliverGithubPush(repo, authoredRef);
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));

    const [row] = await inOrg((tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(row?.processedAt).not.toBeNull();
    expect(row?.resultingChangeObjectId).toBe(changeObjectId);
    // THE ASSERTION THAT MATTERS: nothing new was proposed.
    expect(await liveChangeCount()).toBe(before);
  });

  it("an ORDINARY push to the same repo still mints a change — this narrows ingress for nothing else", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const component = await createTestComponent(admin, {
      name: `dep-ord-${randomUUID().slice(0, 8)}`
    });
    await admin.changeSources.createMapping("github", {
      repoPattern: repo,
      component: component.id
    });

    const before = await liveChangeCount();
    const eventId = await deliverGithubPush(repo, "refs/heads/main");
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));

    const [row] = await inOrg((tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    expect(row?.resultingChangeObjectId).not.toBeNull();
    expect(await liveChangeCount()).toBe(before + 1);
  });

  it("REFUSES to attach a bump-shaped ref pushed from a repository the change never claimed", async () => {
    // The forgery case. A branch name is attacker-typable; the change's own `scp_authored.repo`
    // declaration is what makes the correlation a fact SCP asserted rather than one the payload made.
    const authoredRepo = `acme/${randomUUID().slice(0, 8)}`;
    const otherRepo = `acme/${randomUUID().slice(0, 8)}`;
    const { authoredRef } = await authorBump(authoredRepo, "pull_request");
    const other = await createTestComponent(admin, {
      name: `dep-forge-${randomUUID().slice(0, 8)}`
    });
    await admin.changeSources.createMapping("github", {
      repoPattern: otherRepo,
      component: other.id
    });

    const before = await liveChangeCount();
    const eventId = await deliverGithubPush(otherRepo, authoredRef);
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));

    const [row] = await inOrg((tx) =>
      tx.select().from(changeSourceEvents).where(eq(changeSourceEvents.id, eventId))
    );
    // It fell through to ORDINARY ingress — a new change for the OTHER component — rather than
    // attaching to a change that never claimed this repository.
    expect(await liveChangeCount()).toBe(before + 1);
    expect(row?.resultingChangeObjectId).not.toBeNull();
    const [minted] = await inOrg((tx) =>
      tx
        .select()
        .from(changes)
        .where(eq(changes.objectId, row!.resultingChangeObjectId as string))
    );
    expect(minted?.sourceKind).toBe("github");
  });

  it("REFUSES to attach a bump-shaped ref naming a change that does not exist", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const component = await createTestComponent(admin, {
      name: `dep-ghost-${randomUUID().slice(0, 8)}`
    });
    await admin.changeSources.createMapping("github", {
      repoPattern: repo,
      component: component.id
    });

    const before = await liveChangeCount();
    await deliverGithubPush(repo, `refs/heads/scp/dep-bump/${randomUUID()}`);
    await inOrg((tx) => processChangeSourceEvents(tx, org.orgId));
    expect(await liveChangeCount()).toBe(before + 1);
  });

  it("records the bump change with the declaration correlation reads, and the delivery's reason", async () => {
    const repo = `acme/${randomUUID().slice(0, 8)}`;
    const { changeObjectId, authoredRef } = await authorBump(repo, "pull_request");
    const [row] = await inOrg((tx) =>
      tx.select().from(changes).where(eq(changes.objectId, changeObjectId))
    );
    const authored = (row!.sourceRef as { scp_authored: Record<string, unknown> }).scp_authored;
    expect(authored.repo).toBe(repo);
    expect(authored.ref).toBe(authoredRef);
    expect(authored.coordinate).toBe("@acme/lib");
    expect(authored.deliveryReason).toBe("test");
    expect(row!.sourceKind).toBe("dependency-bump");
  });
});
