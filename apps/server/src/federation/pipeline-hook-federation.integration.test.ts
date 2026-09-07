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

/** OUTPOST-RUN PROBES, THE DOWNWARD HALF. See docs/federation.md §369. */
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
    // WHAT I SET OUT TO TEST AND WHAT IS ACTUALLY TRUE. See docs/federation.md §370.
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
    // PROVENANCE IS STAMPED BY THE RECEIVER. See docs/federation.md §371.
    expect(row!.source).toBe("peer_reported");
    expect(row!.producerSubjectId).toBeNull();
    // The evidence itself survives intact — it is what the gate parses.
    expect((row!.payload as { outcome?: string }).outcome).toBe("passed");
  });
});
