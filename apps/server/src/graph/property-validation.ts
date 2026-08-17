import { createHash } from "node:crypto";
// Named import (not `import Ajv from "ajv"`) — ajv's CJS output + `moduleResolution: NodeNext`
// otherwise resolves the default import to the module namespace rather than the class, which
// TS then (correctly) refuses to `new` (a well-known ajv8/NodeNext interop gotcha).
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";

/**
 * Validates instance `properties` against a registered type's `property_schema` (JSON Schema)
 * at write time (DESIGN.md §4.1 "instance properties validated against the registered JSON
 * Schema (Ajv) at write time"). One Ajv instance, plus a compiled-validator cache — compiling is
 * the expensive part and schemas change only a few times a year.
 *
 * THE CACHE IS KEYED ON THE SCHEMA'S CONTENT, NOT ON THE TYPE'S IDENTITY. That is the whole
 * design, and it is a correctness property rather than a micro-optimisation, so it is worth
 * stating why the obvious alternative is wrong.
 *
 * This cache used to be keyed on `object_types.id` and paired with an exported
 * `invalidatePropertyValidatorCache(typeId)`. That function had ZERO callers for its entire life
 * — but wiring it up would not have fixed anything either, because the only thing that ever
 * mutates `object_types.property_schema` is a SQL migration, and migrations reach a running
 * deployment from a process that has no cache to invalidate:
 *
 *   - `main.ts` applies migrations at boot, before `app.listen` — this process's cache is empty
 *     at that moment, so there is nothing to invalidate and never was.
 *   - `migrate-bin.ts` is the real path (the Helm chart's `pre-upgrade` Job, and the Ansible
 *     rollout). It is a SEPARATE, SHORT-LIVED process that applies the `UPDATE`, exits, and by
 *     design leaves the already-running api/worker pods serving (`deploy/helm/templates/
 *     migrations-job.yaml`: "old-version pods keep serving ... for the whole rollout window").
 *     Those pods are where the stale validator lives, and a function call in the Job's heap
 *     cannot reach them. The chart defaults to 2 api + 2 worker replicas.
 *
 * So an in-process invalidation call is a no-op against the one path that matters, and the real
 * choice was between three cross-process designs:
 *
 *   (1) LISTEN/NOTIFY on `object_types` (the precedent exists — `events/outbox-relay.ts` LISTENs
 *       on `scp_outbox_insert`). Costs a trigger migration and a DEDICATED long-lived Postgres
 *       connection in every process, including the api pods, which hold no listener today. And it
 *       is still only eventually consistent: NOTIFY is asynchronous, so a request already in
 *       flight validates against the stale validator regardless.
 *   (2) A short TTL. No migration and no connection, but it is knowingly wrong for the length of
 *       the TTL, and it re-compiles every schema forever to defend against an event that happens
 *       a few times a year.
 *   (3) This: make the key the schema itself. The cached validator is then, by construction, the
 *       validator for the exact document the caller just read out of the database inside the
 *       current transaction. Staleness stops being a bug that must be corrected and becomes
 *       UNREPRESENTABLE — a changed schema is a different key.
 *
 * (3) wins on charter decision priority #1 (Simplicity) against both alternatives, and it is the
 * only one of the three that is correct with no window at all. It adds no required stateful
 * service, no connection and no background machinery, so charter principle 4 is untouched. It is
 * also correct on one process or fifty, api or worker, under compose, Helm, Ansible or an air-gap
 * bundle, because it coordinates nothing.
 *
 * It matters just as much that (3) deletes the install site rather than adding one. An
 * invalidation call is a step every future migration author has to remember, and the failure mode
 * when they forget is silent and green — which is precisely how the zero-caller invalidator
 * survived this long. There is now nothing to remember: every caller already goes through this
 * function, and this function cannot be given a schema and use a different one.
 *
 * The hash is a CONSERVATIVE key, which is the property that makes this safe. Different content
 * always yields a different key (so a stale hit is impossible); identical content normally yields
 * the same key, and if it ever did not — key ordering differing between two reads, say — the cost
 * is one redundant compile, never a wrong verdict. In practice Postgres normalises jsonb key
 * order, so a given stored document always stringifies identically. Two distinct types with
 * byte-identical schemas (`{"type":"object"}` is very common here) correctly share one validator.
 */
const CACHE_LIMIT = 256;

let ajv = new Ajv({ allErrors: true, strict: false });
let cache = new Map<string, ValidateFunction>();

function compiledValidator(schema: unknown): ValidateFunction {
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = cache.get(key);
  if (cached) return cached;

  // BOUNDED, and the Ajv instance is replaced rather than kept — not belt-and-braces. Ajv 8 keeps
  // its OWN `_cache: Map<AnySchema, SchemaEnv>` keyed on the schema OBJECT REFERENCE
  // (ajv/dist/core.js `_cache.get(schema)` / `_cache.set(sch.schema, sch)`). Every read of a jsonb
  // `property_schema` produces a fresh object, so each `compile()` adds an entry there that is
  // never reachable again. Clearing only the map below would therefore cap our memory and leak
  // Ajv's. Dropping both together is the only reset that actually resets.
  //
  // This is a backstop, not a working eviction policy: the whole estate has a few dozen registered
  // types, so the limit is not reached in any normal deployment. It exists because the previous
  // id-keyed cache was already unbounded along the same axis (`type_registry:write` mints new type
  // ids without limit) and nothing capped it.
  if (cache.size >= CACHE_LIMIT) {
    ajv = new Ajv({ allErrors: true, strict: false });
    cache = new Map();
  }

  const validate = ajv.compile(schema as object);
  cache.set(key, validate);
  return validate;
}

/**
 * Throws `badRequest` if `properties` does not satisfy `propertySchema`. A null/undefined schema
 * means "unconstrained" and validates everything.
 *
 * Deliberately takes NO cache key. The schema IS the key (see the module comment) — a caller
 * cannot pass a stale or mismatched one, because there is nothing to pass.
 */
export function validateProperties(propertySchema: unknown, properties: unknown): void {
  if (propertySchema === null || propertySchema === undefined) return;
  const validate = compiledValidator(propertySchema);
  const valid = validate(properties);
  if (!valid) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw badRequest(`properties failed JSON Schema validation: ${detail}`);
  }
}
