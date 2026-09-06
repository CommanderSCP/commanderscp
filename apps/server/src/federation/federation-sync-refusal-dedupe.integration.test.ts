import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
// The chain verifier lives on the node-only subpath (see audit-chain.ts's module doc) — the same
// import `audit/audit-repo.ts` uses.
import { verifyAuditChain } from "@scp/schemas/audit-chain";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { auditEvents, decisions } from "../db/schema.js";
import { pairPeer } from "./peers-repo.js";
import { ensureFederationSelf } from "./self-repo.js";
import { FEDERATION_SYNC_DECISION_KIND, pullFromCommanderPeer } from "./federation-sync.js";
import { listAuditEvents } from "../audit/audit-repo.js";

/**
 * U4 of the unbounded-Decision-write class (see
 * `coordination/decision-write-amplification.integration.test.ts` for the production measurement,
 * `coordination/decisions-repo.ts`'s `insertDecisionIfChanged` for the shape).
 *
 * `recordSyncBlock` fires for a STANDING condition — an mTLS-required peer with no usable
 * client-cert material, or a dialer that refuses that peer — and NOTHING marks the peer
 * already-refused. The sweep re-attempts it on the default 60 s cadence, so one misconfigured peer
 * appended 1,440 identical Decisions AND 1,440 identical hash-chained audit events per day,
 * indefinitely. (This deployment carries 0 of these rows only because its federation sync loop is
 * off — `SCP_FEDERATION_SYNC_LOOP` unset.)
 *
 * The refusal asserted here is the FAIL-CLOSED pre-flight one, which happens before any network I/O
 * — so this needs no HTTPS listener and no PKI, unlike `federation-sync.integration.test.ts`'s
 * two-domain suite that proves the refusal's semantics. This file only pins its WRITE volume.
 */
describe("federation sync refusals persist ON CHANGE (U4)", () => {
  let server: TestServer;
  let org: TestOrg;
  let selfDomainId: string;
  const peerDomainId = asTrustDomainId(randomUUID());

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "fedsync-refusal-dedupe");
    selfDomainId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const self = await ensureFederationSelf(tx, org.orgId);
      return self.domainId;
    });
  });

  afterAll(async () => {
    await server.close();
  });

  /** Re-pairs (or pairs) the commander peer under a given NAME — the name rides the refusal reason,
   *  so changing it is a genuinely different statement about the peer. */
  async function pairCommander(name: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      pairPeer(tx, {
        orgId: org.orgId,
        domainId: peerDomainId,
        name,
        role: "commander",
        publicKey: "test-ed25519-public-key",
        // https => `federationPeerRequiresMtls` — with no client cert this is REFUSED fail-closed
        // before any dial is attempted, so no listener is needed.
        baseUrl: "https://commander.invalid"
      })
    );
  }

  function syncDecisions() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, peerDomainId),
            eq(decisions.kind, FEDERATION_SYNC_DECISION_KIND)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );
  }

  /** The whole org's chain, re-walked exactly as `scp audit verify` does. */
  async function auditChainIsIntact(): Promise<boolean> {
    const page = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listAuditEvents(tx, org.orgId, { limit: 500 })
    );
    return verifyAuditChain(page.items).valid;
  }

  function refusalAuditEvents() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.action, "federation.sync.refused"))
        )
        .orderBy(auditEvents.seq)
    );
  }

  it("10 pull attempts at an unchanged, permanently-refused peer: ONE block Decision, ONE audit event, and every attempt still carries that decision_id", async () => {
    const peer = await pairCommander("commander-alpha");

    const decisionIds: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const outcome = await pullFromCommanderPeer(server.deps.db, org.orgId, selfDomainId, peer, {
        mtls: undefined // NO client cert — the fail-closed refusal, identical on every attempt
      });
      expect(outcome.outcome).toBe("refused");
      // Charter principle 6: a suppressed restatement still hands back a resolvable decision_id.
      expect(outcome.decisionId).toBeTruthy();
      decisionIds.push(outcome.decisionId!);
    }

    expect(new Set(decisionIds).size).toBe(1);
    // ...because only one was ever written (before the fix: 10, and 1,440/day/peer in a live loop).
    const rows = await syncDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("block");
    expect(rows[0]!.id).toBe(decisionIds[0]);

    // The paired hash-chained audit event is suppressed on the SAME condition — never independently.
    // An event per no-op tick would make `scp audit verify` assert occurrences that did not occur,
    // and the chain cannot be repaired afterwards by deleting rows.
    const events = await refusalAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.decisionId).toBe(rows[0]!.id);

    // ...and the chain is intact (the suppression skips an append; it never rewrites one).
    expect(await auditChainIsIntact()).toBe(true);
  });

  it("a CHANGED refusal reason writes a second Decision + audit event (content-keyed, not subject-keyed)", async () => {
    const renamed = await pairCommander("commander-alpha-renamed");

    const outcome = await pullFromCommanderPeer(server.deps.db, org.orgId, selfDomainId, renamed, {
      mtls: undefined
    });
    expect(outcome.outcome).toBe("refused");

    const rows = await syncDecisions();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.id).toBe(outcome.decisionId);
    expect(JSON.stringify(rows[1]!.reasonTree)).toContain("commander-alpha-renamed");

    const events = await refusalAuditEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.decisionId).toBe(rows[1]!.id);

    expect(await auditChainIsIntact()).toBe(true);
  });
});
