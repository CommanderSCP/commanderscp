# ADR-0050: The `scp-runner-ops` lockdown is a deletion allowlist, not a six-name blocklist

**Status:** Accepted (2026-09-22)
**Refines:** [ADR-0002](0002-execution-strategy.md) — the "Mode C / `scp-runner-ops` — SSTI/Jinja2 closure" precondition. This ADR does not weaken that precondition; it replaces its *mechanism* with a strictly stronger one and explains why the original mechanism could not hold.
**Relates to:** [PROJECT_CHARTER.md](../../PROJECT_CHARTER.md) "Managed Execution Exception" (2026-07-12 host-reaching amendment — the three enumerated classes this allowlist is derived from); [docs/proposals/managed-execution-tier.md](../proposals/managed-execution-tier.md) (the [BLOCKER] anti-RCE analysis); CLAUDE.md working conventions ("census by property, not by symptom")

## Context

ADR-0002 gates the `scp-runner-ops` build on a machine-checked SSTI/Jinja2 closure, and specifies
the mechanism as: *"dangerous lookups (`pipe/command/shell/raw/script/uri`) are disabled with a
lockdown `ansible.cfg` and a CI test asserting they fail closed inside the image."*

That enumeration was written from the shape of the threat, not from a census of the surface. Measured
against `ansible-core` 2.18.6 (`docker run --rm python:3.12-alpine`, listing
`ansible/modules/*.py`, `ansible/plugins/lookup/*.py` and `ansible/plugins/action/*.py`), the six
names cover a minority of the reachable code-execution paths:

**Lookups that execute a command, beyond `pipe`:**
- `lines` — runs a shell command and returns its output, line per line. Equivalent to `pipe` for
  RCE purposes, and absent from the ADR-0002 list.

**Modules that execute code, beyond `command`/`shell`/`raw`/`script`:**
- `expect` — spawns a command and drives it interactively.
- `pip` — installing a package runs its build/install hooks.
- `git`, `subversion` — fetch URLs and hook mechanisms reach code execution.
- `async_wrapper` — the asynchronous execution harness itself.

**Modules that turn tenant-controlled data into TASKS** — the most serious class, and entirely
unmentioned by the original list:
- `include_vars`, `include_role`, `include_tasks`, `import_role`, `import_tasks`, `import_playbook`
  — if any argument is tenant-influenced, the tenant chooses what code runs. This defeats "no shell
  module reachable" without touching a shell module.

**Lookups that read the filesystem or reach the network:** `file`, `env`, `ini`, `csvfile`,
`config`, `unvault`, `url`, `template`, `varnames`, `vars`. **Modules likewise:** `uri`, `get_url`,
`slurp`, `fetch`, `unarchive`.

The list was a list of symptoms. The property is: *anything that can execute code, load tasks from
data, or reach the network or filesystem outside the task's declared intent.* A blocklist over that
property is a commitment to re-enumerate it on every `ansible-core` bump, and to be wrong in the
interval — which for a security precondition is the wrong default.

## Decision

**1. The lockdown is an ALLOWLIST, derived from the charter's enumerated classes.** The image ships
only the modules and plugins the three host-reaching classes of the 2026-07-12 amendment require —
OS package install/upgrade/pin; config-file and template render+push; cron and systemd unit changes
— plus the minimum needed to run a play at all. Everything else is **deleted from the image**, not
disabled in configuration.

**2. Deletion, not configuration.** A lockdown `ansible.cfg` is kept as defence in depth, but it is
not the control. Configuration is overridable — `ANSIBLE_CONFIG`, a `./ansible.cfg` in the working
directory, and per-play settings all compete — whereas a plugin file that is not present in the
image cannot be loaded by any configuration a tenant can reach. The control must survive an attacker
who can influence the environment.

**3. The precondition's test becomes an inventory assertion, not a six-case spot check.** The
machine-checked gate asserts the **complete set** of modules, lookup plugins and action plugins
present in the built image equals the allowlist exactly — a set equality, in both directions. A new
`ansible-core` release that adds a code-execution module fails the gate on arrival rather than
silently widening the surface, and a removal that breaks a catalog role fails it too.

**4. Tenant parameters remain data-only, marked unsafe at the boundary.** Unchanged from ADR-0002 in
intent and restated here because it is the other half: a tenant value must never be evaluated as
Jinja2. That is enforced where the value enters the run, not by hoping no role templates it.

## Consequences

- **ADR-0002's precondition is satisfied by a strictly stronger mechanism**, so the gate it
  describes is met rather than waived. The six names it lists are all within the deleted set; the
  point of this ADR is that they were never the whole set.
- **The allowlist is derived from charter text**, so widening it is visible: adding a module because
  a role wants it is either within the three enumerated classes or it is a charter question, and the
  set-equality test forces that conversation instead of letting it happen in a Dockerfile diff.
- **`ansible-core` upgrades become deliberate.** The set-equality assertion turns every upstream
  addition into a review item. That is the intended cost — it is the same trade the vendored-backend
  pins make, and the alternative is an unreviewed surface change riding a patch bump.
- **Catalog roles are constrained by construction.** A role cannot use `command` even by mistake,
  because the module is absent — which also means the SSTI-fuzz gate (ADR-0002's third clause, built
  on top of this) is fuzzing roles that have no escape hatch to find.
- **This ADR does not by itself unblock the build.** SSH-CA discipline — blast-radius analysis, key
  custody commensurate with a fleet root of trust, short lifetimes, air-gap-workable rotation and
  revocation — remains an open precondition, and is a separate decision.
