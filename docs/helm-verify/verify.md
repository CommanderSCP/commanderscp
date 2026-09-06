# verify

Reference for `tools/helm-verify/src/verify.ts`. The source carries a one-line headline at each site and points here.

> Partial: 19 of 53 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Allowed bundled backends per federation role

Allowed bundled backends per federation role. DOC SOURCE: ADR-0012 (outposts run Gitea as the self-contained registry/git + the deploy engine; commander runs the full Standard Stack) + the poke/retrans federation model (a `retrans` node is a validate-and-relay CDS-boundary relay — NOT an execution site, so it bundles NOTHING) + the M15.4 milestone note in BUILD_AND_TEST.md §8. Conservative where the docs are silent (outpost restricted to gitea + argocd; the build/event backends — argoWorkflows/argoEvents — are commander-only) — the assumption is documented in the M15.4 milestone note. If a future decision widens a role, widen this table (the single source of truth) and the milestone note together.

## §2. M23.6 CLAUSE 5

M23.6 CLAUSE 5 — THE RUNNER ROLE, DIFFED AGAINST WHAT THE ADAPTER ACTUALLY ISSUES, BOTH WAYS

The clause is "the chart grants exactly what the adapter calls, and no more". The gate that stood here before could only ever catch the FIRST half: `batch/jobs` was checked with `JSON.stringify(rules).includes('"patch"')`, `pods`/`pods/log` were checked NOWHERE AT ALL, and only `events` and `secrets` had a set-equality. Measured against that gate: four unused verbs added to `runner-iac.yaml` (`jobs: +deletecollection,+update`; `pods,pods/log: +delete,+create`) left this script green, `pnpm -w test` green and the kind suite green. A privilege that can only drift wider is the direction that matters.

THE EXPECTED SET IS NOT WRITTEN HERE. It is `kubernetesRunnerRbac()` in `@scp/runner-launcher`, which `kubernetes-rbac-contract.test.ts` holds to the adapter by DRIVING every route over a recording io and deriving the verbs from the wire. A second hand-maintained copy in this file would be free to agree with the chart and disagree with the code, which is the failure mode this whole clause is about.

ONE RULE PER (apiGroup, resource) IS PART OF THE CONTRACT, not a convenience for the comparison. A rule listing two resources gives each of them every verb in the list — that is how `pods` came to hold `get` and `pods/log` to hold `list`, neither of which the adapter ever issues — so a render that splits or merges rules differently must fail here rather than be normalised away.

## §3. The runner Job THIS RENDER WOULD PRODUCE

The runner Job THIS RENDER WOULD PRODUCE. Mirrors `managedRunnerKubernetesSettings()` in `apps/server/src/coordination/executor-bindings-repo.ts` — claim first, host path second, nothing third — so a chart that started plumbing `SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH` (today it does not, and that absence is itself asserted) would be caught here rather than at run time.

## §4. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED. Whether a managed run can actually launch at this point — i.e. whether the workload ServiceAccount is supposed to hold the runner grant AT ALL — and, if so, whether the per-run Secret capability is on. DERIVED FROM THE POINT'S OWN VALUES, never read back out of the render: an expectation computed from the thing being checked agrees with it by construction.

## §5. The exhaustive product

The exhaustive product. Dimensions, and why each one is in it: - the three managed classes, independently on/off (8) — the clause names them by wildcard, and each one gates a different block of `runner-iac.yaml` and of the worker's env. - the launcher (2) — `docker` and `kubernetes` render different pods and different volumes. - `managedRunners.kubernetes.namespace` empty vs a runner namespace (2) — moves the Role, the RoleBinding and the Jobs, and is the M23.5 render-time guard's own input. - `perRunSecrets` (2) — renders or omits a rule and flips a server-side flag. - `acceptSharedNamespaceSecretDelete` (2) — the documented override for the guard above; the combination it exists to unblock is asserted to REFUSE without it. - `runAsNonRoot` (2) — the only value that changes the runner pod's securityContext. Run twice: once with the rest of the chart at defaults, once with every other optional feature on (the existing kitchen sink plus `api.role=all`, which is the single-pod install where the worker's volumes land on the api pod too). Plus one small sweep over `api.role`, whose three values decide which pods exist at all.

## §6. THE BUNDLED BACKENDS' OWN IDENTITIES

THE BUNDLED BACKENDS' OWN IDENTITIES (M23.6 clause 5, widened). `bundledExecutor.*.enabled` is not a dimension of the socket product — no bundled backend can introduce a runtime socket into an SCP pod — but each one renders a ServiceAccount, a Role and a RoleBinding IN THE BACKEND'S NAMESPACE, which is a grant this chart makes to an identity outside everything the runner Role gate ever looked at. They are swept here so `chartGrantProblems` sees them: both alone and together, and crossed with the Kubernetes launcher so the runner grant and the hook grants are checked in one render rather than in two that never meet.

## §7. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED — THE WHOLE CHART'S GRANT, ON THE RENDERS THIS LOOP ALREADY HAS.

Sharing this loop is a deliberate cost decision, not a tidiness one. Each point is one `helm` process and this sweep already starved `turbo run test` once at 276 points (see `socketMatrix`'s own note); a second exhaustive sweep for RBAC would have doubled that for renders byte-identical to these. So the two invariants are asked of one render each, and the function above is pure so it can also be pointed at any other render.

## §8. M23.6 CLAUSE 5, WIDENED

M23.6 CLAUSE 5, WIDENED — THE CLUSTER-SCOPED HALF, AS A CENSUS. `chartGrantProblems` refuses a ClusterRole in every render the matrix visits; this refuses one in every render that COULD exist, including the value assignments nobody has enumerated. It is the same pairing the socket invariant uses one assertion above, and for the same reason: a sweep is total over the points it visits, a census is total over the literal text.

## §9. AND THE GRANT DETECTOR'S OWN NON-VACUITY

AND THE GRANT DETECTOR'S OWN NON-VACUITY. Same discipline as the socket control above: every verdict `chartGrantProblems` returned was "no problems", which is also what a function that had stopped looking returns. Four plants, each aimed at one arm that has no other control — a ClusterRole, a wildcard verb, a Role nothing binds, and an identity the chart is not supposed to have — asserted by COUNT so a detector that fired once and stopped is visible.

## §10. The RAW `helm template` output

The RAW `helm template` output. Separate from `renderDir` because a NEGATIVE invariant ("this string appears nowhere in what would be applied") is strictly stronger over the raw bytes than over the parsed docs: a socket path smuggled into a ConfigMap body, an annotation or a pod-spec field this file's `K8sDoc` shape does not model is invisible to a structural walk and obvious here. This is the exact inverse of the module doc's warning about string-grepping, which is about POSITIVE assertions ("the field is present on the container that matters").

## §11. THE AIR-GAP REGRESSION GUARD

THE AIR-GAP REGRESSION GUARD (nightly deploy-drills.yml has no `pull_request` trigger; THIS job runs on every PR).

Every bundled-executor auto-wire hook Job (`*-autowire-*`) begins by reading the backend's admin Secret from `https://kubernetes.default.svc`. Its pod carries the chart's selector labels, so the chart's own `-default-deny` NetworkPolicy selects it — and for 12 consecutive nightly air-gap runs NOTHING in the chart allowed egress to the API server, so Calico dropped that read, the bin's `waitFor` timed out, and `helm upgrade --wait` failed with the uninformative "post-upgrade hooks failed ... Job in progress".

Pure detector (returns violations; empty ⇒ clean) so the standing gate and the explicit NEGATIVE case below share ONE decision function.

The check is deliberately structural, and deliberately demands an **ipBlock**: a `namespaceSelector` can NEVER reach the API server (kube-apiserver is a host-networked static pod, not a workload endpoint, and CNIs such as Calico evaluate egress policy against the POST-DNAT destination — the node IP:6443, not the ClusterIP). Without that requirement the pre-existing `allow-argocd` rule (namespaceSelector, ports 80+443) would satisfy a naive "port 443 is allowed" check and this guard would have passed on the very render that was broken in production.

ipBlock-ness is necessary but NOT sufficient — see KUBE_API_ENDPOINT_PORT / KUBE_API_REQUIRED_CIDRS / KUBE_API_REQUIRED_RANGES above for the actual reachability constraint (6443 must be allowed, the ipBlocks must cover the private ranges the chart ships, and must not grant more than that) and for the mutations that used to slip past (narrowing the ports, narrowing the CIDRs, and — the complementary failure — widening the CIDRs to something like `0.0.0.0/0` that covers the required ranges while also granting public-internet egress).

## §12. Bundled executor backends

Bundled executor backends (Mode B — e.g. Argo CD) render UNMODIFIED upstream into their OWN namespace; SCP asserts isolation + air-gap on them (see verifyBundledArgocd below), NOT its strict pod-hardening: upstream Argo CD hardens per-container (allowPrivilegeEscalation/ readOnlyRootFilesystem/runAsNonRoot on the container) but not pod-level runAsNonRoot, and re-hardening it would fork the engine (the guardian's "unmodified upstream" prohibition). SCP's OWN resources render namespace-agnostic (they take the release namespace), so an explicit metadata.namespace is the marker of a bundled backend to exclude here.

## §13. AIR-GAP REGRESSION GUARD

AIR-GAP REGRESSION GUARD — the bundled-executor auto-wire hooks' path to the Kubernetes API server under the chart's own enforced default-deny. This is what broke the nightly air-gap drill on every scheduled run from 2026-07-13, and `deploy-drills.yml` has NO `pull_request` trigger — so this PR-time job is the only thing that can catch a regression before a nightly does.

Checked PER BACKEND, each enabled ALONE, not just together in the kitchen sink: the gitea hook makes the identical `https://kubernetes.default.svc` call and had the identical latent failure, reached only because argocd is enabled first and died first. A fix that happened to work only when both flags are on would be exactly the "fixed the instance, not the class" bug.

## §14. THE SAME POST-DNAT RULE, APPLIED TO THE BACKEND ITSELF

THE SAME POST-DNAT RULE, APPLIED TO THE BACKEND ITSELF — not just to the kube API.
A NetworkPolicy egress rule matches the destination AFTER kube-proxy's DNAT, so the port that must be allowed is the Service's targetPort (the backing container's port), NOT the Service port the client dialled. The check above already states this for the apiserver ("the POST-DNAT apiserver destination, not the 443 ClusterIP port") — and the same property was then missed for the bundled backends themselves.

It cost the air-gap drill every run: `allow-argocd` permitted 80/443 while `endpoints/argocd-server` was 8080, so under Calico the auto-wire hook's `POST /api/v1/session` was dropped and Node reported `TypeError: fetch failed` — an error with no status, address or port, so the one number that mattered appeared nowhere.

DERIVED, NOT HARDCODED: the required port is read from the bundled chart's own Service, so an upstream bump that moves the container port fails here instead of silently in a drill that only some environments enforce. Gitea passes today by coincidence (Service port and container port are both 3000); this check is what stops that coincidence being mistaken for a rule.

## §15. NEGATIVE case — PROVE the guard above actually fires

NEGATIVE case — PROVE the guard above actually fires. Rendering with networkPolicy.kubeApi disabled reproduces the exact pre-fix manifest set (default-deny selects the hook pod; the only other policies covering it are DNS, the RFC1918 DB-port allow, and the backend's namespaceSelector allow — none of which can reach a host-networked apiserver). The detector MUST report a violation for each hook; if a future change made it permissive, THIS assert goes red.

## §16. NEGATIVE case — WIDENING

NEGATIVE case — WIDENING. This is the complementary failure to the two narrowing mutations above: `cidrs: ["0.0.0.0/0"]` trivially COVERS all three required RFC1918 ranges (so a coverage-only check waves it through — verified: this render passed 'all hardened-defaults assertions passed' before this case existed), while ALSO granting the hook pods unrestricted public-internet egress on TCP/6443 (and 443) — inside a chart whose whole posture is default-deny and that the air-gap drill exists to certify as zero-egress. The guard must bound the grant from BOTH sides — "at least" is not "exactly" — or a widened CIDR list sails through exactly as a narrowed one used to.

## §17. NOT a bare count

NOT a bare count. With only one NetworkPolicy and one hook Job in this synthetic set, BOTH branches of the detector produce exactly one violation — the buggy `hasNoAllowRules` (i.e. `=== undefined` only) sees `egress: []` as NOT deny-all, so the hook is reported as "not selected by any deny-all-egress policy" (a DIFFERENT, WRONG diagnosis, and one that would also fire on a render with no NetworkPolicy at all). Asserting only `.length >= 1` cannot tell these apart and would stay green through that exact regression. So pin down the SPECIFIC violation the fixed detector must produce: the hook IS recognised as denied by the `egress: []` policy, and THEN found to lack a kube-API path.

## §18. OPERATOR CONFIG SURFACE

OPERATOR CONFIG SURFACE — the chart must be able to configure the profiles the server ships.

WHY THIS EXISTS. M13 and M14 both shipped operator env vars with no chart deliverable in their DoDs, and the gap was invisible because nothing asserted on it: `commanderscp.commonEnv` renders a FIXED list, there is no generic `extraEnv` escape hatch, and a var that is simply absent produces a perfectly healthy pod running with the feature off. The result was a chart that provisioned a scan-DB PVC for a scanner it could not start and mounted federation client certs for a sync loop it could not enable. This block is the standing guard against the next one: every knob below is asserted BOTH ways — absent by default, present and correct when asked for — so "the server grew a knob and the chart did not" fails at render time in CI.

DEFAULT-ABSENT IS THE LOAD-BEARING HALF. Every loop here is opt-in on the server side (`=== "1"`), so a chart that rendered `SCP_INBOX_LOOP=0` would still be wrong-ish but harmless, while one that rendered it unconditionally as "1" would start unattended byte movement at a CDS boundary on a default `helm install`. Assert the vars are ABSENT, not merely falsy.

## §19. (3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE

(3c) THE ROLE FOLLOWS THE RUNNER NAMESPACE. `managedRunners.kubernetes.namespace` has been operator-settable since M23.2 and the adapter creates its Jobs there; the Role was rendered unconditionally into `.Release.Namespace`, so taking the chart's own advice and separating the runners produced a silent 403 on every launch. Both now come from one helper, and this is what keeps them from drifting apart again.
