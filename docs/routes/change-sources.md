# change-sources

Reference for `apps/server/src/routes/change-sources.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 14 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. MAJOR #5 — dedupe redeliveries/replays

MAJOR #5 — dedupe redeliveries/replays. Prefer the provider's own delivery identifier (GitHub `X-GitHub-Delivery`, or a generic `X-SCP-Delivery` an adapter can set), which is stable across a redelivery of the SAME event; fall back to a hash of the raw body when no delivery header exists. The unique index on (org_id, source_kind, dedupe_key) makes a second delivery of the same key a no-op (returns the FIRST event's id), so a replayed — even validly-signed — webhook never creates a second Change / fires a second real trigger.

## §2. Typed first-party report ingress (DESIGN §12 Mode 1)

Typed first-party report ingress (DESIGN §12 Mode 1). `scp change-source report <sourceKind>` — a one-line CI step that reports a plan/apply result — POSTs a TYPED body here instead of the raw `/webhook` shape. Two reasons this is its own route, not the webhook with a schema: 1. Contract (charter principle 3): the webhook body is `z.record` by necessity (it accepts arbitrary provider payloads), so it cannot carry a typed SDK. A report is first-party and CAN, so the SDK/CLI get a real generated contract instead of a hand-cast `Record`. 2. Auth model: the webhook does HMAC verification when the org+sourceKind has a secret configured — which would REJECT a report (it carries no HMAC signature), so an org that set a `terraform` webhook secret could not `scp change-source report terraform` at all. A report is authenticated by its PAT (`requireAuth`), the same trusted-first-party stance `observe.ts` takes, so it skips HMAC and sets `signatureVerified: true`. Same persist-then-process path otherwise: it writes a `change_source_events` row that the next reconcile tick correlates (repo/path/correlationKey are read from the top-level payload by `webhook-processor.ts`'s `genericHint`).

## §3. READ THE ROW, THEN BAR AT ITS COMPONENT

READ THE ROW, THEN BAR AT ITS COMPONENT (or the org root — `assertSourceMappingWritable` is a disjunction, and its docblock is where the reasoning lives). A source mapping has no containment scope of its own; the authority that governs it is authority over the component it binds a repo/path pattern to, which is only knowable once the row is loaded. Reading first is also what keeps an unknown id answering 404 (`getSourceMapping` throws it) instead of the 403 that scoping at an id naming nothing would produce for every caller, org-root Owner included. `component_object_id` is immutable (the setter below writes `enabled`/`disabled_until` only), so there is nothing for the second statement to have moved out from under.

## §4. DELETE a source_mapping

DELETE a source_mapping. The first operator-facing delete this table has had — before it, the only way to remove a mapping was an IaC apply's prune, so a mapping created by `discovery accept` or by hand could never be taken back through the API.

That gap has a cost beyond inconvenience. A component merge (M12 P5d, `docs/proposals/organize-after.md` §2.4) soft-deletes the absorbed component and STRANDS its mappings; they are neutralised at read time (they no longer match a dead component) but they stay in the table, keep appearing in `GET /mappings`, and cannot be cleaned. On the live homelab that is 5 rows from three merges.

Matches the full IDENTITY TUPLE rather than an id — see `DeleteSourceMappingRequestSchema` for why (duplicates exist; deleting one leaves the survivor correlating). Reports the row COUNT so a no-op is visible instead of looking like success.
