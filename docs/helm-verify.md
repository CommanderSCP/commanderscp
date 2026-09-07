# helm-verify

Long-form reference for the **helm-verify** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 53 of 53 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`tools/helm-verify/src/verify.ts`](#tools-helm-verify-src-verify-ts) — §1–§53

## `tools/helm-verify/src/verify.ts`

### §1. The helm template assertions gate

@scp/helm-verify — the "helm template assertions" gate BUILD_AND_TEST.md §8 M8's DoD calls for: "Helm hardened defaults must actually apply (non-root/read-only-rootfs/dropped-caps/ NetworkPolicy present in rendered manifests — test via `helm template` assertions)."

Renders `deploy/helm` with several representative value sets (bare defaults, and a "kitchen sink" with every optional feature toggled on — managed-iac, federation mTLS, ingress, serviceMonitor, NATS event bus, OIDC, worker HPA) and asserts STRUCTURALLY on the parsed YAML — not string-grepping the raw template output, which can't tell "the field is present on the container that matters" from "the string appears somewhere in the file". A loosened default in `values.yaml` fails THIS script, not just a human reviewer's eyeball pass.

Run: `pnpm --filter @scp/helm-verify verify` (from repo root) or `tsx src/verify.ts` from this directory. Requires `helm` on PATH (BUILD_AND_TEST.md §1: Helm 3.16+) — no live cluster needed, this is pure `helm template` (offline rendering).

WHAT A MISSING `helm` MEANS is selected by SCP_HELM_VERIFY (see main()'s own comment for the three modes and their reasons). Unset — developer machines, `pnpm test` locally — it PROBES: runs when helm is on PATH, skips (does not fail) when not, because a hard ENOENT would fail the unit-test stage for a tool-availability gap, not a real regression. The assertions are a REAL gate regardless: `.github/workflows/ci.yml`'s dedicated `helm-verify` job (4b) installs Helm ITSELF (`azure/setup-helm@v4`) — not trusting the runner image — and runs this exact script with SCP_HELM_VERIFY=require, so there a missing helm FAILS instead of skipping and a loosened `values.yaml` genuinely reds CI on any runner. CI's unit-test job (4) sets SCP_HELM_VERIFY=skip: its runner happens to pre-install helm, and probing there ran the identical assertions a second time with a result that depended on GitHub's runner-image contents. (Historical note: that probe's skip branch was ALWAYS taken back when the unit-test stage ran on the Node-only homelab runner; it began genuinely executing when CI moved to `ubuntu-latest` — a bonus, never the guarantee, and now deliberately off there.) Locally, any dev with Helm on PATH still gets the real check for free via `pnpm test`.

### §2. M15.4 — federation-role bundled-backend guardrail

M15.4 — federation-role bundled-backend guardrail (a CHART-RENDER-TIME SELF-CONSISTENCY LINT).

HONEST SCOPE: this is a `helm template`-time misconfiguration guardrail, NOT SCP runtime governance/authority. The OPERATOR sets BOTH `federationRole` AND the `bundledExecutor.*.enabled` flags at install time; this lint pairs those two install-time values and fails the render-check when a role enables a bundled backend it should not run. It is deliberately NOT wired to runtime enforcement: the runtime `self_domain.role` (apps/server/src/federation/self-repo.ts) is ADVISORY metadata set post-install via the federation API, with no bearing on a Helm install-time value and no graph representation of bundled-backend enablement — so runtime enforcement here would fork the engine. This tooling-only lint is the owner-chosen alternative (M15.4; ADR-0012 §M15.4 note).

Each bundled backend ⇒ its own namespace; presence of resources in that namespace in the render is how we detect "this backend is actually enabled" (robust: asserts on what WOULD deploy, not on the --set flags we happened to pass).

### §3. Allowed bundled backends per federation role. DOC SOURCE

Allowed bundled backends per federation role. DOC SOURCE: ADR-0012 (outposts run Gitea as the self-contained registry/git + the deploy engine; commander runs the full Standard Stack) + the poke/retrans federation model (a `retrans` node is a validate-and-relay CDS-boundary relay — NOT an execution site, so it bundles NOTHING) + the M15.4 milestone note in BUILD_AND_TEST.md §8. Conservative where the docs are silent (outpost restricted to gitea + argocd; the build/event backends — argoWorkflows/argoEvents — are commander-only) — the assumption is documented in the M15.4 milestone note. If a future decision widens a role, widen this table (the single source of truth) and the milestone note together.

### §4. The runner role, diffed against what the adapter issues

M23.6 CLAUSE 5 — THE RUNNER ROLE, DIFFED AGAINST WHAT THE ADAPTER ACTUALLY ISSUES, BOTH WAYS

The clause is "the chart grants exactly what the adapter calls, and no more". The gate that stood here before could only ever catch the FIRST half: `batch/jobs` was checked with `JSON.stringify(rules).includes('"patch"')`, `pods`/`pods/log` were checked NOWHERE AT ALL, and only `events` and `secrets` had a set-equality. Measured against that gate: four unused verbs added to `runner-iac.yaml` (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`) left this script green, `pnpm -w test` green and the kind suite green. A privilege that can only drift wider is the direction that matters.

THE EXPECTED SET IS NOT WRITTEN HERE. It is `kubernetesRunnerRbac()` in `@scp/runner-launcher`, which `kubernetes-rbac-contract.test.ts` holds to the adapter by DRIVING every route over a recording io and deriving the verbs from the wire. A second hand-maintained copy in this file would be free to agree with the chart and disagree with the code, which is the failure mode this whole clause is about.

ONE RULE PER (apiGroup, resource) IS PART OF THE CONTRACT, not a convenience for the comparison. A rule listing two resources gives each of them every verb in the list — that is how `pods` came to hold `get` and `pods/log` to hold `list`, neither of which the adapter ever issues — so a render that splits or merges rules differently must fail here rather than be normalised away.

### §5. That diff is real and fires both ways, but covers one

`rbacDiff` above is real and fires in both directions, but it is true of ONE Role. The clause is "the chart grants exactly what the adapter calls, and no more", and that is a statement about the CHART. The gap is not theoretical: the M23.6 verification pass pointed a real authorizer at the harness identity and got `delete nodes: yes` — a question no assertion in this repository had ever asked, because every RBAC assertion it had was aimed at `-runner-iac`'s `rules` array. A diff can only speak for the object it is handed; everything the chart renders BESIDE that object was ungated.

SO THIS FUNCTION TAKES A WHOLE RENDER AND ANSWERS: WHICH IDENTITY ENDS UP HOLDING WHICH RULES. It resolves every RoleBinding's `roleRef` against every rendered Role, accumulates the union per ServiceAccount subject, and compares each identity's TOTAL grant — not one rule of it — against a pinned expectation. Three identities exist in this chart and all three are named here, so a FOURTH is a failure by construction rather than something a reader has to notice:

```text
- THE WORKLOAD ServiceAccount (the one the api/worker pods run as, and therefore the one the
  Kubernetes adapter's every call authenticates as): exactly `kubernetesRunnerRbac()`, which is
  the set `kubernetes-rbac-contract.test.ts` derives from the wire by driving the adapter. Or
  NOTHING AT ALL, on every render where no managed run can launch.
- THE TWO AUTOWIRE ServiceAccounts (`-argocd-autowire`, `-gitea-autowire`): `get` on `secrets`,
  in the bundled backend's own namespace. These are install-time hooks that read one generated
  admin secret and mint a scoped API token; their Roles live in a DIFFERENT namespace from
  everything else the chart grants, which is precisely why "the runner Role is correct" never
  said anything about them.
```

AND FOUR STRUCTURAL REFUSALS THAT DO NOT DEPEND ON KNOWING THE EXPECTED SET: 1. NO ClusterRole AND NO ClusterRoleBinding, EVER. Every grant this chart makes is namespaced. `delete nodes` is a cluster-scoped question and this is the assertion that makes the answer structurally "no" — including for the value combinations no matrix enumerates, since the source census at the end of `verifySocketInvariantMatrix` covers the templates as text. 2. NO WILDCARD in `apiGroups`, `resources` or `verbs`. A `*` passes any set-equality that is written as a `.includes`, and grants everything the day a new resource appears. 3. NO `escalate`, `bind` OR `impersonate`. Those three are how a bounded grant becomes an unbounded one without the grant itself changing. 4. EVERY Role IS BOUND AND EVERY BINDING RESOLVES. A Role nothing references authorises nobody (ADR-0035 §6a's exact starting failure, generalised from the one case that was checked), and a RoleBinding whose `roleRef` names a Role this render does not contain is a grant that silently does nothing — or, worse, picks up a same-named Role that is already in the cluster.

### §6. The identity the api and worker pods run as

The identity the api/worker pods run as — the one the Kubernetes adapter's every call authenticates as, and therefore the subject of "the chart grants exactly what the adapter calls".

READ FROM THE DEPLOYMENTS' POD SPECS, for two reasons. `serviceAccount.create=false` renders no ServiceAccount object at all while the pods still authenticate as something, so the object is the wrong place to look. And the chart's install-time HOOKS (the two bundled-backend autowire Jobs) deliberately run as their own identities; folding those in here would make this return three names and say nothing about any of them.

### §7. The invariant this milestone must not break, in its words

THE INVARIANT M23 MUST NOT BREAK, in BUILD_AND_TEST.md's own words: "**no Docker socket is mounted into any pod, ever** — not behind a value, not behind a `managedIac.enabled` opt-in, not 'for dev'." The escape risk `runner-iac.yaml`'s module header refuses to paper over is the reason M23 exists at all; a socket mount would satisfy the goal while destroying the reason.

WHAT STOOD FOR THIS BEFORE, AND WHY IT WAS NOT A GATE. Nothing rendered the chart and looked. A filterless `grep -rna 'docker.sock\\|/var/run/docker'` over the repo found ZERO assertions over rendered chart output — every `docker.sock` assertion in the tree was on Docker ARGV, which is a statement about the compose path and says nothing about a pod. Measured, before this section existed: a `hostPath: /var/run/docker.sock` volume plus its mount added to `deployment-worker.yaml` produced FOUR `docker.sock` occurrences in `helm template` AT THE DEFAULT VALUES while `pnpm -w test` stayed green (72/72) and helm-verify stayed green.

A HANDFUL OF HAND-PICKED COMBINATIONS IS NOT A MATRIX. The 31 `renderChart` calls elsewhere in this file are each aimed at one question; none of them is a sweep, and the combination that carries a socket is by definition the one nobody thought to name. The product below is EXHAUSTIVE over the dimensions the clause names — every `managed*` enablement combination and every documented `managedRunners` override — and the count is printed so "exhaustive" is a number rather than a claim.

AND THE HALF `helm template` STRUCTURALLY CANNOT SEE. The runner pod is not in the chart: it is built by `jobManifest()` in `packages/runner-launcher` at RUN time, from the settings the chart delivers as environment variables. So for every Kubernetes render this section ALSO reads the worker's own env out of the render, derives the launcher settings exactly as `managedRunnerKubernetesSettings()` does, builds the Job manifest those values produce, and holds it to the same invariant. The chart cannot render a socket, and it cannot ASK for one either.

### §8. Every reason a rendered manifest violates the invariant

Every reason a rendered manifest violates the invariant. Two independent instruments, because each catches what the other cannot: a STRUCTURAL walk that knows which field is a volume (so it can name `hostPath` even when the path is innocuous), and a RAW scan of the bytes (so a socket hidden in a ConfigMap, an annotation or an unmodelled field cannot slip past the walk).

### §9. The runner Job THIS RENDER WOULD PRODUCE

The runner Job THIS RENDER WOULD PRODUCE. Mirrors `managedRunnerKubernetesSettings()` in `apps/server/src/coordination/executor-bindings-repo.ts` — claim first, host path second, nothing third — so a chart that started plumbing `SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH` (today it does not, and that absence is itself asserted) would be caught here rather than at run time.

### §10. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED. Whether a managed run can actually launch at this point — i.e. whether the workload ServiceAccount is supposed to hold the runner grant AT ALL — and, if so, whether the per-run Secret capability is on. DERIVED FROM THE POINT'S OWN VALUES, never read back out of the render: an expectation computed from the thing being checked agrees with it by construction.

### §11. The exhaustive product

The exhaustive product. Dimensions, and why each one is in it: - the three managed classes, independently on/off (8) — the clause names them by wildcard, and each one gates a different block of `runner-iac.yaml` and of the worker's env. - the launcher (2) — `docker` and `kubernetes` render different pods and different volumes. - `managedRunners.kubernetes.namespace` empty vs a runner namespace (2) — moves the Role, the RoleBinding and the Jobs, and is the M23.5 render-time guard's own input. - `perRunSecrets` (2) — renders or omits a rule and flips a server-side flag. - `acceptSharedNamespaceSecretDelete` (2) — the documented override for the guard above; the combination it exists to unblock is asserted to REFUSE without it. - `runAsNonRoot` (2) — the only value that changes the runner pod's securityContext. Run twice: once with the rest of the chart at defaults, once with every other optional feature on (the existing kitchen sink plus `api.role=all`, which is the single-pod install where the worker's volumes land on the api pod too). Plus one small sweep over `api.role`, whose three values decide which pods exist at all.

### §12. The two environments are not symmetric, and that shapes it

THE TWO ENVIRONMENTS ARE NOT SYMMETRIC, AND THE ASYMMETRY IS THE FACTORING RATHER THAN A CORNER CUT. `defaults` carries the FULL `managedRunners` product, because those are the values the clause names and the ones that gate the runner templates. `everything-on` exists to answer a different question — "does any OTHER chart feature introduce a socket" — and no other feature reads a `managedRunners.kubernetes.*` value, so crossing it with the full product would multiply renders without multiplying coverage. It is crossed with every class combination and both launchers, which is what decides which pods exist.

THE COST IS REAL AND IS WHY THIS IS WRITTEN DOWN. Each point is one `helm` process. At 276 points this task starved the rest of `turbo run test`: `@scp/plugin-managed-scan`'s `scanner-containment` test, 390ms in isolation, timed out at 49,061ms once in three runs. The `fullProduct` flag is the lever that keeps the sweep exhaustive where exhaustiveness is the claim and bounded where it is not.

### §13. THE BUNDLED BACKENDS' OWN IDENTITIES

THE BUNDLED BACKENDS' OWN IDENTITIES (M23.6 clause 5, widened). `bundledExecutor.*.enabled` is not a dimension of the socket product — no bundled backend can introduce a runtime socket into an SCP pod — but each one renders a ServiceAccount, a Role and a RoleBinding IN THE BACKEND'S NAMESPACE, which is a grant this chart makes to an identity outside everything the runner Role gate ever looked at. They are swept here so `chartGrantProblems` sees them: both alone and together, and crossed with the Kubernetes launcher so the runner grant and the hook grants are checked in one render rather than in two that never meet.

### §14. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED — THE WHOLE CHART'S GRANT, ON THE RENDERS THIS LOOP ALREADY HAS.

Sharing this loop is a deliberate cost decision, not a tidiness one. Each point is one `helm` process and this sweep already starved `turbo run test` once at 276 points (see `socketMatrix`'s own note); a second exhaustive sweep for RBAC would have doubled that for renders byte-identical to these. So the two invariants are asked of one render each, and the function above is pure so it can also be pointed at any other render.

### §15. The census covering combinations no matrix can enumerate

AND THE CENSUS THAT COVERS THE COMBINATIONS NO MATRIX CAN ENUMERATE. A sweep proves the points it visits; a string that appears in NO template of the chart cannot appear in ANY render of it, for every value assignment including the ones nobody has thought of yet. So the two instruments are complementary rather than redundant: this one is total over literal paths, the matrix is what catches a path a VALUE supplies.

`hostPath` IS ASSERTED ABSENT FROM THE TEMPLATES AS WELL AS FROM THE RENDERS. This chart declares no hostPath volume anywhere and has no value that could produce one — the runner workspace is an RWX PersistentVolumeClaim and nothing else. `packages/runner-launcher` DOES support `{ kind: "hostPath" }` (the kind harness uses it, and `kubernetes-launch.golden.test.ts` pins that shape), reached only through `SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH` — an environment variable this chart does not set, which is asserted below by name rather than left as an observation.

SCOPE, STATED RATHER THAN IMPLIED: `deploy/helm` — the chart `helm install` applies. The bundled-backends chart is checked for runtime sockets in its RENDER (below) and not for `hostPath` in its SOURCE, because `deploy/helm-bundled/vendor/argo-workflows` carries upstream CRD definitions whose openAPI schemas DOCUMENT the `hostPath` field in prose; that text is not a pod spec and stripping it would mean editing a vendored upstream manifest.

### §16. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED — THE CLUSTER-SCOPED HALF, AS A CENSUS. `chartGrantProblems` refuses a ClusterRole in every render the matrix visits; this refuses one in every render that COULD exist, including the value assignments nobody has enumerated. It is the same pairing the socket invariant uses one assertion above, and for the same reason: a sweep is total over the points it visits, a census is total over the literal text.

### §17. AND THE GRANT DETECTOR'S OWN NON-VACUITY

AND THE GRANT DETECTOR'S OWN NON-VACUITY. Same discipline as the socket control above: every verdict `chartGrantProblems` returned was "no problems", which is also what a function that had stopped looking returns. Four plants, each aimed at one arm that has no other control — a ClusterRole, a wildcard verb, a Role nothing binds, and an identity the chart is not supposed to have — asserted by COUNT so a detector that fired once and stopped is visible.

### §18. The RAW `helm template` output

The RAW `helm template` output. Separate from `renderDir` because a NEGATIVE invariant ("this string appears nowhere in what would be applied") is strictly stronger over the raw bytes than over the parsed docs: a socket path smuggled into a ConfigMap body, an annotation or a pod-spec field this file's `K8sDoc` shape does not model is invisible to a structural walk and obvious here. This is the exact inverse of the module doc's warning about string-grepping, which is about POSITIVE assertions ("the field is present on the container that matters").

### §19. THE REACHABILITY CONSTRAINT this guard encodes

THE REACHABILITY CONSTRAINT this guard encodes — and why "an ipBlock rule mentioning 443 or 6443" is NOT it.

A NetworkPolicy egress rule lets the hook pod reach the apiserver only if BOTH halves hold on the destination the CNI actually evaluates, which is the POST-DNAT one: kube-proxy has already rewritten `kubernetes.default` (10.96.0.1:443) to the real endpoint, `<node-ip>:6443`, before policy is applied.

```text
PORT — 6443 must be allowed. Measured on the drill's own environment (kind): the post-DNAT
       destination is 172.18.0.2:6443. A rule listing only 443 renders, reads plausibly, passes
       any "is 443 allowed" check — and the hook is dropped exactly as before the fix. 443 alone
       is therefore NOT sufficient evidence of reachability and must not satisfy this guard.
CIDR — the allowed ipBlocks must actually cover a node IP, AND must not cover anything else.
       `cidrs: [10.0.0.0/8]` looks careful and misses kind's 172.18.0.0/16 entirely — narrowing
       breaks reachability. `cidrs: [0.0.0.0/0]` goes the other way: it covers all three
       required ranges trivially, so a coverage-only check waves it through, but it ALSO grants
       the hook pod unrestricted public-internet egress on TCP/6443 (and 443) — inside a chart
       whose whole posture is default-deny, and that the air-gap drill exists to certify as
       zero-egress. So the guard requires the union of the rule's ipBlocks (minus any `except`)
       to cover ALL THREE RFC1918 ranges the chart ships as its default — the set the chart
       claims covers "kind, k3s, and private-endpoint managed clusters" — AND to extend no
       further than that union. Same class of bug as the ports check above: "at least" is not
       "exactly"; both the lower and the upper bound have to be asserted, or the guard only
       catches half of the ways this can regress.
```

An operator with a genuinely public control-plane endpoint sets `networkPolicy.kubeApi.cidrs` to that endpoint and this guard would flag it — deliberately: this asserts on the CHART'S SHIPPED DEFAULT render, which is what the drill and every out-of-the-box install use.

### §20. The exact union of the three required private ranges

The exact union of the three required RFC1918 ranges, as merged [start,end] pairs. Anything a granting rule covers OUTSIDE this union — 0.0.0.0/0, another private block, the public internet — is exactly as dangerous as failing to cover it: this chart's whole posture is default-deny, and the kube-API allow exists to punch ONE narrow, known hole in that, not to become a second "allow-all" rule wearing a kube-API label.

### §21. THE AIR-GAP REGRESSION GUARD

THE AIR-GAP REGRESSION GUARD (nightly deploy-drills.yml has no `pull_request` trigger; THIS job runs on every PR).

Every bundled-executor auto-wire hook Job (`*-autowire-*`) begins by reading the backend's admin Secret from `https://kubernetes.default.svc`. Its pod carries the chart's selector labels, so the chart's own `-default-deny` NetworkPolicy selects it — and for 12 consecutive nightly air-gap runs NOTHING in the chart allowed egress to the API server, so Calico dropped that read, the bin's `waitFor` timed out, and `helm upgrade --wait` failed with the uninformative "post-upgrade hooks failed ... Job in progress".

Pure detector (returns violations; empty ⇒ clean) so the standing gate and the explicit NEGATIVE case below share ONE decision function.

The check is deliberately structural, and deliberately demands an **ipBlock**: a `namespaceSelector` can NEVER reach the API server (kube-apiserver is a host-networked static pod, not a workload endpoint, and CNIs such as Calico evaluate egress policy against the POST-DNAT destination — the node IP:6443, not the ClusterIP). Without that requirement the pre-existing `allow-argocd` rule (namespaceSelector, ports 80+443) would satisfy a naive "port 443 is allowed" check and this guard would have passed on the very render that was broken in production.

ipBlock-ness is necessary but NOT sufficient — see KUBE_API_ENDPOINT_PORT / KUBE_API_REQUIRED_CIDRS / KUBE_API_REQUIRED_RANGES above for the actual reachability constraint (6443 must be allowed, the ipBlocks must cover the private ranges the chart ships, and must not grant more than that) and for the mutations that used to slip past (narrowing the ports, narrowing the CIDRs, and — the complementary failure — widening the CIDRs to something like `0.0.0.0/0` that covers the required ranges while also granting public-internet egress).

### §22. Covering the ranges is necessary but not sufficient

COVERING the three required ranges is necessary but NOT sufficient — a bare `0.0.0.0/0` covers all of them trivially while ALSO granting the hook pod unrestricted egress to the public internet on TCP/6443 (and 443), inside a chart whose entire posture is default-deny and that the air-gap drill exists to certify as zero-egress. So the grant must be bounded from BOTH sides: it must not extend beyond the union of the required private ranges either — computed on `covered` (post-`except`), so an `except` carve-out cannot be used to dodge this any more than it can be used to dodge the coverage check above.

### §23. WHAT COUNTS AS "DENY-ALL EGRESS"

WHAT COUNTS AS "DENY-ALL EGRESS": policyTypes contains Egress and the policy carries NO egress ALLOW RULE. `egress` absent and `egress: []` are the SAME policy to Kubernetes — both deny everything — so both must be recognised here. Matching only `=== undefined` (as this did) made an equally valid `egress: []` default-deny invisible, every hook took the `!denied` branch, and this entire regression guard passed green while the hooks were still being dropped. The old `spec.ingress === undefined` clause is gone too: whether a policy also carries INGRESS rules has no bearing on whether it denies EGRESS, so requiring it was a second way to hide a real deny-all. And it is `filter`+`some`, not `find`: with several policies, the first match is not necessarily the one that selects the hook pod.

### §24. Bundled executor backends

Bundled executor backends (Mode B — e.g. Argo CD) render UNMODIFIED upstream into their OWN namespace; SCP asserts isolation + air-gap on them (see verifyBundledArgocd below), NOT its strict pod-hardening: upstream Argo CD hardens per-container (allowPrivilegeEscalation/ readOnlyRootFilesystem/runAsNonRoot on the container) but not pod-level runAsNonRoot, and re-hardening it would fork the engine (the guardian's "unmodified upstream" prohibition). SCP's OWN resources render namespace-agnostic (they take the release namespace), so an explicit metadata.namespace is the marker of a bundled backend to exclude here.

### §25. M9.3 (ADR-0001, in-app federation mTLS)

M9.3 (ADR-0001, in-app federation mTLS) — the kitchen-sink render opts into federation.serverMtls.enabled. Since Node has no per-route TLS (the WHOLE listener becomes HTTPS), the readiness/liveness probes MUST follow or they fail their own TLS handshake against a plain-HTTP-expecting client — a structural check so a future values.yaml/template change that forgets this doesn't silently ship broken probes.

### §26. Bundled backends now live in a separate chart

Bundled backends (Mode B) now live in the SEPARATE `deploy/helm-bundled` chart, delivered via `helm template | kubectl apply` — they exceed Helm's 1 MB release-Secret limit, so they must NEVER ride the main chart's stored release (the M11 regression that motivated the split; see verifyBundledChart + the packaged-size guard in main). Regression guard: the MAIN chart must render ZERO resources into any bundled-backend namespace, on EVERY value set — if a vendored file or render template crept back into deploy/helm, this fails.

### §27. Asserted separately from the loop, since it differs

Argo Workflows is asserted SEPARATELY from the loop above, because it legitimately has only ONE of the two SCP-side integrations: the egress allow, and no auto-wire Job. Upstream's vendored argo-server runs `args: [server]`, i.e. the default `server` auth mode, in which the API server acts as its own ServiceAccount and requires no per-client bearer token — so there is no scoped token to mint and a hook would produce a credential nothing consumes. Adding it to the loop would therefore demand a Job that must not exist.

The egress allow, by contrast, is load-bearing in the strongest sense: it is the path D11's coordinated test hooks trigger over, so without it every declared hook triggers into a blocked connection and the wave it gates waits forever. This assertion is what makes deleting the policy a red test rather than a silent regression discovered by a team whose release never moves.

### §28. Executor egress allowlist

Executor egress allowlist (networkPolicy.executorEgress, Mode A / BYO-coordinate — SCP's outbound observe/trigger/status/abort calls to a coordinated Argo CD/GitHub/etc). Opt-in and additive: empty (the "defaults" render) must produce ZERO allow-executor-* NetworkPolicies — the default-deny baseline stays byte-for-byte unchanged — while a configured entry (the "kitchen-sink" render below) must produce exactly the configured policy, with BOTH a namespaceSelector `to` entry (in-cluster executor) and an ipBlock `to` entry (external executor) and the configured ports actually present. Internal-egress allowlist (internalEgressHosts -> SCP_INTERNAL_EGRESS_HOSTS, ADR-0003). The application-layer twin of networkPolicy.executorEgress below: it is the HARD boundary for the plugin SSRF egress guard, so the default MUST render nothing at all — an accidental default here would silently let every tenant-configurable plugin reach loopback/RFC1918, which is exactly the hole (MAJOR #6) the guard exists to close. When set, both the api and worker Deployments must carry it (the worker is where the plugin host actually lives).

### §29. Adversarial review MAJOR #2

Adversarial review MAJOR #2: on the DEFAULT (unconfigured networkPolicy.postgresCidr/natsCidr) values, the Postgres/NATS egress rules must NEVER allow "any destination" — a NetworkPolicy egress rule entry with `ports` but no `to` at all means every destination on that port, including the public internet. Every egress rule entry on every port-scoped allow-postgres/allow-nats NetworkPolicy must carry a `to` with at least one selector/ipBlock. This is a structural check (parsed YAML, not a string grep) so a future regression back to an absent `to:` fails THIS assertion, not just a human reviewer's eyeball pass.

### §30. Assertions for the SEPARATE bundled-backends chart

Assertions for the SEPARATE bundled-backends chart (deploy/helm-bundled), rendered with every backend enabled + images retargeted. This is where the bundled-backend isolation / air-gap checks live now that the backends no longer ride the main chart. (Harbor is REMOVED from the bundled stack — Gitea is the default registry, ADR-0012; an existing Harbor is coordinated via the import path, not bundled.)

### §31. SCP_HELM_VERIFY selects what a missing helm MEANS (2026-08-31)

SCP_HELM_VERIFY selects what a missing helm MEANS (2026-08-31): require  — helm absent FAILS. Set by CI job 4b, the job that installs a pinned helm itself and is wired into the 5z gate. Before this mode existed, 4b's guarantee rested on the probe below: if azure/setup-helm ever stopped putting helm on PATH, the "guaranteed" gate went GREEN having asserted nothing — the exact vacuous-green shape this repo documents (a check that passes without running). skip     — do not run, and say so. Set by CI job 4 (unit tests): its runner happens to pre-install helm, so the probe made this suite's result depend on GitHub's runner-image contents while 4b runs the identical script against a PINNED helm seconds later. Skipping removes the duplicate run and the runner-image dependency; it removes no gate — 4b is the gate. (unset)  — probe: run when helm is on PATH, skip when not. Local-dev behaviour, unchanged. Any other value is a config typo and must fail rather than silently probe.

### §32. AIR-GAP REGRESSION GUARD

AIR-GAP REGRESSION GUARD — the bundled-executor auto-wire hooks' path to the Kubernetes API server under the chart's own enforced default-deny. This is what broke the nightly air-gap drill on every scheduled run from 2026-07-13, and `deploy-drills.yml` has NO `pull_request` trigger — so this PR-time job is the only thing that can catch a regression before a nightly does.

Checked PER BACKEND, each enabled ALONE, not just together in the kitchen sink: the gitea hook makes the identical `https://kubernetes.default.svc` call and had the identical latent failure, reached only because argocd is enabled first and died first. A fix that happened to work only when both flags are on would be exactly the "fixed the instance, not the class" bug.

### §33. THE SAME POST-DNAT RULE, APPLIED TO THE BACKEND ITSELF

THE SAME POST-DNAT RULE, APPLIED TO THE BACKEND ITSELF — not just to the kube API.
A NetworkPolicy egress rule matches the destination AFTER kube-proxy's DNAT, so the port that must be allowed is the Service's targetPort (the backing container's port), NOT the Service port the client dialled. The check above already states this for the apiserver ("the POST-DNAT apiserver destination, not the 443 ClusterIP port") — and the same property was then missed for the bundled backends themselves.

It cost the air-gap drill every run: `allow-argocd` permitted 80/443 while `endpoints/argocd-server` was 8080, so under Calico the auto-wire hook's `POST /api/v1/session` was dropped and Node reported `TypeError: fetch failed` — an error with no status, address or port, so the one number that mattered appeared nowhere.

DERIVED, NOT HARDCODED: the required port is read from the bundled chart's own Service, so an upstream bump that moves the container port fails here instead of silently in a drill that only some environments enforce. Gitea passes today by coincidence (Service port and container port are both 3000); this check is what stops that coincidence being mistaken for a rule.

### §34. EVERY RENDERED DOC MUST CARRY AN apiVersion

EVERY RENDERED DOC MUST CARRY AN apiVersion — `kubectl apply` refuses the WHOLE stream otherwise, so one malformed document takes the entire backend down with it.

Measured 2026-08-29: the shared `commanderscp.renderVendoredBackend` helper emitted its Namespace with the leading newline chomped, so `apiVersion: v1` was appended onto the caller's last comment line and swallowed by it — the document then began at `kind:`. It hit ALL THREE callers of that helper (argo-workflows, argo-events, gitea); Argo CD escaped only because it does not use it. The failure reads "error validating data: apiVersion not set", which sounds like a broken vendored upstream manifest rather than template whitespace, and it surfaced in a drill days later rather than at render time.

Checked on the BUNDLED render (where the bug was) and cheap enough to be unconditional.

### §35. The upgrade-from-a-shipped-release guard on that value

UPGRADE-FROM-A-SHIPPED-RELEASE GUARD — `networkPolicy.kubeApi` is a values map that did NOT exist in previously released charts, and `scripts/scp-bundled.sh` wires a bundled backend with `helm upgrade --reuse-values`. Helm implements that flag by REPLACING the new chart's values.yaml defaults with the OLD release's coalesced values (`chart.Values = oldVals`), so on every existing installation this key is simply ABSENT at render time. `--set networkPolicy.kubeApi=null` reproduces that value tree exactly (both yield nil at that path, and both made the pre-fix template die with Error: ... at <.Values.networkPolicy.kubeApi.enabled>: nil pointer evaluating interface {}.enabled — i.e. the very command this fix exists to unbreak would have failed EARLIER, at render, for every existing install, while a fresh install looked fine).

TWO things must hold, and the second is the one a bare "does it render?" check misses: the policy must still be RENDERED. A nil-safe read that let the absent key mean "disabled" would render happily and then hang the auto-wire hook all over again.

### §36. NEGATIVE case — PROVE the guard above actually fires

NEGATIVE case — PROVE the guard above actually fires. Rendering with networkPolicy.kubeApi disabled reproduces the exact pre-fix manifest set (default-deny selects the hook pod; the only other policies covering it are DNS, the RFC1918 DB-port allow, and the backend's namespaceSelector allow — none of which can reach a host-networked apiserver). The detector MUST report a violation for each hook; if a future change made it permissive, THIS assert goes red.

### §37. NEGATIVE case — WIDENING

NEGATIVE case — WIDENING. This is the complementary failure to the two narrowing mutations above: `cidrs: ["0.0.0.0/0"]` trivially COVERS all three required RFC1918 ranges (so a coverage-only check waves it through — verified: this render passed 'all hardened-defaults assertions passed' before this case existed), while ALSO granting the hook pods unrestricted public-internet egress on TCP/6443 (and 443) — inside a chart whose whole posture is default-deny and that the air-gap drill exists to certify as zero-egress. The guard must bound the grant from BOTH sides — "at least" is not "exactly" — or a widened CIDR list sails through exactly as a narrowed one used to.

### §38. Default-deny written as an empty list, not by omitting

NEGATIVE case 4 — default-deny written as `egress: []` instead of omitting the field. Kubernetes treats the two identically; a detector that recognises only the omitted form sees NO default-deny, skips every hook, and reports success on a render whose hooks are still dropped. Synthetic docs rather than a render, because the chart cannot be coaxed into emitting the empty-list form — which is exactly why the hole survived review.

### §39. NOT a bare count

NOT a bare count. With only one NetworkPolicy and one hook Job in this synthetic set, BOTH branches of the detector produce exactly one violation — the buggy `hasNoAllowRules` (i.e. `=== undefined` only) sees `egress: []` as NOT deny-all, so the hook is reported as "not selected by any deny-all-egress policy" (a DIFFERENT, WRONG diagnosis, and one that would also fire on a render with no NetworkPolicy at all). Asserting only `.length >= 1` cannot tell these apart and would stay green through that exact regression. So pin down the SPECIFIC violation the fixed detector must produce: the hook IS recognised as denied by the `egress: []` policy, and THEN found to lack a kube-API path.

### §40. The chart's role value must reach the api and worker pods

M16.3 P3 — the MAIN chart's `federationRole` value must reach the api/worker containers as `SCP_FEDERATION_ROLE` (templates/_helpers.tpl's `commanderscp.commonEnv`), the runtime knob `config.ts`'s `loadFederationRole` reads to gate SPA registration (`app.ts`) off for a `retrans` relay. Unlike the M15.4 bundled-backend guardrail above (a render-time LINT only — that one is explicitly NOT runtime authority, per that block's own comment), THIS is asserting the actual wiring a live pod boots with: render the main chart with `federationRole=retrans` and check the env var landed, by name, on both Deployments' `scpd` containers. A regression that dropped this env var from `commonEnv` (or reverted app.ts's gate) would leave a retrans instance silently serving the SPA again — exactly the defect this milestone fixes — so this assertion is what keeps it caught at render time, permanently, in CI.

### §41. OPERATOR CONFIG SURFACE

OPERATOR CONFIG SURFACE — the chart must be able to configure the profiles the server ships.

WHY THIS EXISTS. M13 and M14 both shipped operator env vars with no chart deliverable in their DoDs, and the gap was invisible because nothing asserted on it: `commanderscp.commonEnv` renders a FIXED list, there is no generic `extraEnv` escape hatch, and a var that is simply absent produces a perfectly healthy pod running with the feature off. The result was a chart that provisioned a scan-DB PVC for a scanner it could not start and mounted federation client certs for a sync loop it could not enable. This block is the standing guard against the next one: every knob below is asserted BOTH ways — absent by default, present and correct when asked for — so "the server grew a knob and the chart did not" fails at render time in CI.

DEFAULT-ABSENT IS THE LOAD-BEARING HALF. Every loop here is opt-in on the server side (`=== "1"`), so a chart that rendered `SCP_INBOX_LOOP=0` would still be wrong-ish but harmless, while one that rendered it unconditionally as "1" would start unattended byte movement at a CDS boundary on a default `helm install`. Assert the vars are ABSENT, not merely falsy.

### §42. The operator write surface needs two things, not one

THE OPERATOR WRITE SURFACE NEEDS *TWO* THINGS, AND THIS CHART ONLY EVER RENDERED THE FIRST.

M22.9 R3. The chart rendered SCP_OPERATOR_TOKEN and nothing else, so an `operatorApi.enabled` install produced a pod that AUTHORIZED the operator and then could not execute: the four PUT handlers open their own connection, api/worker pods hold no admin DATABASE_URL by design (`commanderscp.adminDbEnv` is included by migrations-job.yaml alone), and `scp_app` holds SELECT only on the four instance-scoped tables. The write dialed config.ts's `localhost:5432` fallback INSIDE the pod and 500'd on ECONNREFUSED. Nothing was red: the pod was healthy, the render was green, and the integration suite could not see it because its DATABASE_URL is the Testcontainers SUPERUSER, which bypasses both the grant and the RLS barrier. For M22 the consequence was total — `scan_exclusion_admissions` stayed empty, and an empty admissions table fails the exclusion AND at its top rung for EVERY clause on the deployment, so the whole shipped dimension was inert.

`assertOperatorCredentialPairing` below is the standing guard, and it is deliberately stronger than "assert the var is present in this one render": it asserts the two vars are present together or absent together on EVERY doc set this block renders. A future change that reintroduces the token without the connection cannot render green under any values.

### §43. A relay is a validate-and-forward node, and not the other

NEGATIVE: a `retrans` CDS-boundary relay is a validate-and-forward node, NOT an execution site — it may bundle NOTHING. Enabling gitea on it is exactly the misconfiguration the lint exists to catch. We PROVE the lint fires: render retrans + gitea, and assert the guardrail returns a violation naming the role + the offending backend. This is a REAL suite assertion — if a future change made the guardrail permissive, THIS assert fails and helm-verify goes red.

### §44. The Kubernetes runner launcher's chart contract

M23.2 — THE KUBERNETES RUNNER LAUNCHER'S CHART CONTRACT
Four properties, and every one of them is something a `helm install` gets wrong SILENTLY. The adapter itself is gated by `kubernetes-adapter.kind.test.ts` against a real cluster (CI job 4e); what THAT cannot see is whether the chart hands it a token, an egress path, a volume and the settings to use them. A managed run then fails minutes into a promotion, on a cluster, with a timeout — which is the worst place to discover any of it.

### §45. The runner pod's own deny-all, proven to select the pod

(2b) M23.5 MEDIUM-10 — THE RUNNER POD'S OWN DENY-ALL, PROVEN TO SELECT THE POD.

```text
   ADR-0035 §6a's "an operator on Calico/Cilium loses nothing" is a claim about a
   NetworkPolicy that must actually SELECT the runner pod, not merely exist in the chart. A
   podSelector rendered by Helm and a pod template built by `jobManifest()` are two
   independent sources of truth for the SAME label; this reads both and checks the subset
   relationship the API server itself applies, rather than asserting they were WRITTEN to
   agree.
```

### §46. (3) THE PER-RUN SECRET GRANT

(3) THE PER-RUN SECRET GRANT — DECLARED HERE, NOT TOLERATED HERE.

```text
  THIS BLOCK INVERTED IN M23.4 AND THE INVERSION IS THE POINT OF WRITING IT DOWN. Until then
  it asserted the grant was ABSENT: `perRunSecrets` was a declared-and-disabled capability
  and this gate's job was to keep it disabled. The owner granted the RBAC on 2026-08-20
  ("grant the secrets RBAC, keep going"), so the default render now carries a privilege it
  did not carry before. A hardened-defaults gate that simply stopped failing on that would
  be worse than no gate — it would have quietly accepted a privilege grant. So the gate does
  not stop asserting; it asserts the OPPOSITE, plus the exact SHAPE of what was granted, so
  that any FURTHER widening (a `get`, a `list`, a `*`, a second resource) is a red build.
```

```text
  WHAT IS ACCEPTED, EXHAUSTIVELY: `create` and `delete` on `""/secrets`, namespaced, on the
  worker ServiceAccount, rendered only where a managed run can actually launch. The
  reasoning, the alternatives and the combination the owner accepted along with it are in
  ADR-0035; this is the machine-checked half of that record.
```

### §47. THE WHOLE ROLE, AS A SET, AGAINST WHAT THE ADAPTER ISSUES

THE WHOLE ROLE, AS A SET, AGAINST WHAT THE ADAPTER ISSUES — the M23.6 clause 5 gate. This subsumes the two assertions that used to stand here: the `patch` the harness found missing (the adapter creates the Job SUSPENDED and PATCHes it live, so without it `start` is a 403 for every run) and the `events: list` M23.5 added (when a Job cannot create a pod at all, the controller's `FailedCreate` Event is the only record of why, and teardown deletes the Job). Both are now MISSING-verb findings of the same diff, which also reports the opposite.

### §48. (3a-guard) M23.5 MEDIUM-7

(3a-guard) M23.5 MEDIUM-7 — THE DEFAULT POSTURE IS A RENDER-TIME REFUSAL, NOT A README LINE.

```text
  `perRunSecrets` defaults `true` and grants `delete` on EVERY Secret in whatever namespace
  this Role renders into (see the assertion above pinning the verb set). Proved with the
  worker's own token against a live cluster: `DELETE .../secrets/scp-commanderscp-db ->
  Success`. Before this guard, an operator who took every OTHER default got that blast
  radius over their own release's Secrets with no signal at install time. Three cases: the
  unsafe combination refuses; each of the three documented escapes renders clean.
```

### §49. The permissions exist for all three managed classes

(3b) THE RBAC EXISTS FOR ALL THREE MANAGED CLASSES, NOT ONLY THE ONE IT WAS NAMED AFTER.

```text
   A MEASURED DEFECT, NOT A TIDINESS RULE. Before M23.4 this Role was gated on
   `managedIac.enabled` while the service-account token, the kube-API egress allow, the
   workspace mount and every launcher setting were gated on "any managed class". Case (a)
   above proves the TOKEN arrives for a dep-only render; nothing proved the AUTHORISATION
   did, and it did not — `helm template` with managedDep alone rendered no Role and no
   RoleBinding at all, so the worker authenticated and every `jobs: create` was a 403.
   managed-dep, the one class that writes to a user's repository, was dead on Kubernetes.
   That is the incomplete-call-site-census property, and this loop is the census.
```

### §50. (3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE

(3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE. `managedRunners.kubernetes.namespace` has been operator-settable since M23.2 and the adapter creates its Jobs there; the Role was rendered unconditionally into `.Release.Namespace`, so taking the chart's own advice and separating the runners produced a silent 403 on every launch. Both now come from one helper, and this is what keeps them from drifting apart again.

### §51. Every worker write path, on every pod running that role

(5) EVERY WORKER-ROLE WRITE PATH, ON EVERY POD THAT RUNS THE WORKER ROLE (M23.5).

```text
  THIS BLOCK EXISTS BECAUSE EVERYTHING ABOVE IT LOOKS AT `-worker` AND NOTHING LOOKS AT
  `-api`. `helm template --set api.role=all --set worker.replicaCount=0` — the single-pod
  topology `values.yaml` documents by name — put the token and every launcher setting on the
  api pod (M23.2 fixed the token for exactly that reason) and mounted NOTHING at
  `SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT`. Copy-in wrote to the api container's ephemeral
  filesystem, the runner Job mounted the real claim and found an empty directory, and
  managed-iac's copy-out is `when:"always" / onFailure:"swallow"`, so the run reported
  nothing wrong. `assertRunnerPrerequisites` refuses a render whose claim is MISSING and
  rendered happily for the topology where it is named and never mounted.
```

```text
  AND THE ASSERTION THAT WAS ALREADY HALF-WRITTEN. The operator-config-surface block above
  says, in its own comment, "a knob wired into only one of them is a silent half-fix (the
  loops run on the worker, but an `api.role=all` pod runs them too)" — and applies that rule
  to env vars and to nothing else. So the api pod's TOKEN, its launcher settings and its
  volumes were all unasserted: reverting `deployment-api.yaml`'s conditional
  `automountServiceAccountToken` to the hard `false` it shipped with before M23.2 reddened
  nothing in this file. One predicate, both pods, all of it.
```

### §52. (6) THE POD CONVENTIONS THE RUNNER JOB INHERITS

(6) THE POD CONVENTIONS THE RUNNER JOB INHERITS (M23.5).

```text
  THE COUNT IS THE FINDING. This chart creates SIX pods; five are templates in this repo and
  every one of them carries `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a
  `resources` block. The sixth is built by `jobManifest()` at run time from
  `managedRunnerSettings()`, which described a namespace, a workspace and two booleans — so
  it inherited none of them, and not just the two that were reported. Measured on a real
  cluster with the image already on the node and tagged `:latest`: `spawn-failed,
  code=ErrImagePull`, while the identical image ran fine under `docker create`. An unset
  `imagePullPolicy` is `Always` for `:latest` — charter principle 5, broken in production.
```

```text
  ASSERTED ON THE CHART SIDE BECAUSE THAT IS THE HALF NO UNIT TEST CAN SEE. The golden pins
  what `jobManifest` does with these values; `managed-runner-selection.test.ts` pins how the
  server parses them. Neither can answer whether a `helm install` ever emits one.
```

### §53. Absent unless set, and verbatim when it is

(6c) `resources` — ABSENT unless set, and verbatim JSON when it is. The chart ships no default deliberately (a guessed memory limit OOMKills a real `tofu apply`, which looks like a runner bug); what it must not do is silently drop the value an operator DID set, because a namespace with a compute ResourceQuota and no defaulting LimitRange rejects a pod that declares none and no pod is then ever created.
