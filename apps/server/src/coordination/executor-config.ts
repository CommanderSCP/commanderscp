/**
 * M3 has no plugin-instance configuration API yet — `@scp/plugin-api`'s manifest/config-schema
 * surfacing (DESIGN.md §11) is real, but nothing writes a *configured instance* of a plugin into
 * the graph as data yet (that lands once ExecutorPlugin config becomes a registry object,
 * alongside GitHub/ArgoCD/Terraform in M7). Every wave target in M3 is therefore triggered
 * through exactly ONE hardcoded fake-executor plugin-host instance, shared across every org —
 * sufficient to prove the plan/wave/rollback/plugin-host machinery end to end against the fake
 * executor (this milestone's explicit charter: "proven against the fake executor"), and a
 * documented, isolated simplification rather than a silent one. `orgId`/`domainId` on the
 * instance itself are therefore placeholders ("shared") rather than a real tenant — fine because
 * the fake executor never reads them (state is keyed purely by `TriggerIntent.targetRef`).
 */
export const DEFAULT_EXECUTOR_INSTANCE_ID = "fake-executor";
export const DEFAULT_EXECUTOR_MODULE = "fake-executor" as const;
export const SHARED_PLUGIN_INSTANCE_ORG_ID = "shared";
export const SHARED_PLUGIN_INSTANCE_DOMAIN_ID = "shared";
