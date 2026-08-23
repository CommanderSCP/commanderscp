import { defineConfig } from "vitest/config";

/**
 * THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).
 *
 * This package arrived on a branch that forked before the budget census existed, so it shipped
 * with no config at all and ran on vitest's implicit 5,000ms default — the exact omission the
 * census exists to catch, reintroduced by a merge rather than by an edit. That is worth noting:
 * a gate over "every package" is only as complete as the set of packages at the moment it runs,
 * and a branch merged in afterwards is a package the gate never saw.
 *
 * 20,000ms, matching every sibling that does not need 30,000. See the census table in
 * `@scp/source-census`'s `test-budget-census.test.ts` for why the number is declared and not
 * inherited.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000
  }
});
