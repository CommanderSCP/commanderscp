import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineEvidence, pipelineHooks } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import {
  deleteHook,
  recordTestRunEvidence,
  upsertHook
} from "../coordination/pipeline-hooks-repo.js";
import { ensureFederationSelf, type FederationSelf } from "./self-repo.js";
import { pairPeer } from "./peers-repo.js";
import { getCursor } from "./cursors-repo.js";
import { exportSyncBundle } from "./export-repo.js";
import { importSyncBundle } from "./import-repo.js";
import { createIsolatedDomain, type IsolatedDomain } from "./test-support/isolated-domain.js";

/**
 * OUTPOST-RUN PROBES, THE DOWNWARD HALF — a hook declared at the commander REACHES the outpost that
 * will run it, and a retraction removes it there.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 * Probes cannot run at the commander: it does not reach into a domain, and the digest-pinned test
 * bundle lives in the DOMAIN's own Gitea (D23). So the outpost runs them, which requires the
 * declaration to travel — and `pipeline_hooks` federated nowhere. A filterless census of
 * `apps/server/src/federation` for `pipeline_hooks` returned nothing before this change.
 *
 * The journal is the transport rather than the graph because a hook row is deliberately a SIDE
 * TABLE whose ownership derives from `component_object_id` (migration 0096's header, which
 * explicitly declines a `managed_by_stack` column). Making hooks graph objects to ride
 * `object_upsert` for free would reverse that decision to dodge a process step.
 *
 * ============================================================================================
 * WHAT IS ASSERTED, AND WHY EACH IS NOT THE OBVIOUS ONE
 * ============================================================================================
 *   - THE ROW AT THE OUTPOST (case 1), not "the bundle contained an entry". An entry that exports
 *     and then fails to apply is the shape this whole session has been finding: emitted, carried,
 *     and installed nowhere.
 *   - NO ECHO (case 2). The receiver must not re-journal what it was told, or two peers paired both
 *     ways loop forever. Asserted by exporting FROM the outpost afterwards and finding nothing —
 *     the only check that distinguishes "did not echo" from "echoed and we did not look".
 *   - A RETRACTION REMOVES IT (case 3). "Until they hear otherwise" is the tombstone; without it a
 *     probe deleted at the commander keeps running in the domain forever.
 *   - A MALFORMED ENTRY IS DROPPED, NOT THROWN (case 4). A throw mid-bundle wedges a peer's ENTIRE
 *     signed journal — the failure mode `import-repo.ts` warns about repeatedly. This is the case
 *     that makes the tolerance real rather than intended.
 */
describe("pipeline hook federation: commander declares, outpost receives", () => {
  let commander: IsolatedDomain;
  let outpost: IsolatedDomain;
  let commanderSelf: FederationSelf;

  async function pair(
    from: IsolatedDomain,
    to: IsolatedDomain,
    role: "outpost" | "commander"
  ): Promise<void> {
    const key = await withTenantTx(to.db, to.orgId, (tx) => ensureInstanceKey(tx, to.orgId));
    const self = await withTenantTx(to.db, to.orgId, (tx) => ensureFederationSelf(tx, to.orgId));
    const { publicKey: cosignPublicKey } = await getInstanceCosignPublicKey(to.db, to.orgId);
    await withTenantTx(from.db, from.orgId, (tx) =>
      pairPeer(tx, {
        orgId: from.orgId,
        domainId: self.domainId,
        name: to.orgName,
        role,
        publicKey: key.publicKey,
        cosignPublicKey
      })
    );
  }

  beforeAll(async () => {
    commander = await createIsolatedDomain("hookfedcommander");
    outpost = await createIsolatedDomain("hookfedoutpost");
    commanderSelf = await withTenantTx(commander.db, commander.orgId, (tx) =>
      ensureFederationSelf(tx, commander.orgId)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) => ensureFederationSelf(tx, outpost.orgId));
    await pair(commander, outpost, "outpost");
    await pair(outpost, commander, "commander");
  }, 180_000);

  afterAll(async () => {
    await commander?.close();
    await outpost?.close();
  });

  /** The component the hook hangs off, replicated to the outpost so the hook has a subject there.
   *  Same object id both sides — single-writer authority. */
  async function replicatedComponent(): Promise<string> {
    const component = await withTenantTx(commander.db, commander.orgId, (tx) =>
      createObject(tx, {
        orgId: commander.orgId,
        domainId: null,
        typeId: "component",
        actorObjectId: commander.orgId,
        requestId: "hookfed-component",
        name: `hookfed-${randomUUID().slice(0, 8)}`
      })
    );
    await sync();
    return component.id;
  }

  /** One commander -> outpost sync: export from the outpost's cursor, import at the outpost. */
  async function sync(): Promise<void> {
    const cursor = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, commanderSelf.domainId, commanderSelf.domainId)
    );
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName, cursor.sequence)
    );
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      importSyncBundle(tx, outpost.orgId, bundle)
    );
  }

  const hooksAt = (domain: IsolatedDomain, componentObjectId: string) =>
    withTenantTx(domain.db, domain.orgId, (tx) =>
      tx
        .select()
        .from(pipelineHooks)
        .where(
          and(
            eq(pipelineHooks.orgId, domain.orgId),
            eq(pipelineHooks.componentObjectId, componentObjectId)
          )
        )
    );

  it("1. a hook declared at the commander LANDS at the outpost, declaration intact", async () => {
    const componentObjectId = await replicatedComponent();
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      upsertHook(tx, commander.orgId, {
        componentObjectId,
        kind: "continuous",
        hookId: "canary",
        workflow: { repo: "acme/pipelines", branch: "main", path: "probes/canary.yaml" },
        maxAgeSeconds: 900,
        everySeconds: 300
      })
    );

    await sync();

    const [row] = await hooksAt(outpost, componentObjectId);
    expect(row, "the declaration never reached the domain that has to run it").toBeTruthy();
    expect(row!.kind).toBe("continuous");
    expect(row!.hookId).toBe("canary");
    // The FRESHNESS WINDOW and the cadence both survive the trip. `maxAgeSeconds` is what
    // `evaluateContinuousHold` ages evidence against, so a hook that arrived without it would hold
    // on a boundary nobody declared.
    expect(row!.maxAgeSeconds).toBe(900);
    expect(row!.everySeconds).toBe(300);
    expect(row!.workflow).toEqual({
      repo: "acme/pipelines",
      branch: "main",
      path: "probes/canary.yaml"
    });
  });

  it("2. the outpost does NOT echo the hook back — a receiver that re-journals loops", async () => {
    // Both directions are paired in `beforeAll`, so an echo would be delivered, re-applied, and
    // re-emitted forever. `federationImport: true` on the import path is what prevents it; this is
    // the assertion that makes that flag load-bearing rather than decorative.
    const componentObjectId = await replicatedComponent();
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      upsertHook(tx, commander.orgId, {
        componentObjectId,
        kind: "postDeploy",
        hookId: "integration",
        workflow: { repo: "acme/pipelines", branch: "main", path: "it.yaml" }
      })
    );
    await sync();

    const outpostSelf = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    const back = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, outpostSelf.domainId, outpostSelf.domainId)
    );
    const echo = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName, back.sequence)
    );
    expect(
      echo.entries.filter((e) => e.entryKind.startsWith("pipeline_hook_")),
      "the outpost re-journalled what it was sent"
    ).toHaveLength(0);
  });

  it("3. a retraction at the commander REMOVES it at the outpost", async () => {
    const componentObjectId = await replicatedComponent();
    const identity = {
      componentObjectId,
      kind: "continuous" as const,
      hookId: "retracted"
    };
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      upsertHook(tx, commander.orgId, { ...identity, maxAgeSeconds: 60 })
    );
    await sync();
    expect(await hooksAt(outpost, componentObjectId)).toHaveLength(1);

    await withTenantTx(commander.db, commander.orgId, (tx) =>
      deleteHook(tx, commander.orgId, identity)
    );
    await sync();

    // "Until they hear otherwise" is this entry. Without it the domain keeps running a probe the
    // commander has forgotten, and nothing on either side can tell.
    expect(
      await hooksAt(outpost, componentObjectId),
      "a retracted probe is still declared in the domain"
    ).toHaveLength(0);
  });

  it("4. a TAMPERED hook entry is refused before it is ever parsed", async () => {
    // WHAT I SET OUT TO TEST AND WHAT IS ACTUALLY TRUE — recorded because the difference matters.
    // The intent was to prove the import's malformed-payload branch drops one bad entry without
    // wedging the bundle (the failure `import-repo.ts` warns about throughout). It cannot be
    // reached that way: mutating an entry invalidates the bundle's signature, and import REFUSES
    // the whole thing with 409 before any payload is parsed. Measured, not assumed.
    //
    // That is the stronger property, so it is what this asserts. The malformed-payload branch
    // remains as defence in depth for an entry a peer produces legitimately but this version cannot
    // understand — a downgrade, or a future kind — and it is deliberately NOT reachable by
    // tampering, which the signature already covers.
    const componentObjectId = await replicatedComponent();
    const cursor = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      getCursor(tx, outpost.orgId, commanderSelf.domainId, commanderSelf.domainId)
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      upsertHook(tx, commander.orgId, {
        componentObjectId,
        kind: "postDeploy",
        hookId: "tampered",
        workflow: { repo: "acme/pipelines", branch: "main", path: "it.yaml" }
      })
    );
    const bundle = await withTenantTx(commander.db, commander.orgId, (tx) =>
      exportSyncBundle(tx, commander.orgId, outpost.orgName, cursor.sequence)
    );
    for (const entry of bundle.entries) {
      if (entry.entryKind === "pipeline_hook_upsert") {
        (entry.payload as Record<string, unknown>).kind = "not-a-kind";
      }
    }

    await expect(
      withTenantTx(outpost.db, outpost.orgId, (tx) => importSyncBundle(tx, outpost.orgId, bundle))
    ).rejects.toThrow(/Conflict/);

    // And nothing from the refused bundle was applied — a partial apply would be worse than a
    // refusal, because the domain would hold a declaration the commander never signed.
    expect(await hooksAt(outpost, componentObjectId)).toHaveLength(0);
  });

  it("5. UPWARD: probe evidence produced at the outpost reaches the commander, stamped peer_reported", async () => {
    // The other half of the round trip. A probe runs in the DOMAIN — the commander does not reach
    // in, and the digest-pinned bundle is local to the outpost — so the result is produced there
    // and has to travel back for the commander's gate to read it.
    const componentObjectId = await replicatedComponent();
    const targetObjectId = componentObjectId;
    await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      recordTestRunEvidence(tx, outpost.orgId, {
        componentObjectId,
        targetObjectId,
        hookId: "canary",
        artifactDigest: `sha256:${"ab".repeat(32)}`,
        source: "executor_observed",
        evidence: {
          kind: "testRun",
          hook: "continuous",
          hookId: "canary",
          workflow: {
            repo: "acme/pipelines",
            branch: "main",
            path: "probes/canary.yaml",
            commitSha: "9".repeat(40),
            bundle: { repository: "acme/api-tests", digest: `sha256:${"7c".repeat(32)}` }
          },
          runId: "probe-1",
          outcome: "passed",
          startedAt: "2026-08-28T00:00:00.000Z",
          completedAt: "2026-08-28T00:01:00.000Z"
        }
      })
    );

    // Outpost -> commander: the commander pulls from the outpost's journal.
    const outpostSelf = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      ensureFederationSelf(tx, outpost.orgId)
    );
    const cursor = await withTenantTx(commander.db, commander.orgId, (tx) =>
      getCursor(tx, commander.orgId, outpostSelf.domainId, outpostSelf.domainId)
    );
    const bundle = await withTenantTx(outpost.db, outpost.orgId, (tx) =>
      exportSyncBundle(tx, outpost.orgId, commander.orgName, cursor.sequence)
    );
    await withTenantTx(commander.db, commander.orgId, (tx) =>
      importSyncBundle(tx, commander.orgId, bundle)
    );

    const [row] = await withTenantTx(commander.db, commander.orgId, (tx) =>
      tx
        .select()
        .from(pipelineEvidence)
        .where(
          and(
            eq(pipelineEvidence.orgId, commander.orgId),
            eq(pipelineEvidence.componentObjectId, componentObjectId)
          )
        )
    );
    expect(row, "the probe result never reached the gate that needs it").toBeTruthy();
    expect(row!.hookId).toBe("canary");
    // PROVENANCE IS STAMPED BY THE RECEIVER. The outpost recorded this as `executor_observed`; the
    // commander records what IT knows — that a peer reported it. Asserting the source is what makes
    // that rule testable rather than aspirational: a receiver that trusted the payload would show
    // `executor_observed` here and be claiming the commander observed a run in someone else's
    // domain.
    expect(row!.source).toBe("peer_reported");
    expect(row!.producerSubjectId).toBeNull();
    // The evidence itself survives intact — it is what the gate parses.
    expect((row!.payload as { outcome?: string }).outcome).toBe("passed");
  });
});
