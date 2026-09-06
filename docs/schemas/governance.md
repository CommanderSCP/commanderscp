# governance

Reference for `packages/schemas/src/governance.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 18 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED

M22.8 — WHICH GATE CROSSING THIS RUN AUTHORIZED. Both columns have existed on `control_runs` since M4; neither has ever been projected onto the wire.

That was survivable while a change had at most ONE run per control: `latestControlRun` was keyed `(orgId, changeObjectId, controlObjectId)`, so the single row WAS the change's answer and naming the crossing added nothing. M22.0a changed that — the cache key now carries gate identity, so a change legitimately carries a run per crossing (the `validating -> accepted` lifecycle edge, then one per wave boundary), and M22.7 adds forced re-runs on top. An operator reading `GET /changes/{id}/control-runs` today sees several rows with the same control and status and no way to tell which one let production through.

OPTIONAL ON THE WIRE, NOT NULLABLE, and the distinction is the oasdiff rule this repo has already paid for once: making an EXISTING required response field optional is a breaking change, so these are added as new optional fields beside the required ones rather than by re-shaping anything. The columns are `NOT NULL`, so a live server always sends them; the optionality exists for older generated clients, never as a licence to omit them.

## §2. M22.9 — `GET /control-runs/{id}/findings`

M22.9 — `GET /control-runs/{id}/findings`.

`findingsRecord` IS REQUIRED AND NULLABLE, and that is the whole contract, not a style choice. Every marker state except `full` — `truncated`, `unsupported`, and ABSENT — refuses every exclusion for that scan ("you cannot except what you did not record", ADR-0033 §7), so a response that hands back a bare array is one a consumer can use without ever learning that the set it is looking at is not the set the scanner produced. Required-and-nullable rather than optional so `null` POSITIVELY says "no marker was recorded"; an omitted optional field would be indistinguishable from a client too old to know the key, which is the ambiguity this field exists to remove.

## §3. M25.1 — the body of `DELETE /api/v1/freezes/{id}`

M25.1 — the body of `DELETE /api/v1/freezes/{id}`.

A BODY ON A DELETE, following `DeleteSourceMappingRequestSchema` (the shipped precedent on `DELETE /change-sources/{sourceKind}/mappings`), because the reason is MANDATORY and a free-text governance justification does not belong in a query string.

`reason` IS REQUIRED, and that is the whole schema. Lifting a freeze retracts a protection for EVERYONE covered by it — a strictly wider blast radius than `freeze:override`, which lets one change past and leaves the freeze standing, and which has refused to work without a reason since M4 (DESIGN §10.3). A loosening with no recorded reason is exactly what that refusal exists to prevent.

AND THAT RADIUS ARGUMENT IS ALSO THE PERMISSION (M25.9 / owner ruling D1(a-ii), 2026-08-25). This verb takes `freeze:write` at the freeze's own scope, plus the Owner-only `freeze:override` at that same scope whenever the acting subject is not the freeze's `created_by_actor_id` — the wider verb can no longer cost the narrower permission. Lifting YOUR OWN freeze stays `freeze:write` alone, so declaring a freeze is never an entrance with no exit for the role that declared it. The same pair governs a SHORTENING via `UpdateFreezeWindowRequestSchema`, or the retraction would be one PATCH away.
