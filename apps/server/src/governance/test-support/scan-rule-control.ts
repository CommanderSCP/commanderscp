/**
 * TEST SUPPORT for M22.8's authoring refusal (`governance/scan-rule-authoring-guard.ts`).
 *
 * A `scanThreshold` or `scanExclusion.exclude` policy must now name, IN ITS OWN DOCUMENT, a control
 * bound to a scan-verdict plugin — because a scan rule that requires no scan is silently inert
 * (`prewarmGovernanceForChange` reaches the six-tier resolution only inside
 * `if (allControlIds.length > 0)`, and with no scan required there is no verdict to constrain).
 *
 * Every M22 suite authored its ceilings and clauses as bare effect documents, which is exactly the
 * shape the guard refuses. This constant is what those suites name instead.
 *
 * ============================================================================================
 * WHY A DANGLING REFERENCE RATHER THAN A REAL BOUND CONTROL — measured, not preferred
 * ============================================================================================
 * The first attempt had each suite's policy helper find-or-create a REAL control bound to
 * `scan-result-control`. It failed two tests, and both failures are the reason this file exists:
 *
 *  1. `scan-exclusions` asserts a change holds EXACTLY ONE `control_runs` row. A second scan control
 *     — created because the ceiling policy is authored BEFORE the suite creates its own control —
 *     produces a second run, and the assertion is about the M22.0a cache key, not about controls.
 *  2. `scoped-scan-requirements` (b) began failing its accept edge, because a second bound control
 *     genuinely runs and genuinely participates in the gate.
 *
 * In other words: attaching a real control to make an unrelated test's POLICY legal changes what
 * that test measures. A dangling reference does not. `ensureControlRun` refuses a non-uuid
 * `requireControls` entry BEFORE it touches the database and writes NO `control_runs` row for it, so
 * naming this adds no run, no plugin call and no control object; and every helper that names it
 * authors at `advisory` enforcement, which can never block a gate.
 *
 * The guard reads an unresolvable entry as "cannot be PROVEN inert" and passes — its documented
 * sign, and the same one an unbound control gets. That is a REAL branch of the guard, not a
 * loophole: `scan-rule-authoring-guard.integration.test.ts` G5 pins it deliberately, and G3/G4 pin
 * the bound-control branches against genuinely bound controls.
 *
 * This is also the form `group-scope-ownership.integration.test.ts` already used for its
 * `requireControls` effects before M22.8 existed, so it is the established shape for a suite that
 * exercises resolution rather than execution.
 */
export const SCAN_RULE_TEST_CONTROL_REF = "security-scan";
