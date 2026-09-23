# ADR-0052: For host-reaching runs, server-derived material wins over an authored recipe

**Status:** Accepted (2026-09-22)
**Relates to:** [ADR-0050](0050-runner-ops-lockdown-is-an-allowlist.md) and [ADR-0051](0051-ssh-credential-authority-and-ca-custody.md) (the other two `scp-runner-ops` decisions); BUILD_AND_TEST.md §8 M27.6 (server-compiled inventory, per-run egress allowlist); PROJECT_CHARTER.md "Managed Execution Exception" 2026-07-12 amendment

## Context

`reconcile.ts` merges two sources of trigger `parameters` and states the rule plainly:

> The RECIPE WINS on a key collision, deliberately: a recipe is an operator's explicit instruction
> for this campaign, and silently overriding it with a derived value would make the authored
> document a lie.

That reasoning is sound for the build lane, where the derived values are conveniences — a repo, a
commit, a destination — and an operator who writes one by hand means it.

It does not hold for **host-reaching** runs. There the derived values are not conveniences; they
are the bound:

- the **inventory** is compiled from observed membership, and D25(a)'s whole point is that *which
  hosts* is derived rather than authored;
- the **egress allowlist** is the set of addresses the run may reach at all, enforced as a
  NetworkPolicy;
- the **certificate** names the principals and the validity window.

Under recipe-wins, an authored `parameters` key could replace any of them. The failure is not
theoretical: a recipe naming its own host list would produce a run against machines the server
never resolved, with a NetworkPolicy computed from a different set — or, if the allowlist key were
the one overridden, a run reaching addresses nobody authorized.

`params_to_vars.py` (M27.2) does not help here. It stops a parameter being *evaluated* as Jinja2;
it has nothing to say about a parameter being *honoured*.

## Decision

**For host-reaching classes, server-derived run material overrides any recipe key of the same
name — the inverse of the build lane's rule — and the server-derived keys are a closed, named
set.**

Concretely: the merge for a host-reaching trigger is `{...recipeParameters, ...serverDerived}`,
not the build lane's `{...serverDerived, ...recipeParameters}`. A recipe may still supply anything
*outside* that closed set, so authoring a catalog role's own arguments stays fully available — the
inversion is scoped to the keys that constitute the bound, not to parameters generally.

**The closed set is enumerated in one place** and asserted by test, so a future key that belongs to
the bound cannot be added to the derivation while quietly remaining overridable.

## Consequences

- **The authored document is no longer the last word for these keys, and that is the point.** The
  build lane's reasoning — "silently overriding it would make the authored document a lie" — is
  answered directly: for host-reaching runs a recipe that names hosts or reach is not an
  instruction SCP can honour, so it is refused rather than silently overridden. A recipe carrying
  a reserved key fails loudly, which keeps the document honest in the only way that is safe.
- **Two lanes now merge in opposite directions**, which is a real cost: a reader of `reconcile.ts`
  must know which lane they are in. It is accepted because the alternative is one rule that is
  wrong for one of them, and the wrong half is the half holding a host credential.
- **This is a bound on SCP's own coordination, not on a tenant.** Campaign recipes are
  operator-authored; the decision is not that operators are untrusted, but that the reach of a
  host-reaching run must be a property of resolved graph state rather than of a document — so that
  it can be reasoned about, and so that an accident in a recipe cannot widen it.
- The rule applies to the `managed-ops` class only. Every existing lane keeps recipe-wins, and
  nothing about the build lane changes.
