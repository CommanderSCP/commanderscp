# campaigns

Reference for `packages/schemas/src/campaigns.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 34 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE AUTHOR'S DOOR

THE AUTHOR'S DOOR — `z.strictObject` throughout, and open in the property registry (the 0043/0075 rule: `import-repo.ts`'s `object_upsert` branch Ajv-validates against the REGISTERED schema with no try/catch, so a closed registry schema makes every future key a fail-closed version-skew hazard that wedges a peer's whole signed bundle; a refusal here costs one 400 and nobody's bundle).

EVERY FUTURE KEY MUST BE OPTIONAL. M25.5's `adoption` evidence is the next one, and this schema is reachable through federation promotion (a promoted change carries its recipe — see `promotion-repo.ts`), so a REQUIRED addition would make a newer commander's promotion unparseable at an older outpost. `version` exists to say which vocabulary the document speaks, never as a licence to make a later version's key mandatory.

## §2. VERBATIM into `TriggerIntent.parameters`

VERBATIM into `TriggerIntent.parameters`. **SCP performs NO cross-provider translation** — a recipe written in `github` keys is never guessed into `gitlab` shape (see the adapter table in `docs/adr/0041`). Translating would mean re-rendering a declaration SCP does not fully model, and a wrong guess triggers the wrong automation in a tenant's own repository. The author picks the keys their bound executors read; a target whose executor cannot serve the recipe's KIND is refused loudly rather than silently defaulted.

## §3. THE STORED / READ SHAPE

THE STORED / READ SHAPE — `z.strictObject`, and OPEN in the property registry, the same 0043/0075 split `CampaignRecipeSchema` documents. Wire-side strictness is a LOCAL authoring refusal (one 400, nobody's bundle); a tightened REGISTRY schema is a fail-closed version-skew hazard that wedges a peer's whole signed bundle at an older receiver. Hence: no property-schema migration in this increment either, and a document a newer commander writes that this schema refuses degrades to "no deadline" on the read surface and to a loud `warn` at the predicate — never to a silent lock.

`overrides[]` — §4.1's fourth key — LANDS HERE IN M25.6b, and only here. The two AUTHORING doors take `CampaignDeadlineInputSchema`, which omits it; see `CampaignDeadlineOverrideSchema` for why that split is the authority check rather than a tidiness preference.

## §4. THE AUTHOR'S DOOR

THE AUTHOR'S DOOR — what `POST /campaigns` and `POST /campaigns/{id}/deadline` accept.

IDENTICAL TO `CampaignDeadlineSchema` MINUS `overrides`, and still STRICT, so naming `overrides` at either door is a 400 rather than a value silently dropped on the floor. Minting a waiver takes `campaign:deadline-override` (Owner-only, drizzle/0088) at the campaign PLUS `object:write` at each named target. `POST /campaigns` takes plain `object:write` at the campaign alone (a create is always a FIRST set), and so does `POST /campaigns/{id}/deadline` when it sets a first deadline or SHORTENS one; only that route's WIDENING acts — clearing, and moving the instant later — also take `campaign:deadline-override` (owner ruling 2026-08-25, D1 b-i). Neither door demands the per-target `object:write` a waiver does, and the create door demands nothing extra at all, so one shared schema would still be the permission's bypass.

Deriving it by `.omit()` rather than declaring a second literal object is what keeps a future third key (`at`-like configuration, not a waiver) from being added to one and not the other.

## §5. The new deadline, or `null` to clear it

The new deadline, or `null` to clear it.

`CampaignDeadlineInputSchema`, NOT `CampaignDeadlineSchema`: accepting `overrides` here would let this verb mint the very waivers `POST /campaigns/{id}/deadline-override` exists to produce — at plain `object:write` whenever the act is a tightening, and without the per-target `object:write`, the per-target audit event or the named target list even when it is not. Naming the key is a 400 (the schema is strict), not a silent drop. The waivers already in force are PRESERVED across a set or a move — see `setCampaignDeadline`.

## §6. THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND

THREE VALUES, AND THE THIRD IS NOT A DEGRADED SECOND. `unknown` means "the named evidence source had nothing to say about this component" — never ingested, no control run, no wave target — and it is a DIFFERENT fact from `not_adopted` ("we looked and this component is below the floor / the control did not pass"). Collapsing them would make an un-ingested component indistinguishable from an observed laggard, and would put the platform one refactor away from reading a missing fact as a satisfied one.

BOTH `unknown` AND `not_adopted` KEEP A TARGET IN THE CAMPAIGN. Only `adopted` is an exit — from the fan-out here, and from M25.6's deadline lock. That asymmetry is the R3 rule in its operational form, and it is why the enum can never grow a fourth "probably" value.
