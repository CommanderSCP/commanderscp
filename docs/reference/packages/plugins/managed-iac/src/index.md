# index

Reference for `packages/plugins/managed-iac/src/index.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 21 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. WHAT THIS FILE COMPOSES

WHAT THIS FILE COMPOSES — a `detail` that is a plain `string` (MEDIUM, M23.0 verification pass 7 finding M3). `RunOutcome.detail` is still `BoundedDetail`, so no READER of the ledger can be handed a megabyte; what changed is WHERE the conversion happens. A brand on a FIELD forces one at every literal that constructs the record, which is how one concept came to have 26 manual call sites across four packages — most of them, on a delete-the-wiring sweep, pinned by no failing test. Three sites of one concept means the boundary is wrong; the answer is not 23 more tests.

## §2. THE LAUNCHER SEAM

THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter selection is not tenant-facing, and adding a config field would mean adding it to the server-injected/never-tenant-settable class in all three enforcement layers for no behaviour a caller can yet ask for. Tests pass a substitute here, which is what makes "the plugin really goes through the port" falsifiable rather than a claim about the source text.

## §3. BOUNDED AT BOTH ENDS

BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND unbound the plugin-host RPC budget derived from it. Enforced at every write door by `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows stored before the ceiling existed.
