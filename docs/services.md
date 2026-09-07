# services

Long-form reference for the **services** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 4 of 4 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/services/objects-service.ts`](#apps-server-src-services-objects-service-ts) — §1–§4

## `apps/server/src/services/objects-service.ts`

### §1. The wire shape is the whole graph object plus its type

ADR-0023: the M0 wire shape is the WHOLE graph object plus M0's `type` discriminator — see `ServiceObjectSchema`'s doc comment for why a subset was a live contract violation (the SDK's `client.object("service")` calls the generic `createObject`/`listObjects`, which this static route shadows, and those declare a full `GraphObject`).

### §2. `POST/GET /api/v1/objects/service` (M0's contract, unchanged)

`POST/GET /api/v1/objects/service` (M0's contract, unchanged) — reimplemented on the M1 graph substrate (BUILD_AND_TEST.md §8 M1 item 10: "upgrading their implementation to the new substrate is expected"). A plain `service`-typed graph object under the hood, so anything created here is equally visible through the generic `/objects/{type}` endpoint family.

RBAC-enforced (object:write) and Idempotency-Key-aware exactly like the generic create — Fastify's router prefers this literal static route over the parametric `/objects/:type` for the exact path `/objects/service`, so this is the ONLY handler that ever runs for that path; it must carry full parity (authorization, idempotency, domainId/properties/labels/custom id-urn support), not a stripped subset, or those capabilities would silently be unavailable for the 'service' type specifically.

### §3. The declared parent, resolved once for both scope and write

The declared parent, resolved ONCE and used for both the permission scope and the write (`graph/containment-parent-authz.ts` — a wire `null` means the org root, never "detach"). The parity note above is exactly why this is here: this handler shadows the generic `/objects/:type` create for the `service` type, so every guard that door grows has to be grown here too. It was NOT, and a `POST /objects/service {"domainId": null}` wrote a detached, permanently unreachable row while the generic door wrote an org-root child.

### §4. THE DOOR A `routes/*.ts` CENSUS CANNOT SEE (role-model.md §8.1)

THE DOOR A `routes/*.ts` CENSUS CANNOT SEE (role-model.md §8.1): `routes/objects.ts` has zero `authorize(` calls and Fastify prefers its literal `/objects/service` over the parametric `/objects/:type`, so this is the ONLY handler that ever runs for that path — and the check is spelled `scopeObjectId: orgId`, with no `auth.` prefix, one directory away. It gets the same treatment as the three doors a string census does find, or the legacy service list would keep 403-ing every scoped principal after the others stopped.
