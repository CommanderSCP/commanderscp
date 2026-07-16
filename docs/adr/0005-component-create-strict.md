# ADR-0005: Component create-in-service is strict (`POST /components` requires `service`)

| | |
|---|---|
| **Status** | **Accepted** — owner decision via the M12 P5 proposal, 2026-07-16 |
| **Date** | 2026-07-16 |
| **Deciders** | Owner (jag8765) |
| **Relates to** | [docs/proposals/organize-after.md](../proposals/organize-after.md) (M12 P5), [BUILD_AND_TEST.md §6](../BUILD_AND_TEST.md) (API additive-only within `/v1`, `tools/openapi/check.sh`), `apps/server/src/routes/components.ts`, `apps/server/src/graph/components-repo.ts`, `packages/schemas/src/graph.ts` (`CreateComponentRequestSchema`), migrations `0021`/`0022` (the `contains` edge + one-service-per-component index) |

## Context

The service/component model (migration 0021, owner decision 2026-07-15) established that **every component belongs to at most one service**, expressed as a `service --contains--> component` edge whose `one_to_many` cardinality plus migration 0022's partial unique index deliver "one service per component." Until M12 P5a that invariant was *representable* but not *enforced at creation*: a component could be minted through the generic `POST /objects/component` route (or the typed-registry `POST /components`, or an IaC manifest) with no owning service — an RBAC orphan reachable only at the org root, never from any service-scoped binding.

The M12 P5 proposal ("create-strict + organize-after", #52) closes this by the principle **create is strict, import is permissive**: a component created *directly* by a user must name its service, while a component *imported* (discovery/accept, federation journal replay, overlay) may arrive as an orphan and be organized later (P5b's `move` verb). The owner approved create-strict, and — in the P5 decisions — ruled that the IaC path is a create surface (strict too) and that every phase lands full API→SDK→CLI→IaC→UI parity.

Making the direct create surface strict means `POST /components` now **requires** a `service` field (`CreateComponentRequestSchema = CreateObjectRequestSchema.extend({ service })`). Adding a required request property is, by definition, a breaking change to the `/v1` contract — `tools/openapi/check.sh` (CI job 3b, `oasdiff breaking --fail-on ERR`) flags exactly one error:

```
[new-required-request-property] at POST /components — added the new required request property `service`
```

That is the *only* break oasdiff reports; the bespoke `/components` operations reuse the prior operationIds (`createComponent`, `listComponents`, …) precisely so nothing else registers as removed or renamed.

## Decision

**Accept the break.** `POST /components` (and the create branch of `PUT /components/{urn}`) require `service`. The generic `/objects/component` route refuses all write verbs (403); the strict route is the only direct way to create a component. Import surfaces stay permissive by design.

This is a deliberate, owner-approved `/v1` breaking change, handled exactly as ADR-0004's federation rename was:

- **`api-v2-exception` label + conscious reviewer sign-off** on the PR — a human/branch-protection override of `tools/openapi/check.sh`'s exit code, *not* a code or CI-config change, and *not* something the check grants itself. This ADR is the record that the break is deliberate, not an oversight to route around.
- `tools/openapi/check.sh` (CI job 3b) is **expected to fail** on the implementing PR (#53) and is flagged loudly in that PR's body.

### Why not make it non-breaking

A required-but-hidden field (schema-optional, handler-enforced) was rejected: the handler still 400s without a service, so every client breaks at runtime regardless — an optional schema would merely *lie* about the contract instead of documenting it. An honest required field the SDK/CLI/UI carry is strictly better than a silent runtime failure.

### Blast radius

Pre-1.0, homelab is the only deployment, and every first-party consumer (UI, CLI, IaC) regenerates from the SDK — so there is no external, un-regenerated client to strand. The break is low-risk and confined to the one operation.

## Consequences

- **Positive:** the "every component belongs to a service" invariant is now enforced at the moment of creation across every direct-create surface, so a component can never silently escape service-scoped RBAC. Import stays frictionless (organize-after).
- **Negative:** the one-time `/v1` break, mitigated by the exception process above; and a small ongoing asymmetry (component is the only typed registry with a bespoke, non-template create route) documented in `routes/components.ts`.
- **Follow-ups (proposal's later phases):** P5b (assign/move + `source_mappings` for imports), P5c (executor-binding purpose primitives + the `listExecutorBindings` `deleted_at` fix), P5d (driving-case merge), P5e (split, deferred).
