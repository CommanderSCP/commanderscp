# rbac

Reference for `packages/iac/src/rbac.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 4 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. TYPED RBAC CONSTRUCTS

TYPED RBAC CONSTRUCTS (L2) — `RoleBinding` and `OrgRole`, thin sugar over the manifest contract.

WHY THESE EMIT THROUGH THE L1 DOORS
Every construct here ends in `stack.addRoleBinding(...)` / `addRole(...)` — the same hatches a hand-authoring caller uses. D16(1)'s "an L1-authored entry and its L2 equivalent synthesize identically" is then true BY CONSTRUCTION rather than by two code paths agreeing, which matters because generated files and standards packages author through L1 and would otherwise drift invisibly until somebody diffed two manifests.

WHAT THIS DELIBERATELY CANNOT EXPRESS: A BINDING TO A GROUP OR TEAM
`RoleBinding` REFUSES a `group` or `team` subject at synth. That is the one substantive design decision in this module and it narrows the surface rather than guarding it.

D7 requires the granter to acknowledge every principal a group binding empowers, compared by SET EQUALITY at the door. In a manifest that value is a MEMBERSHIP SNAPSHOT, and it goes stale the moment anyone joins or leaves. The failure that produces is not "the snapshot is wrong" — it is that a stale-snapshot refusal TRAINS THE AUTHOR TO STOP READING IT. They paste whatever the last error named, and a control whose entire purpose is that a human looks at the current membership becomes a checksum updated mechanically. Refusing here sends them to `scp role-binding grant-preview` + `create`, where the set is read at the moment of granting.

The refusal lives in this L2 layer rather than in `Stack.addRoleBinding` because the L1 door takes URNs it cannot resolve to a type at synth time. A construct knows what it was handed.

WHO APPLIES IS WHO IS JUDGED
`authz/role-binding-door.ts`'s no-escalation subset rule is evaluated against the APPLYING principal, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9) and for the reconciler is a system actor. So a declared binding is refused unless the applier already holds every permission that role carries at that scope — meaning **a team's own repo cannot bootstrap that team's permissions**. That is the rule working rather than a gap, and it is stated here because the symptom (an apply that refuses a line the author believes is correct) is otherwise hard to attribute.

Note also that `prepareApplyChecks` runs every authorization check to completion BEFORE any mutation, in one transaction. A binding whose legality depends on a role created in the SAME manifest is therefore judged against the graph as it stood BEFORE the apply, and is refused. Split such a manifest in two; failing closed is deliberate.

## §2. Grants a role to a `user` or `service-account` at a scope

Grants a role to a `user` or `service-account` at a scope.

```ts new RoleBinding(stack, "ci-deployer", { subject: ciAccount, role: "ComponentAdmin", scope: checkoutComponent, reason: "CI deploys checkout" }); ```

## §3. Declares an organization-defined role

Declares an organization-defined role.

```ts new OrgRole(stack, "release-captain", { name: "Release Captain", permissions: ["object:read", "change:accept"], reason: "seat the release team" }); ```
