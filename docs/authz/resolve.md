# resolve

Reference for `apps/server/src/authz/resolve.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. RBAC permission resolution (DESIGN.md §7)

RBAC permission resolution (DESIGN.md §7). One recursive CTE does both expansions the design calls for in the same query:

- **Subject expansion**: the acting subject (a `user`/`service-account` graph object) plus every group/team it transitively belongs to via built-in `member_of` relationships. - **Scope (containment) expansion**: the target object plus every containing ancestor, by two routes — `objects.domain_id` up to the org root (every object's chain is BUILT to terminate there — graph/objects-repo.ts defaults `domainId` to the org root object at creation time, so this walk never needs NULL special-casing beyond the root itself; a TOMBSTONED ancestor cuts it short, which is the caveat on route 1 in `scopeExpandCte`'s doc and matters more than it reads), AND the `contains` edge from a component to its service (migration 0021), which is what finally makes DESIGN §7's documented `component -> service -> domain -> organization` chain real. See `scopeExpandCte`.

`role_bindings` rows whose `(subject, scope)` pair matches either expansion, and whose role grants the requested permission, are collected; an explicit `deny` at ANY matching scope wins over any `allow` (deny-override, DESIGN.md §7). No matching binding at all is a default deny. Both expansions are depth-limited to 10 (DESIGN.md §5's traversal bound, reused here).

## §2. THE PERMISSION CATALOGUE

THE PERMISSION CATALOGUE — the single runtime source of truth, and the reason it is an ARRAY and not a union.

This was a hand-written `type Permission = "a" | "b" | ...` union for its whole life, which a TypeScript build erases: there was NO value at runtime enumerating the permissions this system defines, so nothing could ever ask "is every permission I define actually granted to somebody, and demanded somewhere?". `org:admin` is what that costs — seeded to Owner by drizzle/0002, demanded at ZERO call sites for its entire life, and removed only when a human ran a census by hand in 2026-08 because `GET /roles` was about to publish it.

`Permission` is now DERIVED from this array (below), so the type and the enumeration cannot disagree: adding a member to one adds it to the other, and there is no edit that changes the union without changing what the drift gate iterates. That is the property; the array is just how it is obtained.

ORDER IS PRESENTATION ONLY. Grouped by the milestone that introduced each member, because the comments below carry the reasoning per member and reasoning reads chronologically. Nothing depends on the order — `role-model.md` §5 step 4's gate compares SETS.

## §3. THE SECOND BAR ON PAIRING

THE SECOND BAR ON PAIRING — adding a federation peer, or re-keying one (owner ruling D4, 2026-08-25; docs/proposals/role-model.md §4.1). Demanded by `POST /api/v1/federation/peers` (`routes/federation.ts`) ON TOP OF the `federation:write` that door already demanded — added, never substituted, so nothing that could pair before this permission existed can pair without it.

THE CHAIN IT CLOSES. `POST /federation/peers` takes the peer's Ed25519 `publicKey` VERBATIM from the request body, and `POST /federation/imports` — same single `federation:write` — hands every entry of a bundle signed by that key to `applyEntry`, whose `object_upsert` branch resolves ANY registered `typeId` through `upsertObjectByUrn`. So on `federation:write` alone: pair a peer with a keypair you generated, import a bundle you signed with it, and you hold estate write authority having never held `object:write`. Pairing is the only link in that chain that can be gated — a throw on the IMPORT path wedges a legitimately paired peer's whole signed bundle, and an import from a legitimately paired peer writing what that peer sent IS the federation contract working.

WHY NOT JUST `federation:write`. The two are different acts: operating a link that somebody with standing established, versus establishing one. Only the second decides WHOSE SIGNATURE this instance will believe, which is the trust anchor for every bundle that arrives afterwards. A FederationAdmin role — `federation:read` + `federation:write`, `object:write` deliberately withheld — is being written on exactly that split, so folding the two together would make the role a lie the day it is bound.

NARROWS NOTHING LIVE. drizzle/0094 grants it to Administrator and Owner, which drizzle/0012 already makes the only holders of `federation:write`; no principal that can pair today loses the ability. It is withheld from the future FederationAdmin, which is the whole point.

SCOPED AT THE ORG ROOT, like every other check on these routes: `federation_peers` rows are an org-instance-wide concern with no containment scope of their own.

NOT DEMANDED BY `PATCH /federation/peers/{id}`, which is transport-only: its request schema (`UpdateFederationPeerRequestSchema`) admits no key material at all, so that door cannot rotate, supersede or revoke a trust anchor — the capability is absent from the contract, not merely unused. Editing a peer's endpoint stays `federation:write`; the moment that body could carry a key, this permission belongs there too.

## §4. THE THREE PERMISSION SPLITS

THE THREE PERMISSION SPLITS (role-model.md §5 step 3; drizzle/0099)
The permission census behind them found `object:write` demanded at 62 call sites and `object:read` at 45 — 107 of 170 — while every purpose-built high-consequence permission (`freeze:override`, `change:emergency`, `campaign:deadline-override`, `approval:write`, `audit:read`) is demanded exactly once. The care spent designing narrow permissions was not reflected in what actually gated the estate. These three take the highest-consequence acts back out of the two generic verbs.

ONE OF THE THREE SUBSTITUTES, TWO ARE ADDED. Which is which is the load-bearing detail and is stated on each member below; getting it backwards either silently deletes a bar or breaks a door nobody meant to break.

## §5. THE INVERSE WALK

THE INVERSE WALK — emitted as the `member_expand` CTE term. Same edges, same bound, read the other way: the seed group/team, plus every principal (and nested group) that transitively reaches it.

WHY A SECOND DIRECTION EXISTS AT ALL. `subjectExpandCte` is seeded at a KNOWN principal and finds the groups above it, which is what a permission check needs. `docs/authz/role-binding-door.md` §2b asks the opposite question — a binding is about to be written ON a group, and the door needs the principals BELOW it — and the group is the known end there. Seeding `subjectExpandCte` at the group would walk further UP into the groups the group belongs to, which is a different set and answers nothing about who the binding empowers.

The seed row is included at depth 0, so a caller that also wants "the subject itself" gets it without a special case; a caller that wants members ONLY filters `depth > 0`.

## §6. ADR-0037, INHERITED DELIBERATELY

ADR-0037, INHERITED DELIBERATELY. Every permission ABSENT from `held` is a refusal, and a refusal produced by a walk that hit the depth bound is a lie: a grant may exist beyond it. The probe runs at most once here — `hasPermission` pays it per refusal, and this function would otherwise pay it up to 22 times to say the same thing about the same two walks.

The condition is "some permission was refused", not "nothing was found": a subject holding 3 of 22 permissions has been refused 19 times, and those 19 refusals are exactly as untrustworthy under truncation as a total blank would be.
