# version-index

Reference for `apps/server/src/dependencies/version-index.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 7 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE HEAD OF A LINE

THE HEAD OF A LINE — the single ranking function.

Pure and total: no I/O, no throw, and every rejected candidate is accounted for in the returned counts. Extracted as a pure function per BUILD_AND_TEST.md §4.1 so the never-guess properties are pinned without a database, a network, or a plugin host.

A caller MUST treat `head === undefined` as "record nothing". There is deliberately no "best-effort" branch and no `?? versions[0]`: the moment such a fallback exists, the failure mode is a plausible-looking wrong answer instead of a visible absence.

## §2. Resolve ONE line's head

Resolve ONE line's head.

Order of resort, and why it is this order: 1. THE INDEX PLUGIN, when this deployment configures one for the ecosystem. Live, authoritative. 2. THE OPERATOR-LOADED SIGNED FEED, when it does not — the air-gap path (see `version-index-feed.ts`, which copies the Trivy-DB shape verbatim). A HARD-STALE feed is refused rather than used, fail-closed, exactly as a hard-stale scanner DB is. 3. UNAVAILABLE. Never "no new version".

A feed is not consulted when a live index answered — including when it answered `unknown_coordinate` or `unauthorized`. A live index's "I do not have this package" is a real answer about the world, and letting a months-old operator snapshot override it is how a subscription gets bumped onto a version that was withdrawn.

IT TAKES A `ThirdPartyLine`, AND THAT IS THE INGRESS SPLIT, NOT A TYPE FLOURISH (ADR-0032 §7). An INTERNAL line's head is DERIVED from the org's own production releases; polling one against a public index lets a stranger's package that shares the coordinate overwrite the org's own `2.1.0` with `9.9.9`, and every subscriber is then bumped onto it — dependency confusion, arriving on a daily timer. The brand means a caller cannot pass an internal line by forgetting a filter: the only constructor is `asThirdPartyLine`, which reads `produced_by_object_id`.

## §3. A MUTABLE TAG IS NOT AN IDENTITY

A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7): for images the digest is what the version claim actually means, so it is resolved for the head and only the head — one extra call per line, not one per tag.

AN UNRESOLVED DIGEST IS `null`, NEVER ABSENT. A digest that cannot be resolved does not void the observation — the tag is still the head, and the air-gap feed carries no digests at all, so requiring one would make an air-gapped estate unable to record an image head ever. But it must travel as an explicit `null`: while this field was optional, an unresolved digest left the PREVIOUS version's digest standing beside the NEW tag, and the row asserted a (tag, digest) pair that never existed in any registry. The pair moves together — `recordDependencyLineHead` writes both from this one observation.
