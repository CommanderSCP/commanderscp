/**
 * ABSENT — `null` OR `undefined`, never one of the two.
 *
 * THE BUG THIS EXISTS TO MAKE UNREPEATABLE. Almost every federated reading in this app is
 * `.nullable()` and very often `.optional()` too (`packages/schemas/src/federation.ts`), so BOTH
 * absent values are legal on the wire — and the generated SDK does NO runtime response validation
 * (it returns `response.json()` under a TypeScript type), so a key an older or newer server simply
 * OMITS arrives as `undefined` whatever its schema says. `.nullable()` without `.optional()` buys
 * nothing here: the type says the key is always present, and nothing at runtime enforces it.
 *
 * A strict `=== null` check therefore guards ONE of two legal absences and lets the other reach the
 * renderer, where an absent NUMBER prints as an empty string inside otherwise-confident copy
 * (`"⟨nothing⟩ of this domain's own journal entries not yet put on the wire"` reads as "nothing
 * pending") or, worse, falls through to a reassuring branch that states a fact nobody measured.
 *
 * LIVES IN `lib/` ON PURPOSE (M16.2 phase B, round 3). It was previously a local helper in
 * `routes/outposts.tsx`, which meant every OTHER route re-derived the same guard by hand and the
 * half-guarded `=== null` form kept reappearing — three fresh instances in one review round. One
 * import, one rule.
 */
export function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
