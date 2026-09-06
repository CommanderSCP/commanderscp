# delivery-target

Reference for `apps/server/src/federation/delivery-target.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 16 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Is `dir` at or under one of `roots`?

Is `dir` at or under one of `roots`? The check is on RESOLVED path SEGMENTS, never a raw string prefix — so a sibling like `/root-evil` never matches the root `/root` (string-prefix would), and `/roots/../escape` is normalized before comparison. `roots` are already resolved by `parseDeliveryRoots`; `dir` is resolved here. Mirrors `resolveUnderDir`'s boundary test.

## §2. Is `endpoint`+`bucket` allowed by `allow`?

Is `endpoint`+`bucket` allowed by `allow`? Match requires the normalized ORIGINS to be EQUAL (never a string-prefix compare — so `https://minio.evil:9000` never matches an allowlisted `https://minio.ev:9000`, and a path suffix on the configured endpoint can't sneak past) AND the entry's bucket to be either unpinned (any bucket) or exactly `bucket`. An unparseable `endpoint`, or an empty allowlist, is never allowed (fail-closed).

## §3. One direction of the resolved view

One direction of the resolved view. `dir` is the resolved FILESYSTEM directory (or `null`); the s3 location, when the provider is `s3-compatible`, lives on the parent's `outboundS3`/`inboundS3` — this shape is DELIBERATELY unchanged from M13.2a (the filesystem suite asserts it exactly). A resolved direction has `problem === null`; an unresolved one has `dir === null` + a `problem` (the text the `require*` helpers refuse with).

## §4. S3 direction resolution (13.2b)

S3 direction resolution (13.2b). The endpoint/bucket is the SAME for both directions (the target carries one `endpoint`+`bucket`); only the per-direction prefix differs. The allowlist gap is therefore shared: an out-of-allowlist endpoint/bucket makes BOTH directions a fail-closed problem. There is NO env fallback for an s3 target — the whole target is s3 (the env dirs are filesystem). Returns the (dir-shaped) direction PLUS the resolved `s3` location (`null` on a gap) — the direction shape stays byte-identical to filesystem so consumers keyed on it are unchanged.
