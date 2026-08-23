# Proposal: the homepage as a high-level dashboard

**Status:** v0.1 Draft — **proposed, pending review.** A layout mock was built and reviewed in a browser against a seeded instance (`apps/web/src/routes/dashboard-mock.tsx`, throwaway); nothing else is built.
**Role:** Turn `/` from a second copy of the left nav into the page an operator opens to see what is happening and what needs them.
**Relates to:** `apps/web/src/routes/dashboard.tsx`, `apps/web/src/routes/service-board.tsx`, `GET /services/{idOrUrn}/board` (`routes/services.ts`), [ADR-0008](../adr/0008-observe-enrichment-signals.md) (object health as observe-enrichment signal 4), [GLOSSARY §assembly](../GLOSSARY.md), PROJECT_CHARTER principles 1 (coordination not execution), 3 (API-first parity) and 6 (explainability).

Owner ask, 2026-08-10: *"It should be a high-level dashboard of all services in the org. Maybe show status, links to the services and their assemblies and components."*

## 1. What the page is today — measured

`routes/dashboard.tsx` renders exactly three things: the org name, a grid of registry links, and a live-activity card. The grid is driven by the same `REGISTRIES` array (`lib/registries.ts`) as the sidebar's REGISTRIES section, so **the entire body above the fold is a second rendering of the left nav**. It answers "where can I go", which the nav already answered, and never "what is happening" or "what needs me".

## 2. The two things called "status", and why they must not merge

| | Source | Who is authoritative | Default on a fresh instance |
|---|---|---|---|
| **Release / coordination state** | `GET /services/{id}/board` → `summary.{releasing,blocked,stable,notDrivenHere}` | SCP itself | real values |
| **Runtime health** | `GET /objects/{type}/{id}/health` → `healthy\|degraded\|down\|unknown` | whatever pushes it (ADR-0008 signal 4) | `unknown` everywhere |

SCP never probes (charter principle 1). A single green/red dot per service would assert that it does. **Decision:** the dashboard's primary axis is release state; runtime health is a separate, explicitly-labelled column that renders `unknown` honestly.

## 3. Honesty invariants this page inherits

Both already hold in `service-board.tsx` and are the two most likely to be lost in a roll-up:

1. **`unknown` is its own visible bucket, never folded into `stable`.** `service-board.tsx` carries `isUnknown`/`declaredUnknowns`/`notDrivenHere` for exactly this. An org-wide roll-up is where "47 stable" silently becomes a clean bill of health over rows this instance cannot see. Unknown gets its own count and its own (non-success) colour.
2. **Counts, not synthesized verdicts.** [GLOSSARY §assembly](../GLOSSARY.md) rules that an assembly shows *a component count and a link down, not a status*, because rolling child state upward needs a rule nobody has chosen. The same reasoning governs service rows: a service shows `1 releasing · 1 blocked · 4 stable`, never "checkout is red".

## 4. Blocks, in page order (owner-approved 2026-08-10)

1. **Needs you** — pending approvals, blocked changes with a `Why?` link into the Decision (principle 6), emergency changes in flight. The block that makes this a dashboard rather than a directory; nothing in the UI answers it today.
2. **Freezes** — **active and impending, impending meaning ≤ 14 days out.** Placed above the service table because a freeze changes what every number below it means.
3. **Services** — the roll-up. Per row: service, component count, assembly count + link down, the four release counts, health, freeze marker, link to its board.
4. **Federation** — peer reachability and journal lag, rendered **only when this instance is federated**.
5. **Warnings** — `/doctor` and `/graph/integrity`, rendered **only when non-clean**. Note: `routes/doctor.ts` has exactly one check today (`federation-self-origin`), so this is a thin but extensible slot.
6. **Live activity** — kept, demoted to the foot of the page.

**Cut:** the registry grid. The nav already has it. If it is kept, the cards must carry counts — a count is information, a label is not.

## 5. Scope: whose services

**Decision:** default to services owned by the signed-in user's teams, with an `All services` toggle. At 200 services "all" stops being a dashboard and becomes the services registry again.

**Measured:** `owned-by` is *not* a named graph query (`graph/named-queries.ts` has `owners-of`, `dependents-of`, `consumers-of`, `impact-of`, `blast-radius`, `domains-impacted`, `paths-between`, `initiative-rollup`). The chain is nonetheless derivable: `GET /auth/me` → `subjectObjectId` → `GET /relationships?fromId=…&typeId=member_of` → teams → `GET /relationships?fromId=<team>&typeId=owns` → owned services. That is 1 + N round trips from the browser, which is the argument for resolving it server-side (§6).

## 6. The API gap, and the proposed addition

**Measured:** there is no org-wide aggregate. `/services/{id}/board` is per-service, and each call resolves waves, placements, bindings and freezes. Fanning out N of them from the browser is an N+1 that falls over well before 100 services.

**Proposal:** add `GET /services/board`, returning one summary row per service, with a `scope=mine|all` parameter that resolves §5's ownership walk in a single query.

- Additive, so the `oasdiff` gate stays clean.
- Principle 3 (API-first parity) means CLI and SDK get it for free — `scp service board --all` is independently useful.
- It puts the unknown-bucket computation on the server, beside the board honesty logic that already exists, rather than asking the UI to re-derive it.

## 7. Deltas raised against the mock, not yet decided

These were flagged during review and are the only open items:

- The per-row `FROZEN` chip duplicates the Freezes block. Keep one.
- Row order is currently arbitrary; it should almost certainly sort by attention (blocked, then releasing, then quiet).
- `Needs you` has no empty state. Decide whether "nothing waiting on you" is a positive confirmation or simply absent.
- The Health column is mostly `unknown` on an instance where nothing pushes health. Consider rendering the column only when at least one in-scope service has ever had health pushed.

## 8. Placement in the app (owner decision, 2026-08-10)

This **replaces** the existing dashboard at `/` — it is the base route, not a new page beside it. The nav's "Dashboard" entry points at it; there is no second dashboard. `routes/dashboard.tsx` is rewritten in place, and the registry grid it renders today is removed (§4).

## 9. Not in scope

Editing anything from the dashboard. Every block links out to the surface that already owns the write.
