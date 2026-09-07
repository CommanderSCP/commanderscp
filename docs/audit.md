# audit

Long-form reference for the **audit** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 7 of 7 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/audit/audit-chain.integration.test.ts`](#apps-server-src-audit-audit-chain-integration-test-ts) — §1–§3
- [`apps/server/src/audit/audit-repo.ts`](#apps-server-src-audit-audit-repo-ts) — §4–§7

## `apps/server/src/audit/audit-chain.integration.test.ts`

### §1. BUILD_AND_TEST.md §8 M1 DoD (d)

BUILD_AND_TEST.md §8 M1 DoD (d): "audit chain verifies (via the `scp audit verify` path) after 10,000 mixed writes". Writes go straight through the repo layer (graph/objects-repo.ts, graph/relationships-repo.ts) — each call is its own `withTenantTx` transaction, exactly like a real API request, just without 10,000 real HTTP round trips — so this is still exercising the production write path (and its per-org advisory-lock chain serialization) end to end. Verification itself goes through the real `scp` CLI binary against the real API, per the DoD wording ("via the scp audit verify path").

### §2. WRITERS IN FLIGHT AT ONCE

WRITERS IN FLIGHT AT ONCE. Each write is still its own `withTenantTx` transaction through the production repo layer — what changes is only that the TEST stops idling on a round trip between every one of them, and that is why this is a flakiness fix rather than a speed-up.

10,000 strictly sequential writes make this test's runtime a measure of per-round-trip LATENCY: ~8 round trips each (BEGIN, `SET LOCAL ROLE`, `set_config`, the chain's `pg_advisory_xact_lock`, the tail SELECT, the row INSERT, the audit INSERT, COMMIT), all of them blocking, none of them overlapping. Latency is exactly what degrades when the suite runs 4 forks wide on a busy box, so a fixed wall-clock budget over that shape is a throughput assertion nobody meant to write — measured on 2026-08-17 as 125s passing and 181s timing out against a 180s budget, on unmodified main, with no code change in between.

With writers in flight the serialized floor is the part `appendAuditEvent` holds the per-org advisory lock for (lock -> tail read -> audit insert -> COMMIT) and everything else overlaps, so the run is bounded by work the SERVER does rather than by how promptly this process is scheduled to issue its next statement. 8 sits under `pg.Pool`'s default max of 10.

IT ALSO STRENGTHENS THE TEST, which is the reason to prefer it over simply enlarging the budget: `appendAuditEvent`'s advisory lock exists precisely so that CONCURRENT writers cannot observe a stale tail and fork the chain, and until now every one of these 10,000 appends was sequential — the serialization was never actually put under contention by the test that verifies the chain.

### §3. Directly corrupt a row as the admin/superuser connection

Directly corrupt a row as the admin/superuser connection — the append-only guard trigger (drizzle/0002_rls_rbac_seed.sql) blocks UPDATE unconditionally, so the trigger has to be disabled first; this simulates an attacker with raw filesystem/superuser access to the database, which is exactly the threat model the hash chain (not the trigger alone) defends against.

## `apps/server/src/audit/audit-repo.ts`

### §4. Domain-local subject: withhold this entry from peers

M20.2 (ADR-0031 §2) — true when the SUBJECT of this audited action is a domain-local object, so the `audit_segment` journal entry below is withheld from every peer.

SUPPLIED BY THE CALLER, never looked up here. The callers that mutate an object already hold its row, and making the audit path issue a query per event would put a read in the hot path of every audited action in the system to serve a small minority of them.

THIS IS NOT OPTIONAL POLISH. The audit segment carries `subjectId` — the object's id — so without it a domain-local object's *identity* crosses on every single mutation even though its `object_upsert` is withheld. `domain-local-invisibility.integration.test.ts` found exactly that: the graph entries were correctly filtered and the id sailed out in the audit stream beside them.

The LOCAL audit row is written unchanged either way — this withholds the entry from the journal, never from this domain's own hash-chained audit log, which stays complete and verifiable (charter principle 6). Locality is about what leaves, not about what is recorded.

### §5. Appends one link to the org's hash chain, in the caller's tx

Appends one link to the org's hash chain, in the caller's transaction — DESIGN.md §4.3: "written in the same transaction as the audited action". `pg_advisory_xact_lock` serializes chain appends per org (held until COMMIT/ROLLBACK), so concurrent writers can never observe a stale tail and fork the chain, and `seq` (see schema.ts) makes "the tail" unambiguous even when two events share a millisecond timestamp.

### §6. Audit segments ride the federation journal to the peer side

M6 (DESIGN §13: "audit segments ride the federation journal, so cross-domain actions are audit-complete on both sides of a trust boundary"). Piggybacked on the ONE call site every audited action already funnels through, so every audit event — object/relationship/change/ policy/approval/freeze/rollback mutations alike — automatically gets an `audit_segment` journal entry with zero additional call-site wiring anywhere else in the codebase. M20.2 (ADR-0031 §2 as corrected) — a domain-local subject's audit event is allocated NO journal sequence. The local `auditEvents` row above is written unconditionally and its hash chain stays complete and verifiable (charter principle 6): locality governs what LEAVES this domain, never what this domain records about itself.

This one is easy to miss and was: the graph entries were correctly withheld while the object's id sailed out in the audit stream beside them, because `subjectId` IS the object id. `domain-local-invisibility.integration.test.ts` found it by searching the serialized bundle for the id rather than by checking which rows landed — which is why that assertion is written that way.

### §7. Cursor pagination in chain order (`seq`)

Cursor pagination in chain order (`seq`) — the order `scp audit verify` needs to re-walk the chain (DESIGN.md §4.3). The cursor opaquely encodes `seq` (not `created_at`/`id` like every other list endpoint) since that's the one column guaranteed to be a total, gapless order here.
