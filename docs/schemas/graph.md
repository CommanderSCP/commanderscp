# graph

Reference for `packages/schemas/src/graph.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 19 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Full graph model contract (DESIGN.md §4.1)

Full graph model contract (DESIGN.md §4.1). Supersedes M0's single-purpose `ServiceObject` shape with the generic object/relationship model shared by every registry type — built-in or org-defined via the runtime type registry (§4.1 "custom types are data, not DDL").

## §2. Which SIDE of an edge is singular

Which SIDE of an edge is singular. `one_to_many` makes the **to** side singular (one live incoming edge of this type per `to_id`); `many_to_one` makes the **from** side singular (one live outgoing edge per `from_id`); `one_to_one` makes both; `many_to_many` neither.

`many_to_one` was added by ADR-0026 / post-import-configuration.md D11 for `releases_via` (`component -> release-topology`: each component releases via at most one pipeline, each pipeline serves many components). Before that it was ABSENT here and had no branch in `assertCardinality` — so a hand-inserted `many_to_one` fell through every check and was silently unenforced, which is why migration 0021 registered `contains` as the mirror instead. Every value in this enum now has an enforcing branch, and `assertCardinality` FAILS CLOSED on any value that does not (the column is plain `text` with no CHECK constraint).

## §3. The containment parent

The containment parent. Carried as a `.describe()` rather than as a JSDoc comment ON PURPOSE: JSDoc does not reach `z.toJSONSchema()`, so it would never appear in `tools/openapi/openapi.v1.json`, in the generated SDK, or in a client's editor — which is exactly where this fact was missing (ADR-0032 §8g). If you shorten this string, shorten the argument, not the literal request body: the body is the part a caller can copy.

## §4. Strict upsert-by-URN for a component (M12 P5a)

Strict upsert-by-URN for a component (M12 P5a). `service` is REQUIRED when the URN is new (the create branch honours the same "a component must belong to a service" invariant as POST) and OPTIONAL when it already exists (an update is field-only; re-assignment is the P5b move verb). The route enforces the create-branch requirement — the schema leaves it optional so a plain rename of an existing (possibly still-unassigned, imported) component needs no service.

## §5. Rows that outlived the object they hang off

Rows that outlived the object they hang off.

READ-ONLY, and deliberately so: repair is performed by the ordinary `DELETE` doors (`/relationships/{id}`, `/change-sources/{kind}/mappings`, `/executors/{idOrUrn}/binding`), each of which already writes its audit event and journal entry in the same transaction. A dedicated bulk-repair endpoint would be a second, unaudited way to destroy rows — exactly what principle 6 exists to prevent.
