# ADR 0003 — Internal-egress for execution systems: a two-layer (operator ceiling + declared intent) model

**Status:** Accepted (owner decision, 2026-07-15)
**Relates to:** [ADR-0002](0002-execution-strategy.md) (Mode A / BYO-coordinate), the plugin SSRF egress guard (`apps/server/src/plugin-host/egress-guard.ts`, adversarial-review MAJOR #6), [charter principle 5](../../PROJECT_CHARTER.md) (air-gap & self-hosting first-class), [import-existing-executors proposal](../proposals/import-existing-executors.md).

## Context

The plugin egress guard (`egress-guard.ts`) resolves DNS and then blocks any target in a loopback (127/8, ::1) or private range (10/8, 172.16/12, 192.168/16, 100.64/10 CGNAT, fc00::/7); link-local/cloud-metadata (169.254/16, fe80::/10) and the unspecified address are blocked for everyone, always. The loopback/private block lifts only when `allowInternalPrivate` is true, which was derived **solely from module identity** (`OPERATOR_PLANE_MODULES = {webhook-control, federation-https}`). Every tenant-configurable module — github, argocd, argocd-discovery, terraform, managed-iac, webhook-notify — got `false`.

That is correct for cloud multi-tenant, and it makes Mode A coordination of a **self-hosted / in-cluster** execution system impossible: an in-cluster Argo CD is a private ClusterIP. Found live on the homelab (2026-07-13): `argocd-discovery` pointed at `argocd-server.argocd.svc.cluster.local` (10.43.254.143) was refused. Everything else worked — the `execution-system` object, the k8s egress NetworkPolicy, DNS/TCP reachability, the worker executing the plugin. The guard was the only wall. A Tailscale URL doesn't help (100.64/10 is also "private"); only a genuinely public address passes. So the design implicitly assumed execution systems live at public addresses — untrue for the most common self-hosted case, and in direct tension with charter principle 5.

## The rejected first attempt (recorded deliberately)

The first cut added an `allowInternalEgress` property to the `execution-system` object and trusted it because "creating an execution-system is already a privileged coordination-admin act."

**That premise was false, and an adversarial review caught it before merge.** `execution-system` is in neither `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` (`{policy, control}`) nor `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS` (`{campaign}`); it falls through to plain `object:write` — the same permission needed to register an ordinary component — and its `property_schema` is the unconstrained `{"type":"object"}`. Any tenant could mint their own execution-system with `allowInternalEgress: true` and an attacker-chosen `serverUrl`, bind a component to it, and trigger → SSRF. A second, worse path: `POST /discovery/run` needs only `object:read`, and the handler passed the request's `config` **verbatim**, so the attacker's own `serverUrl` rode along with the flag — the grant on system X authorized egress to *any* address in the same request.

Attempts to repair it by gating writes were then scoped against the real code and found wanting:

- **Gate the property at every write path** — 8 separate write surfaces, one of which (federation import) has *no RBAC subject* to authorize against; nothing in the type system or lint forces a future write path to call the helper; and this exact class of fix has already been missed once in this codebase (which is *why* `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` exists).
- **Make the type governance-managed** — mechanically sound (both the generic-endpoint and IaC bypasses key off that one Set), but it makes registering *any* executor a `policy:write` act, breaks the generic registration path, and conflates executor registration with governance-document authoring.

The lesson: **any design whose security rests on "who may write this graph property" inherits every write path, forever.**

## Decision

Split the security boundary from the intent. Internal egress requires **both** layers to agree; `resolveInternalEgress` (`coordination/executor-bindings-repo.ts`) is the single function that answers, used identically by the binding path and the discovery path.

**Layer 1 — `SCP_INTERNAL_EGRESS_HOSTS` (host-level operator env). The hard boundary.**
A comma-separated allowlist of hostnames (not URLs, not CIDRs) that a plugin may reach even when they resolve to loopback/private, e.g. `argocd-server.argocd.svc.cluster.local`. Unset (default) ⇒ no plugin ever reaches an internal address; the pre-existing posture is unchanged. Same trust tier as `SCP_MANAGED_IAC_RUNNER_IMAGE` and `SCP_FEDERATION_MTLS_*` — operator-configured, never tenant-suppliable, deliberately *outside* the graph so it cannot depend on graph/RBAC state being right.

**Layer 2 — `execution-system.allowInternalEgress` (graph property). Declared intent.**
Set at registration (`scp connect argocd --allow-internal-egress`). Visible, auditable, policy-governable graph state (charter principle 6). It is a **declaration, not a grant**.

**Plus (independent, required regardless): the allowance is pinned to the system's own address.** Both paths server-govern `serverUrl`/`tokenSecretKey` from the persisted object — overriding anything the caller sent — and derive `allowedHosts` from that system's own host. This is the existing "tenant config first, server-governed fields LAST (they win — CRITICAL #1 / MAJOR #4)" discipline, which the first discovery implementation violated.

Threading is unchanged in shape: `PluginHostInstanceConfig.allowInternalEgress` → its own env var `SCP_PLUGIN_ALLOW_INTERNAL_EGRESS` (never `SCP_PLUGIN_CONFIG_JSON`) → OR'd into `subprocess-entry.ts`'s `allowInternalPrivate`. The guard itself is untouched.

## Why this is safe

- **The property is no longer security-critical.** A tenant who declares `allowInternalEgress: true` on a system pointing at an un-allowlisted host gets nothing. So it needs no gate, no new permission, and none of the 8 write paths — the entire question dissolves rather than being answered.
- **Fail-closed by construction.** Every edge returns `false`: not declared, unparseable `serverUrl`, host not allowlisted, env unset, or a code path that simply forgets to compute it. Missing a spot means "doesn't work," never "silently exploitable" — the opposite of the write-gate approach's failure mode.
- **An RBAC misconfiguration cannot become an SSRF.** Security no longer depends on the author's judgment about who can write what.
- **Metadata endpoints stay unreachable for everyone** (`linkLocal`/`unspecified` are unconditional in the guard).
- **Per-host, not per-range.** You allowlist one hostname, not `10/8`; combined with the address pinning, a system can only ever reach its own registered host.

### What this does NOT do (a limit, stated plainly)

**The ceiling is deployment-wide, not per-org or per-system.** `SCP_INTERNAL_EGRESS_HOSTS` is a bare hostname set with no binding to an org, domain, actor, or execution-system id. So once an operator allowlists `argocd-server.argocd.svc.cluster.local` for one team, **any** principal in that deployment who can register an execution-system pointing at that same hostname inherits the same network reach — they do not get anyone else's token (secrets are resolved from the system they reference, and reaching a host is not authenticating to it), but they can cause SCP to send requests to it, including unauthenticated endpoints like Argo CD's `/api/version`.

This is deliberate and it mirrors the layer it pairs with: a k8s NetworkPolicy is also all-or-nothing per pod — once the pod may reach Argo CD, any code in the pod may. Claiming otherwise would be false precision. **An earlier draft of this ADR asserted "neither can escalate past the other"; that was too strong and is retracted.** The accurate statement: the ceiling bounds what the *deployment* can reach; the declaration + address pinning bound which *system* reaches what; RBAC bounds who may register. None of them isolates one tenant's allowlisted host from another tenant in the same deployment.

Consequences for operators: do not allowlist a host that some tenant of that deployment must not reach. On a shared multi-org install (DESIGN §4.2 treats multi-org as the non-degenerate default) this matters; in the commander/outpost topology it largely does not, because an outpost is per-environment and its ceiling names that environment's own executor. If per-org ceilings are ever needed, that is a follow-up — and it must stay outside the graph to preserve the fail-closed property.

## Individual vs. corporate posture (owner requirement, 2026-07-15)

Both audiences are served without new RBAC levels, because role bindings are already scopable to **any** graph object (DESIGN §7, `role_bindings.scope_object_id`):

- **Individual / small group — full privileges out of the box.** The first user is Owner at org scope; the Helm chart sets `SCP_INTERNAL_EGRESS_HOSTS` from the same values file that declares `networkPolicy.executorEgress`. `scp connect argocd --allow-internal-egress` just works; no permission setup.
- **Corporate — layered.** The platform team owns the ceiling (a narrow allowlist, via GitOps, alongside the NetworkPolicy it pairs with). Registration is delegated with existing scoped bindings — top-level admin (org), service-level admin (service), component-admin (component), compliance (`policy:write` @ org). Whoever owns the network boundary controls the ceiling; whoever owns the service controls registration. Note the honest limit in "What this does NOT do" above: the ceiling is deployment-wide, so it bounds the deployment rather than isolating tenants from each other's allowlisted hosts.

## Alternatives considered

1. **Property alone, trusted as "operator-provenance."** Factually wrong (see above). Rejected.
2. **Property + gate every write path.** 8 surfaces, no enforcement mechanism, federation-import has no subject, historically missed. Rejected.
3. **Governance-managed type (`policy:write`).** Mechanically strong but breaks generic registration, and makes registering a public GitHub executor a governance act. Rejected on posture.
4. **Add argocd/argocd-discovery to `OPERATOR_PLANE_MODULES`.** Grants internal egress to an entire module class regardless of intent. Rejected.
5. **Env allowlist alone (no property).** Nearly chosen; the property is retained because it makes the grant visible/auditable graph state (principle 6) and costs nothing now that it isn't a security boundary.

## Consequences

- Self-hosted/air-gapped operators coordinate in-cluster execution systems by allowlisting the host at the deployment and declaring intent per system. Public-address executors need neither (default stays deny).
- The k8s NetworkPolicy (`networkPolicy.executorEgress`) and this allowlist are both deployment-level network decisions and should be configured together in the chart values.
- The allowance is deployment config rather than purely graph state — a deliberate trade: "what this pod's network may reach" is an infra decision, exactly like the NetworkPolicy it pairs with. Surfacing it read-only (e.g. `scp doctor`) is a possible follow-up.
- `execution-system`'s `property_schema` remains `{"type":"object"}`. Tightening it is now ordinary hygiene rather than a security fix, and is tracked separately.
- Split-topology note surfaced alongside this work: `POST /discovery/run` runs the plugin in-process and needs a worker-capable process (`SCP_ROLE=all|worker`); an api-only deployment behind the ingress rejects it. Tracked separately (discovery should dispatch to the worker).
