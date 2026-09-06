# rbac

Reference for `packages/schemas/src/rbac.ts`. The source carries a one-line headline at each site and points here.

> Partial: 9 of 19 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ROLES AND ROLE BINDINGS

ROLES AND ROLE BINDINGS — the API surface that finally makes `role_binding:write` mean something

`role_binding:write` has been seeded onto Administrator and Owner since `drizzle/0002` and was checked at ZERO call sites for its whole life, because there was no role-binding API at all: the committed OpenAPI document had ~177 paths and not one of them touched roles or bindings (docs/proposals/role-model.md §1.2). The only two production writers of `role_bindings` were `auth/local-auth.ts` (bootstrap admin -> Owner at the org root) and `auth/oidc.ts` (JIT OIDC user -> Viewer at the org root), so a real deployment had exactly TWO authority levels and every finer scope was reachable only by hand-written SQL — outside RLS, outside the audit chain, with no Decision record. Every purpose role `drizzle/0099` seeds is inert until these four operations exist. This is role-model.md §5 step 5.

WHAT IS DELIBERATELY *NOT* HERE
- **No `POST`/`PATCH`/`DELETE /roles`.** Custom roles are role-model.md §5 step 10 and are gated behind closing a live quorum bypass first: `hasRoleAtScope` (`authz/resolve.ts`) joins `roles` and matches `rl.name` with NO `org_id` predicate on the roles row, while the binding half IS org-filtered. So an org that could author a zero-permission role named `'Approver'` would instantly make its holders eligible quorum voters everywhere a policy names Approver — a self-service quorum bypass. `GET /roles` is READ-ONLY in this increment.

- **No `effect` on the write request.** `role_bindings.effect` is `'allow' | 'deny'` and a deny overrides every allow at any matching scope. It is present on the RESPONSE (a deny row that exists must be visible, and revocable) and absent from `CreateRoleBindingRequestSchema`, because the no-escalation subset rule that governs a grant is UNSOUND for a deny: writing a deny is not granting authority, it is removing it, and "is deny-X a subset of my permissions" is a category error rather than a hard question. role-model.md §5 step 5 rules it out of this increment; the shape a deny door needs is its own decision, not a boolean bolted onto this one.

- **No `roleName` on the write request** — `CreateRoleBindingRequestSchema` takes a role `id` only. A name would have to be resolved against `org_id IS NULL OR org_id = <this org>`, which the `roles_builtin_name_key` PARTIAL unique index (drizzle/0097) deliberately allows to match two rows, and picking between them is exactly the name-collision class the paragraph above refuses to open. An id cannot be ambiguous.

## §2. One role, as `GET /api/v1/roles` publishes it

One role, as `GET /api/v1/roles` publishes it.

`permissions` and `bindableAt` are `string[]`, NOT enums, and that is a contract decision rather than laziness. `roles.permissions` is a plain `text[]` with no CHECK and no enum type behind it (drizzle/0002 §7), so a restored dump or a hand-written row can legitimately hold a string that is not in today's `Permission` union — an enum here would make the endpoint 500 on data the database accepts. And measured previously on this repo's oasdiff gate: adding a member to a RESPONSE enum is a BREAKING change, so an enum would make every future permission split (there have been five grant migrations already) a `/v1` break. `effect` below is the deliberate exception: it is CHECK-constrained to exactly two values by `role_bindings_effect_check` (drizzle/0097), so that set is closed by the database rather than by convention.

## §3. Filter to bindings written AT this exact object

Filter to bindings written AT this exact object. Deliberately an exact match and not a containment walk: "who is bound at this service" and "whose authority reaches this service" are different questions, and the second one is `GET /authz/effective` (role-model.md §5 step 6). Answering the second here under the first one's name would be the more dangerous of the two to get wrong.

## §4. `POST /api/v1/role-bindings` — a GRANT

`POST /api/v1/role-bindings` — a GRANT.

`reason` is MANDATORY, matching `LiftFreezeRequestSchema`: handing a principal authority over part of the estate is a governance act, `audit_events` has no payload column, and the operator's own words are the one thing the structured Decision this door writes cannot reconstruct.

## §5. The prospective binding's subject

The prospective binding's subject. Any object; a `user`/`service-account` legitimately previews as an empty list, which is what makes the field's rule uniform rather than special-cased.

**THE ONLY PARAMETER, AND IT IS ALSO THE AUTHORIZATION ANCHOR.** An earlier revision took a `scopeObjectId` too, described as "an AUTHORIZATION input, not a filter": present, it admitted a holder of `audit:read` at-or-above THAT object. That was the §2b disclosure defect re-introduced one layer up, in the affordance built to make D7 usable — the scope a caller names is chosen by the caller, so any holder of a scoped `audit:read` anywhere in the org could name their own service and read the full transitive membership of ANY group in the org. The preview must not tell a caller anything they could not already read, so the check is now anchored to the SUBJECT whose membership is being disclosed (`routes/role-bindings.ts`).

**THE ANCHOR IS NECESSARY AND IS NOT SUFFICIENT**, and the next round measured why: the principals disclosed are not the subject, so authorizing at the subject still handed a team-scoped reader the identities of members that reader's own `GET /objects/user/{id}` refuses. The PROJECTION is filtered too — see `GrantPreviewResponseSchema`.

## §6. THE PROJECTION RULE

THE PROJECTION RULE — this response must not tell a caller anything they could not already read

THE DEFECT IT CLOSES, MEASURED. Gating the operation at the SUBJECT (the previous round's fix) settles who may ask about a group. It does not settle what may come back, **because the principals disclosed are not the subject**: a `member_of` member is a separate graph object with its own containment chain, and `authz/resolve.ts`'s scope walk expands UPWARD, so a Viewer bound at a TEAM reaches the team and reaches nothing through it. Measured on that exact fixture — a team-scoped Viewer received a **200** carrying the `id`, `typeId` and `name` of a member whose own `GET /api/v1/objects/user/{id}` answers **403** for the same token.

SO THE PROJECTION IS FILTERED, NOT JUST THE GATE. `principals` and `acknowledgedPrincipalIds` contain only principals the caller holds `object:read` at — the same resolved answer `GET /objects/{type}/{idOrUrn}` is judged by — and the remainder is reported as `GrantPreviewResponseSchema`'s `withheldPrincipalCount`.

**A BARE COUNT, DELIBERATELY, AND IT IS A TRADE RATHER THAN A ZERO.** It still discloses that the group has members this caller may not see, which is a fact about rows they cannot otherwise reach. It is accepted for the reason role-model.md §8.2 accepts query-side filtering on the list doors: the alternative that leaks strictly less — omit the count entirely — makes the response indistinguishable from "this group is empty", which is exactly the state D7 exists to stop a granter mistaking. The count names nobody and cannot be resolved to an identity through any door, and it is already implied for any caller who can reach the grant door at all (its 409 names the full set). It is NOT inert, and the honest statement of the trade says so: it is a size signal that CHANGES with the membership, so a caller who may see none of a group can still poll it and observe that the group grew. Measured: a team-scoped Viewer seeing `principals: []` throughout read 0, then 1, then 2 as an admin added members. Accepted for the same reason the rest of the trade is.

**WHY NOT A DIGEST INSTEAD OF IDS.** Weighed and rejected for the same reason the request field is an id list rather than a hash (`CreateRoleBindingRequestSchema`): a digest is computable only by a caller who already holds the ids, so it withholds nothing from the caller who is refused here and destroys the ability to name the difference for the caller who is not.

D7 STILL WORKS, AND WHICH CALLERS IT WORKS FOR IS MEASURED RATHER THAN ASSUMED
The acknowledgement would be theatre if the preview hid members from the very person about to empower them. It does not, and the reason is a property of the seeded catalogue rather than a hope: **every built-in role that carries `audit:read` also carries `object:read`** (drizzle/0002 §7 and drizzle/0099 — Viewer, Operator, Approver, Administrator, Owner and every purpose role), so a caller admitted by this door's ORG-ROOT arm reads every rooted object in the org and `withheldPrincipalCount` is 0 for them. That is the caller who grants at the org root, which is where a group binding of an administrative role is written. Pinned by `routes/rbac-administrative-floor.integration.test.ts`, in both directions.

THE RESIDUAL POPULATION IS NAMED RATHER THAN WISHED AWAY: a caller admitted only by the SCOPED arm — `audit:read` at-or-above the group, from a binding somewhere below the org root — may hold no `object:read` over members that live elsewhere in the estate. They get `acknowledgementComplete: false`, and pasting the value they were given IS refused. **They are not handed a field that 409s forever**: `POST /role-bindings`'s own 409 names every id missing from the acknowledgement, and that refusal sits behind `role_binding:write` at the scope plus the full subset rule — a strictly stronger bar than this operation's `audit:read` — so the second attempt succeeds. Measured end to end (403-on-the-member, filtered preview, 409 naming the member, 201 on the retry) rather than reasoned about.

## §7. A partial update

A partial update. Omitted fields are left alone rather than cleared — a PATCH that dropped `bindableAt` because the caller did not mention it would silently widen where the role may be bound.

⚠️ WIDENING A ROLE WIDENS EVERY EXISTING BINDING OF IT, with no re-check — the same property `docs/authz/role-binding-door.md` §8 records for built-ins, except that here it is reachable through the API rather than only through a migration. The subset rule bounds it: a caller may only add permissions they themselves hold at the org root, so a role can never be widened past its editor's own authority. It is NOT bounded by what the original AUTHOR held, and it is not re-checked against the holders — both stated rather than implied.

## §8. INSTANCE OPERATOR CREDENTIALS

INSTANCE OPERATOR CREDENTIALS — role-model.md §5 step 9 / §3B

Replaces the single shared `SCP_OPERATOR_TOKEN` with named, hashed, individually revocable, optionally expiring credentials. See `auth/operator-auth.ts` for what was wrong with the shared string; the short version is that it cannot be rotated, revoked for one person, or expired, and it makes "who was entitled to do this" have the same answer for everyone who has ever seen it.

NOT ORG-SCOPED. These are instance tier — the authority they carry binds every organization on the deployment — so the operations are gated by an operator credential, never by an RBAC permission. A tenant, however privileged inside its own org, must never author config that binds its neighbours.

## §9. How the CALLING request was admitted

How the CALLING request was admitted. `bootstrap-env-token` means this deployment is still relying on `SCP_OPERATOR_TOKEN` — surfaced because the migration from it is otherwise invisible: an operator would have no way to tell a deployment that has moved from one that has merely minted credentials and never stopped using the env var.
