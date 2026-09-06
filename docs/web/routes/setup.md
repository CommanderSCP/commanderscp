# setup

Reference for `apps/web/src/routes/setup.tsx`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 15 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Platform freezes card (M25.UI increment 3) — READ-ONLY

Platform freezes card (M25.UI increment 3) — READ-ONLY. `apps/server/src/routes/ instance-freezes.ts`'s module doc states the reason at length: WRITE is operator-only, gated on `SCP_OPERATOR_TOKEN` presented as `x-scp-operator-token` — a deployment-level credential this browser session never holds and must never be asked to type into a form (same posture as `admin-governance.tsx`'s instance rung — see that file's "NO BROWSER WRITE HERE, DELIBERATELY" comment, mirrored below). READ is tenant-facing (`GET /v1/instance/freezes` needs no operator token): a platform freeze is the one freeze a tenant cannot author and by default cannot override, so a tenant that cannot even SEE it cannot be told why its release stopped (charter principle 6) — hence a card at all, where the sibling instance-scan-floors doors have none yet.

## §2. One platform freeze, read-only

One platform freeze, read-only. `freezeWindowStatus`/`freezeStatusBadge` above are reused UNCHANGED — `InstanceFreeze` carries the identical `startsAt`/`endsAt`/`liftedAt` shape `Freeze` does, so a second copy of the same window arithmetic is not needed and would be exactly the kind of drift risk this codebase's census discipline exists to catch.

## §3. Lift, scoped per row

Lift, scoped per row. `variables` is read back for the error case so a refusal renders under the row it belongs to: `freeze:write` is checked AT EACH FREEZE'S OWN SCOPE, so a caller can legitimately be allowed to lift one freeze in this list and refused another, and a single card-level error banner would attribute the refusal to whichever row was clicked last.
