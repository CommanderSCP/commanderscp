# Un-declaring a region is an authority act — the M15.6 instance of a writable match key

**Status:** v0.1 Draft — **proposed, pending review.** The code in the accompanying PR implements §4; §6 states what it deliberately does not do. An ADR follows owner approval, or this folds into the ADR that follows [governance-label-namespace.md](governance-label-namespace.md) if that one lands first.
**Relates to:** [ADR-0017 §3](../adr/0017-ownership-refinement.md) (a region is a deploy-target, shipped as M15.6), [ADR-0006](../adr/0006-fail-closed-on-missing-executor-binding-for-purpose.md) (fail-closed on a missing binding; §(a) and the amendment note that this gate must not quietly become case (a)), [ADR-0003](../adr/0003-internal-egress-for-execution-systems.md) (the declaration-grants-nothing shape this copies), [ADR-0032 §6a](../adr/0032-dependency-subscriptions.md) (the objects-repo choke-point precedent this installs beside), [governance-label-namespace.md](governance-label-namespace.md) §8.4 (the census entry this closes), [ADR-0026](../adr/0026-placements-and-derived-stage-names.md) (placements; the gate's membership hop).

---

## 1. The defect

`coordination/regional-executors.ts`'s `readDeclaredRegionMembership` decides whether the M15.6
no-silent-deploy gate **applies** to a wave target by reading two free-form properties off the
deployment-target itself — `properties.environment` and `properties.region`. Either one blank or
absent returns `null`. `evaluateRegionalDeployGate` documents that `null` as its "SCOPE GUARD", and
`reconcile.ts` reads it as "not a region target": the wave target falls through to case (a) —
*nothing bound anywhere, this is an intended rehearsal* — and is dispatched against the **shared
default fake executor**, reporting success without deploying anything.

Two permissions meet at that read, and they were not the same size:

| Act | Permission required, before this change |
|---|---|
| **Read** the multi-region set the gate governs | `object:read` **at the ORG ROOT**. `routes/executors.ts`'s `getRegionalExecutors` takes the widest bar deliberately: "The view spans every region deployment-target in the environment, so authorize at the org root" |
| **Remove** a target from that set | `object:write` **at the target** — the target's own owner. No schema on either property, no reserved prefix, no validation of any kind |

So **the subject of the gate could leave its reach by deleting one property.** The exploit needs no
"remove property" verb: `updateObject` replaces `properties` wholesale, so an ordinary
full-replacement `PUT` that simply *omits* the key is the whole attack.

Named as tracked-and-unfixed in [governance-label-namespace.md](governance-label-namespace.md) §8.4
("REPORTED, and it is the sharpest of the four … evasion by *deletion*, and the fail-open is the
function's documented 'SCOPE GUARD'"). This is that item.

## 2. Measured, not suspected

Reproduced on a Testcontainers instance through the generated SDK, against a live multi-region
environment (a bound APAC sibling) and a **declared, unbound** region target that the gate refuses as
a control. Every write below is performed by a user holding the built-in **Operator** role bound
**at the target object only** — `object:write` on the target it owns, and no binding at the org root.

| Step | Wave target outcome | Block Decisions |
|---|---|---|
| **control** — declared `{environment, region}`, unbound | `no_executor`, change **parked** | **1** (`gate: regional_argocd_silent_deploy`) |
| **V1** — `PATCH /objects/deployment-target/:id` with `properties: {environment}` | **`triggered` on `fake-executor`** | **0** |
| **V2** — same door with `properties: {}` | **`triggered` on `fake-executor`** | **0** |
| **V3** — `DELETE /objects/deployment-target/:id` after the change is proposed | **`triggered` on `fake-executor`** | **0** |

No error, no audit event, no Decision. A constraint that fails to match is a constraint that does not
apply, and this one failed to match silently — the exact silent regional deploy the gate was built to
prevent, reintroduced by editing the gate's *input* rather than the gate. It is the same shape
ADR-0006's own amendment note flagged when a wave target became a placement: "case (c) would quietly
become case (a), which is the masking failure this gate was built to prevent, reintroduced by a
change of target type rather than by a change to the gate."

V3 is worth its own line: `readDeclaredRegionMembership` filters `deleted_at IS NULL`, so soft-deleting
the row withdraws the target just as surely as blanking the property does — and it is a **different
function** (`deleteObject`), which is why one guard call site would have left a third of the defect
in place.

## 3. The shape: a description the owner writes vs an assertion an authority makes

**Declaring** region membership stays exactly as free as it is today, and the asymmetry is the point
rather than an oversight. A declaration only ever **adds** constraint — a newly-declared region target
becomes *subject* to the gate — so leaving it at the owner's own `object:write` grants the declarer
nothing. This is ADR-0003's "a declaration is not a grant" shape one layer over. **Withdrawing** the
declaration is the act that *removes* constraint, and that is the one that takes an authority's
permission.

**Renaming is not withdrawing.** `region: amer → amer-2`, or `environment: prod → prod-eu`, leaves the
target a declared region target, so the gate still applies and the guard stays out of the way. Only
the transition from "declares both" to "declares fewer than both" — including deletion of the row —
is refused.

**The bar is `object:write` at the ORG ROOT**, the mirror of the read the M15.6 surface already takes
for the same set, and strictly stronger than `object:write` at the target (authz walks containment
*upward*, so a role bound at the target, its service or its domain never reaches the org root, while
an org-root binding reaches everything). No new permission is invented and no new namespace is
introduced; a team that owns a region target keeps every other write on it.

### Why not the alternatives

**Fail closed on absence at the gate.** Checked first, because it would have been much the cheaper
fix. It does not work here, and the reason is worth recording so it is not re-proposed: the gate's
`null` is load-bearing in the *other* direction. Case (a) — an unbound plain deployment-target
dispatched against the shared default executor — is deliberate, documented behaviour that every M0–M6
demo depends on and that `multiregion-argocd.integration.test.ts` explicitly pins ("a PLAIN (non-region)
unbound deployment-target keeps its pre-existing default-executor behaviour"). Reading absence as
in-scope means blocking every unbound target that carries an `environment` label, which is a large,
uninvited behaviour change to estates that never asked for regions. A narrower cohort rule ("in scope
if some *sibling* target in the same environment names a region") avoids most of that but still
couples unrelated targets that merely share an environment *name*, and it cannot see V2 or V3 at all,
because after those there is no state left to read. The write door is where all three vectors meet.

**A reserved property namespace** (`scp.governance/region`, mirroring the reserved *label* namespace
proposed for the selector defect). Rejected as disproportionate: that namespace exists because
`labels` is a single bag serving both description and assertion for *every* object type, so the two
uses had to be separated by key. `properties.region` on a `deployment-target` has exactly one meaning
already; nothing needs separating. It is one statable sentence — *you may not stop being a region
without org-root authority* — against a new vocabulary, a migration and a re-keying, for the same
outcome. Decision priority #1 is Simplicity.

**An audit event on a reach-changing property write** is detection, not prevention: the gate still
stops firing, and the operator learns about it from a deploy that reported success without deploying.

## 4. Where it is installed

`coordination/region-membership-guard.ts`'s `assertMayUndeclareRegionMembership`, called from
`graph/objects-repo.ts`'s **`updateObject`** and **`deleteObject`** — the choke points every local
write door funnels through — and never per route.

That placement is not stylistic. `PUT`/`PATCH`/`DELETE /objects/:type/:idOrUrn`, the typed
`PUT /deployment-targets/:urn` (via `upsertObjectByUrn`, whose ordinary update branch delegates to
`updateObject`), an IaC apply and its prune, and `POST /federation/hand-fill` all reach those two
functions, and only some of them pass through `typed-registries.ts`. A per-route guard would be a
census that has to be re-run every time a route is added — which is how the defect being fixed here
came to exist.

The check runs against the value about to be **stored** (and the row as locked), not against the
request body, for the same reason `assertEnforceableDependencySubscriptionScope` does: it makes the
invariant a property of the *row* rather than of the *request*, so a `PATCH` that mentions no
properties at all withdraws nothing, and a full-replacement `PUT` that merely omits the key is caught.
Omission and deletion are the same bytes on the wire, and omission is the attack.

`federationImport` is exempt, following the same file's existing precedent verbatim and for its stated
reason rather than because imported data is trusted: `federation/import-repo.ts`'s `object_upsert`
branch has no `try/catch`, so a refusal there does not protect anything — it **wedges** the peer
channel. An imported row is authored by another domain under that domain's own authority.

The predicate mirrors PostgreSQL's `->>` rather than type-narrowing to `string`, because `->>` is the
operator the gate matches with. A target carrying `region: 0` is a declared region *there*, so it must
be one *here* too; a key that is reserved for the write check and a different key for the match would
be the evasion, rebuilt inside the guard.

## 5. Behaviour changes an operator will notice

| Change | Migration |
|---|---|
| Blanking or removing `properties.environment`/`properties.region` on a `deployment-target` that declares both now needs org-root `object:write` | grant it for the decommission, or re-send both properties (renaming is unaffected) |
| Deleting such a target needs the same | as above |
| An IaC stack that manages a region target and drops either property, or prunes the target, needs an applying actor with org-root `object:write` | grant it, or keep the declaration in the stack |

Adding a region declaration, renaming one, and every other write on a region target are unchanged.
Plain deployment-targets, and every other object type, are untouched.

## 6. What this deliberately does not do

**Grandfathered rows are not retro-fixed.** A `deployment-target` already sitting in the estate with
`environment` set and `region` blank stays out of the gate's scope, because after this change that
state can only be reached by a create or by an org-root-authorized withdrawal — both authorized acts.
The fix makes the absence *unpurchasable at the subject's permission*; it does not reinterpret
absence. This is the same grandfathering the reserved-label-namespace proposal took, for the same
reason, and it is the direct consequence of choosing the write door over the read.

**Re-parenting is not addressed**, and it is the same residual §7a of the label proposal measured
there: `domainId` and `contains` are tenant-writable with `object:write`/`relationship:write`, so a
subject that cannot remove the assertion can still move out from under scopes that key on the
containment chain. The M15.6 gate does not key on containment — it keys on the two properties this
guard now protects — so that residual does not reopen *this* defect, but it remains the cheapest
route to the same class of outcome elsewhere and should be sequenced on its own.

**A soft-deleted target that a live change already names still deploys** against the default executor
if an *authorized* actor deletes it mid-flight. Reconcile does not check that a wave target's object
is still live, for any target type — that is a general coordination concern, not an M15.6 one, and it
is reported rather than half-fixed here.

## 7. How installation is proved

`region-membership-guard.test.ts` proves the predicate **decides** correctly — specifically that it
agrees, row for row, with the `->>` read the gate matches on. It cannot prove the guard **runs**, and
a suite that reaches the guard directly is exactly the shape that cannot tell "built" from
"installed".

`regional-gate-undeclare.integration.test.ts` (11 cases) drives **real doors** through the generated
SDK as a real subject, including the control that the constraint being evaded fires at all, the
end-to-end proof that the escape is closed (`PATCH` refused **and** the gate still refuses the deploy
afterwards), four over-fire controls, and the authorized decommission. Four mutations were applied
alone against a green suite and the named cases watched to fail; the log is in that file's header and
in the PR body. Two of them carry the argument rather than bookkeeping: deleting the `updateObject`
call site does **not** kill the DELETE case and deleting the `deleteObject` one does, and a
`before`/`after` swap kills the *declaration-is-free* control — the defect inverted, with the suite
still reading 10 of 11 green.
