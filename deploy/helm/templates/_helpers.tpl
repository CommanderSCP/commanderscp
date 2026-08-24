{{/*
Chart name, truncated/sanitized per Helm chart conventions.
*/}}
{{- define "commanderscp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "commanderscp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "commanderscp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "commanderscp.labels" -}}
helm.sh/chart: {{ include "commanderscp.chart" . }}
{{ include "commanderscp.selectorLabels" . }}
{{/* image.tag can be digest-pinned (e.g. "1.0.0@sha256:...") — that's a valid image REF (see
     commanderscp.image) but NOT a valid k8s LABEL (labels are <=63 chars, [A-Za-z0-9._-], and must
     start/end alphanumeric). Every air-gap install via deploy/airgap/assets/install.sh digest-pins,
     so the raw tag broke the version label (a real bug the M9.4 air-gap drill surfaced). Sanitize:
     drop the @digest, cap at 63, and trim any non-alphanumeric edge left by truncation. */}}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | splitList "@" | first | trunc 63 | trimSuffix "-" | trimSuffix "_" | trimSuffix "." | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "commanderscp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "commanderscp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "commanderscp.apiSelectorLabels" -}}
{{ include "commanderscp.selectorLabels" . }}
app.kubernetes.io/component: api
{{- end -}}

{{- define "commanderscp.workerSelectorLabels" -}}
{{ include "commanderscp.selectorLabels" . }}
app.kubernetes.io/component: worker
{{- end -}}

{{/*
The label set carried by EVERY bundled-executor auto-wire HOOK pod (argocd, gitea, and any future
one) — the chart's selector labels PLUS the `commanderscp.io/autowire-hook` marker.

Why the marker exists (M11/M15.1 air-gap-drill regression): an auto-wire hook pod's FIRST action is
a cross-namespace Secret read against the in-cluster Kubernetes API (`https://kubernetes.default.svc`
— see apps/server/src/bundled-{argocd,gitea}-autowire-bin.ts). It carries this chart's selector
labels, so the chart's OWN `-default-deny` NetworkPolicy selects it, and nothing in the chart allowed
egress to the API server: the hook hung on its 300s `waitFor`, the Job burned its
`activeDeadlineSeconds`, and `helm upgrade --wait` died with "post-upgrade hooks failed ... Job in
progress". The fix is the `-allow-kube-api-autowire` policy in networkpolicy.yaml, which selects
EXACTLY this label set — so the API-server allow reaches the short-lived install-time hook pods and
NOTHING else (api/worker/postgres keep the unmodified default-deny posture).

Defined ONCE here, and consumed in exactly two places (the hook Job pod templates and that policy's
podSelector), so a future auto-wire hook opts in by using this helper rather than by a reviewer
remembering to extend a hardcoded list of component names.
*/}}
{{- define "commanderscp.autowireHookSelectorLabels" -}}
{{ include "commanderscp.selectorLabels" . }}
commanderscp.io/autowire-hook: "true"
{{- end -}}

{{/*
commanderscp.federationRole — validate + echo the federation role (commander|outpost|retrans).
Mirrors `deploy/helm-bundled`'s helper of the SAME name (that chart's own doc comment) — but
UNLIKE that one, this is not render-time-lint-only metadata: it's wired to `SCP_FEDERATION_ROLE`
(commonEnv below), the REAL runtime knob `config.ts`'s `loadFederationRole` reads (M16.3 P3 — a
`retrans` instance withholds the management SPA, `app.ts`). Rendering fails fast on a typo, same
as the bundled chart's helper.
*/}}
{{- define "commanderscp.federationRole" -}}
{{- $role := .Values.federationRole | default "commander" -}}
{{- if not (has $role (list "commander" "outpost" "retrans")) -}}
{{- fail (printf "federationRole must be one of commander|outpost|retrans, got %q" $role) -}}
{{- end -}}
{{- $role -}}
{{- end -}}

{{/*
SCP_ROLE for the api Deployment — "api" (default) or "all". Same fail-fast-on-a-typo discipline as
`commanderscp.federationRole`: a silently-ignored misspelling here would leave the operator with an
api-only pod they believe is worker-capable, and the symptom (a 400 from /discovery/run) looks
nothing like a values typo.
*/}}
{{- define "commanderscp.apiRole" -}}
{{- $role := .Values.api.role | default "api" -}}
{{- if not (has $role (list "api" "all")) -}}
{{- fail (printf "api.role must be one of api|all, got %q" $role) -}}
{{- end -}}
{{- $role -}}
{{- end -}}

{{- define "commanderscp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "commanderscp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "commanderscp.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/*
NetworkPolicy egress `to:` block for a Postgres/NATS-shaped allow rule, given an OPTIONAL explicit
CIDR value (`networkPolicy.postgresCidr`/`natsCidr`). Adversarial review MAJOR #2: the UNCONFIGURED
default must NOT be "any destination" (an omitted `to:` on a NetworkPolicy egress rule means
"every destination", including the public internet, on that port) — so when no explicit CIDR is
set, this renders the RFC1918 private-range ipBlocks instead (10.0.0.0/8, 172.16.0.0/12,
192.168.0.0/16 — same set apps/server's own SSRF egress-guard, plugin-host/egress-guard.ts, treats
as "private"), which still covers the common cases (an in-VPC/on-prem external Postgres reachable
by private IP, and the eval in-cluster Postgres pod, whose IP falls in the cluster's pod CIDR —
itself almost always one of these three ranges, e.g. kind's default/this chart's own drill's
192.168.0.0/16) without ever defaulting to "reachable from anywhere on the internet" on the DB
port. An operator with a genuinely public-IP-reachable Postgres/NATS host still sets the CIDR
value explicitly to scope this precisely (or wider, if truly required — an explicit, visible
choice, not a silent default).

M26.3: the value may ALSO be a LIST of CIDR strings (needed for a cross-cluster Postgres endpoint
reachable via more than one advertised route — VPC peering ranges, a Transit Gateway/VPN, …) —
`kindIs "slice"` picks that branch; a bare string keeps rendering exactly as before, unchanged for
every existing install/values file.
*/}}
{{- define "commanderscp.egressToBlock" -}}
{{- if kindIs "slice" . -}}
{{- if . -}}
to:
  {{- range . }}
  - ipBlock:
      cidr: {{ . }}
  {{- end }}
{{- else -}}
to:
  - ipBlock:
      cidr: 10.0.0.0/8
  - ipBlock:
      cidr: 172.16.0.0/12
  - ipBlock:
      cidr: 192.168.0.0/16
{{- end -}}
{{- else if . -}}
to:
  - ipBlock:
      cidr: {{ . }}
{{- else -}}
to:
  - ipBlock:
      cidr: 10.0.0.0/8
  - ipBlock:
      cidr: 172.16.0.0/12
  - ipBlock:
      cidr: 192.168.0.0/16
{{- end -}}
{{- end -}}

{{/*
topologySpreadConstraints for the api/worker pod templates (M26.3, C1). Takes the OPERATOR-FACING
list from `.Values.api|worker.topologySpreadConstraints` (each entry only names `maxSkew`/
`topologyKey`/`whenUnsatisfiable` — see values.yaml) and injects the `labelSelector` this chart
alone knows how to build, so an operator overriding the list never has to restate this
Deployment's own selector labels correctly. Renders nothing when the list is empty (`[]`).
*/}}
{{- define "commanderscp.topologySpreadConstraints" -}}
{{- $constraints := .constraints -}}
{{- $selectorLabels := .selectorLabels -}}
{{- if $constraints }}
topologySpreadConstraints:
  {{- range $constraints }}
  - maxSkew: {{ .maxSkew }}
    topologyKey: {{ .topologyKey }}
    whenUnsatisfiable: {{ .whenUnsatisfiable }}
    labelSelector:
      matchLabels:
        {{- $selectorLabels | nindent 8 }}
  {{- end }}
{{- end -}}
{{- end }}

{{/*
Secret name + key helpers — postgres/appSecrets/oidc all follow the same "existingSecret OR the
chart-generated one" pattern (secrets.yaml renders the generated Secret only when existingSecret
is empty, under the fixed name "<fullname>-generated").
*/}}
{{- define "commanderscp.postgresSecretName" -}}
{{- .Values.postgres.existingSecret | default (printf "%s-postgres" (include "commanderscp.fullname" .)) -}}
{{- end -}}

{{- define "commanderscp.appSecretsName" -}}
{{- .Values.appSecrets.existingSecret | default (printf "%s-app-secrets" (include "commanderscp.fullname" .)) -}}
{{- end -}}

{{/*
Shared env vars every scpd process (api, worker, migrations Job) needs — role-independent
config. Callers append SCP_ROLE / SCP_SKIP_MIGRATIONS / role-specific DB secret refs themselves,
since those three differ between the migrations Job and the api/worker Deployments.
*/}}
{{- define "commanderscp.commonEnv" -}}
- name: PORT
  value: "8080"
- name: HOST
  value: "0.0.0.0"
- name: SCP_BOOTSTRAP_ORG
  value: {{ .Values.bootstrap.orgName | quote }}
- name: SCP_BOOTSTRAP_ADMIN_USERNAME
  value: {{ .Values.bootstrap.adminUsername | quote }}
- name: SCP_SEED_DEMO
  value: {{ .Values.seedDemo | quote }}
- name: SCP_FEDERATION_ROLE
  value: {{ include "commanderscp.federationRole" . | quote }}
- name: SCP_EVENT_BUS_BACKEND
  value: {{ .Values.eventBus.backend | quote }}
{{- if eq .Values.eventBus.backend "nats" }}
- name: SCP_NATS_URL
  value: {{ .Values.eventBus.natsUrl | quote }}
{{- end }}
- name: SCP_COOKIE_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.appSecretsName" . }}
      key: {{ .Values.appSecrets.existingSecretKeys.cookieSecret }}
- name: SCP_SECRETS_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.appSecretsName" . }}
      key: {{ .Values.appSecrets.existingSecretKeys.secretsMasterKey }}
{{- if .Values.oidc.enabled }}
- name: SCP_OIDC_ISSUER
  value: {{ .Values.oidc.issuer | quote }}
- name: SCP_OIDC_CLIENT_ID
  value: {{ .Values.oidc.clientId | quote }}
- name: SCP_OIDC_REDIRECT_URI
  value: {{ .Values.oidc.redirectUri | quote }}
- name: SCP_OIDC_SCOPES
  value: {{ .Values.oidc.scopes | quote }}
{{- if .Values.oidc.existingSecretClientSecret }}
- name: SCP_OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.oidc.existingSecretClientSecret }}
      key: {{ .Values.oidc.existingSecretClientSecretKey }}
{{- end }}
{{- end }}
{{- if .Values.internalBaseUrl }}
{{- /* How this instance names ITSELF to a human — the CLI device-login `verificationUri` is
       derived from it (routes/device-flow.ts). Unset keeps config.ts's 127.0.0.1 default, which is
       correct for a local run and wrong for every ingress-served install. */}}
- name: SCP_INTERNAL_BASE_URL
  value: {{ .Values.internalBaseUrl | quote }}
{{- end }}
{{- if .Values.operatorApi.enabled }}
{{- /* The instance-operator write surface. REQUIRES an operator-supplied Secret: the token must be
       readable by a human, so the chart-generated secret is deliberately not an option (see the
       values comment). Fail at render rather than crash-loop the pod on a missing secret key. */}}
{{- if not .Values.appSecrets.existingSecret }}
{{- fail "operatorApi.enabled requires appSecrets.existingSecret — the operator token must come from a Secret you create and can read (the chart-generated secret never contains it)" }}
{{- end }}
{{- /* THE TOKEN AND THE CONNECTION ARE ONE DELIVERABLE, AND THIS BLOCK IS WHERE THAT IS ENFORCED.
       Before M22.9 R3 this rendered the token alone. A pod holding SCP_OPERATOR_TOKEN and no
       database credential passes the door's AUTH check and then cannot execute: the four PUT
       handlers open their own connection, api/worker pods hold no admin DATABASE_URL (that is
       `commanderscp.adminDbEnv`, included by migrations-job.yaml and nothing else), so the write
       dialed config.ts's `localhost:5432` fallback INSIDE the pod and 500'd on ECONNREFUSED. The
       whole M22 exclusion dimension was inert on every Helm install as a result — the admissions
       table stayed empty, and an empty admissions table fails the exclusion AND at its top rung for
       every clause on the deployment. Rendering the two together, in one `if`, is what makes
       "granted the token but not the connection" unrepresentable; tools/helm-verify asserts it. */}}
{{- if not .Values.operatorApi.databaseUrlSecret }}
{{- fail "operatorApi.enabled requires operatorApi.databaseUrlSecret — the operator write doors need a connection authenticating as the `scp_operator` role (apps/server/drizzle/0076); without it the API grants the token and then 503s on every write. See deploy/helm/README.md 'Operator write surface'" }}
{{- end }}
- name: SCP_OPERATOR_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.appSecretsName" . }}
      key: {{ .Values.appSecrets.existingSecretKeys.operatorToken }}
- name: SCP_OPERATOR_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.operatorApi.databaseUrlSecret }}
      key: {{ .Values.operatorApi.databaseUrlSecretKey }}
{{- end }}
{{- if .Values.artifactChannel.ociRegistryHosts }}
{{- /* ADR-0019 §4 — the APPLICATION half of the two-layer egress model. The NETWORK half is
       networkPolicy.executorEgress (CIDRs; a NetworkPolicy cannot match a DNS name). Both or
       neither: one alone renders green and still cannot pull. */}}
- name: SCP_ARTIFACT_OCI_REGISTRY_HOSTS
  value: {{ join "," .Values.artifactChannel.ociRegistryHosts | quote }}
{{- end }}
{{- if .Values.artifactChannel.blobBaseUrls }}
- name: SCP_ARTIFACT_BLOB_BASE_URLS
  value: {{ join "," .Values.artifactChannel.blobBaseUrls | quote }}
{{- end }}
{{- if .Values.artifactChannel.insecureHosts }}
- name: SCP_ARTIFACT_INSECURE_HOSTS
  value: {{ join "," .Values.artifactChannel.insecureHosts | quote }}
{{- end }}
{{- if .Values.federation.sync.enabled }}
{{- /* M14.0/M14.4 (ADR-0009) — the outpost/retrans live-pull scheduler. Data direction unchanged:
       the outpost pulls; nothing flows commander→outpost. */}}
- name: SCP_FEDERATION_SYNC_LOOP
  value: "1"
- name: SCP_FEDERATION_SYNC_INTERVAL_SECONDS
  value: {{ .Values.federation.sync.intervalSeconds | quote }}
- name: SCP_FEDERATION_SYNC_SPARSE_INTERVAL_SECONDS
  value: {{ .Values.federation.sync.sparseIntervalSeconds | quote }}
{{- end }}
{{- if .Values.federation.relay.inbox.enabled }}
{{- /* M13.1a — the staging node's unattended INGEST half. */}}
- name: SCP_INBOX_LOOP
  value: "1"
- name: SCP_INBOX_TICK_INTERVAL_SECONDS
  value: {{ .Values.federation.relay.inbox.tickIntervalSeconds | quote }}
{{- end }}
{{- if .Values.federation.relay.autoRelay.enabled }}
{{- /* M13.1b — the staging node's unattended EGRESS half: byte movement across a security
       boundary, opted into separately from ingest, and belonging ONLY on the retrans that can
       reach the source registry (the low side). */}}
- name: SCP_RETRANS_AUTO_RELAY
  value: "1"
- name: SCP_RETRANS_AUTO_RELAY_INTERVAL_SECONDS
  value: {{ .Values.federation.relay.autoRelay.intervalSeconds | quote }}
- name: SCP_RETRANS_AUTO_RELAY_MAX_ATTEMPTS
  value: {{ .Values.federation.relay.autoRelay.maxAttempts | quote }}
- name: SCP_RETRANS_AUTO_RELAY_LEASE_SECONDS
  value: {{ .Values.federation.relay.autoRelay.leaseSeconds | quote }}
{{- end }}
{{- if ne (.Values.federation.relay.volumes.type | default "none") "none" }}
{{- /* M26.3 (C4) — the byte-channel drop-directory volume vocabulary. Wired ONLY when a volume
       is actually mounted (workerRoleVolumeMounts/workerRoleVolumes below render the matching
       "retrans-relay" volume under the identical condition) — with `type: none` these three stay
       unset, which is today's byte-identical pre-M26.3 behavior (inbox/autoRelay resolve no
       target and defer harmlessly). */}}
- name: SCP_RELAY_OUT_DIR
  value: {{ .Values.federation.relay.volumes.outDir | quote }}
- name: SCP_RELAY_IN_DIR
  value: {{ .Values.federation.relay.volumes.inDir | quote }}
- name: SCP_RELAY_BLOB_OUT_DIR
  value: {{ .Values.federation.relay.volumes.blobOutDir | quote }}
{{- end }}
{{- if .Values.federation.relay.volumes.deliveryRoots }}
{{- /* ADR-0019 §4 symmetry — required before any PER-PEER filesystem delivery directory (as
       opposed to the instance-wide fallback dirs above) is honored (fail-closed default). */}}
- name: SCP_DELIVERY_ROOTS
  value: {{ join "," .Values.federation.relay.volumes.deliveryRoots | quote }}
{{- end }}
{{- if .Values.federation.relay.s3.endpoints }}
{{- /* S3-first delivery guidance made actionable (M26.3, C4) — the RECOMMENDED posture for any
       multi-replica/multi-member-cluster retrans (see values.yaml's `federation.relay` comment).
       Fail-closed when unset, same as the filesystem roots above. */}}
- name: SCP_DELIVERY_S3_ENDPOINTS
  value: {{ join "," .Values.federation.relay.s3.endpoints | quote }}
{{- end }}
{{- if .Values.internalEgressHosts }}
{{- /* Operator half of the two-layer internal-egress model (ADR-0003) — same host-level,
       never-tenant-suppliable trust tier as the SCP_MANAGED_IAC_* / SCP_FEDERATION_MTLS_* vars
       below. Empty (default) renders nothing at all, so the SSRF egress guard's deny posture is
       untouched for every existing install. */}}
- name: SCP_INTERNAL_EGRESS_HOSTS
  value: {{ join "," .Values.internalEgressHosts | quote }}
{{- end }}
{{- if .Values.managedIac.enabled }}
- name: SCP_MANAGED_IAC_RUNNER_IMAGE
  value: {{ .Values.managedIac.runnerImage | quote }}
- name: SCP_MANAGED_IAC_NETWORK_MODE
  value: {{ .Values.managedIac.networkMode | quote }}
- name: SCP_MANAGED_IAC_WORKSPACE_ROOT
  value: {{ .Values.managedIac.workspaceRoot | quote }}
{{- end }}
{{- if .Values.managedScan.runnerImage }}
{{- /* M23.4 — the value that had no chart value. `managedScanServerSettings()` has read this since
       M13.3b; the chart never rendered it, so a `helm install` could not turn managed-scan on at
       all. Same host-level, never-tenant-suppliable trust tier as SCP_MANAGED_IAC_*. Gated on the
       IMAGE for the same reason managedDep is: the image IS the enablement. No network-mode var —
       this class's egress clause is QUALIFIED (registry pulls), so the plugin resolves it against
       the scanner registry rather than taking an operator default. */}}
- name: SCP_MANAGED_SCAN_RUNNER_IMAGE
  value: {{ .Values.managedScan.runnerImage | quote }}
{{- end }}
{{- if .Values.managedDep.runnerImage }}
{{- /* M21.5 (ADR-0032 §8) — the dependency-bump actuator. Same host-level, never-tenant-suppliable
       trust tier as SCP_MANAGED_IAC_*. Gated on the IMAGE rather than on a separate `enabled` flag,
       deliberately: the image IS the enablement (unset means off, and the server refuses before a
       container or a credential exists), so a chart with `enabled: true` and no image would render
       a deployment that looks on and fails closed at dispatch. No network-mode var — this class's
       egress clause is unqualified, so the plugin passes a literal (ADR-0032 §8d). */}}
- name: SCP_MANAGED_DEP_RUNNER_IMAGE
  value: {{ .Values.managedDep.runnerImage | quote }}
- name: SCP_MANAGED_DEP_WORKSPACE_ROOT
  value: {{ .Values.managedDep.workspaceRoot | quote }}
{{- end }}
{{- if eq .Values.managedRunners.launcher "kubernetes" }}
{{- /* M23.2 — WHICH LAUNCHER ADAPTER, and the Kubernetes adapter's deployment settings. Same
       host-level, never-tenant-suppliable trust tier as SCP_MANAGED_IAC_*: the plugin subprocess
       never sees `process.env` (host.ts's `minimalChildEnv` strips it), so these reach the plugins
       only by being read here, injected LAST into every managed instance's config, and refused by
       name at the four write doors. Rendered only when the operator selected `kubernetes`, so a
       docker deployment carries no Kubernetes surface at all. */}}
- name: SCP_MANAGED_RUNNER_LAUNCHER
  value: "kubernetes"
- name: SCP_MANAGED_RUNNER_K8S_NAMESPACE
  value: {{ .Values.managedRunners.kubernetes.namespace | default .Release.Namespace | quote }}
- name: SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT
  value: {{ .Values.managedRunners.kubernetes.workspace.mountPath | quote }}
- name: SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM
  value: {{ .Values.managedRunners.kubernetes.workspace.claimName | quote }}
- name: SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS
  value: {{ .Values.managedRunners.kubernetes.perRunSecrets | quote }}
- name: SCP_MANAGED_RUNNER_K8S_RUN_AS_NON_ROOT
  value: {{ .Values.managedRunners.kubernetes.runAsNonRoot | quote }}
{{- /* M23.5 — THE POD CONVENTIONS EVERY OTHER POD IN THIS CHART INHERITS, carried to the one pod
       Helm does not render. `jobManifest()` builds the runner Job at run time, so the only way a
       deployment-wide convention reaches it is through these variables. Each renders only when it
       has a value, so a deployment that states none produces a byte-identical launch.

       THE TWO DEFAULTS ARE INHERITANCES, not new opinions: an empty `imagePullSecrets` takes
       `.Values.imagePullSecrets` and an empty `imagePullPolicy` takes `.Values.image.pullPolicy`,
       which are exactly what the api, worker, migrations and both auto-wire pods use. `resources`
       has no chart-wide default to inherit and is therefore empty unless set — see values.yaml. */}}
{{- $rk := .Values.managedRunners.kubernetes -}}
{{- $pullSecrets := $rk.imagePullSecrets | default .Values.imagePullSecrets -}}
{{- if $pullSecrets }}
{{- $names := list -}}
{{- range $pullSecrets }}{{- $names = append $names .name -}}{{- end }}
- name: SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS
  value: {{ join "," (compact $names) | quote }}
{{- end }}
- name: SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY
  value: {{ $rk.imagePullPolicy | default .Values.image.pullPolicy | quote }}
{{- if $rk.resources }}
- name: SCP_MANAGED_RUNNER_K8S_RESOURCES
  value: {{ $rk.resources | toJson | quote }}
{{- end }}
{{- /* Node's global fetch cannot take a custom CA without an undici Agent, so the in-cluster API
       server's certificate is trusted through this variable — the SAME mechanism the two shipped
       in-cluster callers (bundled-{argocd,gitea}-autowire-bin.ts) already rely on, and the reason
       they document it. Without it every API call from the adapter fails TLS verification. */}}
- name: NODE_EXTRA_CA_CERTS
  value: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
{{- end }}
{{- if .Values.scanDbCache.enabled }}
{{- /* M13.3b-ii (ADR-0020, proposal §13.3b) — the commander's server-maintained Trivy-DB cache.
       OPTIONAL and OFF by default, so single-container/dev stays zero-config on the image-baked DB
       (the fail-closed fallback). When enabled, this mounts a PVC and points the promotion scan step
       at it (SCP_MANAGED_SCAN_DB_CACHE); the operator keeps it fresh via `scp scan-db refresh`
       (connected) or `scp scan-db load` (air-gap). RWO single-writer, exactly like objectStorage. */}}
- name: SCP_MANAGED_SCAN_DB_CACHE
  value: {{ .Values.scanDbCache.mountPath | quote }}
{{- end }}
{{- if .Values.federation.mtls.enabled }}
- name: SCP_FEDERATION_MTLS_CERT_FILE
  value: /etc/scp/federation-mtls/tls.crt
- name: SCP_FEDERATION_MTLS_KEY_FILE
  value: /etc/scp/federation-mtls/tls.key
- name: SCP_FEDERATION_MTLS_CA_FILE
  value: /etc/scp/federation-mtls/ca.crt
{{- end }}
{{/*
M9.3 (ADR-0001) — in-app federation mTLS (apps/server itself terminating TLS and verifying an
incoming peer's client cert, `config.ts`'s `loadFederationServerMtls Config`). CA/cert/key come
from ONE secret/mount (`federation-server-mtls`); the CRL is DELIBERATELY a separate mount
(`federation-server-mtls-crl`) so a revocation-list refresh never requires re-rolling CA material
— see this file's volume/volumeMount definitions in deployment-api.yaml/deployment-worker.yaml.
*/}}
{{- if .Values.federation.serverMtls.enabled }}
- name: SCP_FEDERATION_SERVER_MTLS_CA_FILE
  value: /etc/scp/federation-server-mtls/ca.crt
- name: SCP_FEDERATION_SERVER_MTLS_CERT_FILE
  value: /etc/scp/federation-server-mtls/tls.crt
- name: SCP_FEDERATION_SERVER_MTLS_KEY_FILE
  value: /etc/scp/federation-server-mtls/tls.key
- name: SCP_FEDERATION_SERVER_MTLS_CRL_HARD_FAIL_ON_EXPIRY
  value: {{ .Values.federation.serverMtls.crlHardFailOnExpiry | quote }}
{{- if .Values.federation.serverMtls.crl.enabled }}
- name: SCP_FEDERATION_SERVER_MTLS_CRL_FILE
  value: /etc/scp/federation-server-mtls-crl/{{ .Values.federation.serverMtls.crl.secretKey }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Runtime (least-privileged) DB env — api/worker Deployments ONLY. Never the admin DATABASE_URL.
*/}}
{{- define "commanderscp.runtimeDbEnv" -}}
- name: SCP_SKIP_MIGRATIONS
  value: "true"
- name: SCP_RUNTIME_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.postgresSecretName" . }}
      key: {{ .Values.postgres.existingSecretKeys.app }}
- name: SCP_PGBOSS_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.postgresSecretName" . }}
      key: {{ .Values.postgres.existingSecretKeys.pgboss }}
{{- end -}}

{{/*
Admin DB env — the migrations Job ONLY.
*/}}
{{- define "commanderscp.adminDbEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "commanderscp.postgresSecretName" . }}
      key: {{ .Values.postgres.existingSecretKeys.admin }}
{{- end -}}

{{/*
wait-for-postgres init container — a plain TCP-connect retry loop against the DB host:port parsed
from whichever DB connection-string env var the caller injects (the migrations Job passes the
admin DATABASE_URL; api/worker pass SCP_RUNTIME_DATABASE_URL). Same image, no extra tooling
(pg_isready isn't in the scpd image — DESIGN §16's "no extra toolchain" principle). This makes
api/worker/migrations resilient to the DB not yet accepting connections when the pod first starts
— without it, a pod that boots before postgres is ready (common on a slow/loaded cluster, or
right after `postgres.evalInCluster` first schedules) crashes with a DB-connection error (exit 1),
restarts, and — for api — can lose the one-time bootstrap-admin password to the churned container
logs. Reused by all three workloads via `include ... (dict "root" . "dbEnvVar" "<NAME>")`.

DELIBERATELY SINGLE-HOST (owner decision D5, M26.3 — multi-region-instance-resilience.md §7.4/
§11): this `new URL()` parse is exactly the DSN contract values.yaml's `postgres.host` comment
describes — ONE stable operator-provided endpoint, never a multi-host connection string. A
multi-cluster instance still has exactly one Postgres; this container does not grow multi-host
parsing to "support" more member clusters, because there is nothing about multi-host DSNs to
support here.
*/}}
{{- define "commanderscp.waitForPostgresInitContainer" -}}
{{- $root := .root -}}
- name: wait-for-postgres
  image: {{ include "commanderscp.image" $root }}
  imagePullPolicy: {{ $root.Values.image.pullPolicy }}
  command:
    - node
    - -e
    - |
      const net = require("node:net");
      const url = new URL(process.env.{{ .dbEnvVar }});
      const host = url.hostname, port = Number(url.port || 5432);
      const deadline = Date.now() + 120000;
      (function attempt() {
        const sock = net.createConnection({ host, port }, () => {
          console.log(`wait-for-postgres: connected to ${host}:${port}`); sock.end(); process.exit(0);
        });
        sock.on("error", (err) => {
          sock.destroy();
          if (Date.now() > deadline) { console.error(`wait-for-postgres: giving up after 120s: ${err.message}`); process.exit(1); }
          console.log(`wait-for-postgres: ${host}:${port} not ready (${err.message}), retrying...`); setTimeout(attempt, 2000);
        });
      })();
  securityContext:
    {{- toYaml $root.Values.containerSecurityContext | nindent 4 }}
  env:
    - name: {{ .dbEnvVar }}
      valueFrom:
        secretKeyRef:
          name: {{ include "commanderscp.postgresSecretName" $root }}
          key: {{ if eq .dbEnvVar "DATABASE_URL" }}{{ $root.Values.postgres.existingSecretKeys.admin }}{{ else }}{{ $root.Values.postgres.existingSecretKeys.app }}{{ end }}
  resources:
    {{- toYaml $root.Values.migrations.resources | nindent 4 }}
{{- end -}}

{{/*
DOES THIS POD NEED A SERVICE-ACCOUNT TOKEN? (M23.2, owner decision 6)

`deployment-api.yaml` carried a HARD `automountServiceAccountToken: false` with no value behind it,
and `deployment-worker.yaml` gated its own on `managedIac.enabled` ALONE. Both were wrong for M23.2
in different directions, and the api one was the load-bearing mistake: `values.yaml` documents
`api.role=all` with `worker.replicaCount: 0` as the supported single-pod topology, so as shipped this
milestone would have delivered a Kubernetes launcher that is dead on the chart's own small install —
the pod that runs the managed executors would have had no token to authenticate with.

TRUE ONLY WHERE A MANAGED RUNNER CAN ACTUALLY LAUNCH: the Kubernetes launcher is selected AND at
least one managed class is enabled. So the hardened default is unchanged for every deployment that
does not opt in, which is the half of owner decision 6 that says "the default stays hardened".

The api pod additionally has to be running the worker role at all — a split-topology `api.role=api`
never executes a managed trigger, so a token there would be surface for nothing.
*/}}
{{/*
THE KUBERNETES LAUNCHER'S DEPLOYMENT PREREQUISITES, REFUSED AT RENDER TIME (M23.2, owner decision 5).

"RWX STORAGE IS A DOCUMENTED DEPLOYMENT PREREQUISITE for payloads that must be moved rather than
pulled. Kubernetes has no universal `docker cp`: a ConfigMap fails the 1 MiB etcd limit, and
`pods/exec` + tar is impossible against `apps/runner-dep`'s seven-applet `FROM scratch` image. The
chart's existing PVCs are RWO, so this needs a render-time check and a clear failure message rather
than a mysterious hang."

WHAT THE HANG WOULD LOOK LIKE WITHOUT THIS, which is why a `fail` and not a README line: with no
claim named, the worker Deployment renders a `persistentVolumeClaim` with an empty `claimName`, the
pod never schedules, and the operator sees a Deployment stuck at 0/1 with no message about managed
execution anywhere. With a claim that exists but is RWO, everything installs cleanly and the FIRST
managed run's Job sits Pending forever because the volume is already mounted by the worker on another
node — a failure that appears days after the install and points at nothing.

WHAT THIS CAN AND CANNOT CHECK. It can refuse an install that names no claim; it cannot read the
claim's `accessModes`, because Helm renders without cluster access and the claim may not exist yet.
So the message names the requirement explicitly rather than implying the chart verified it.
*/}}
{{- define "commanderscp.assertRunnerPrerequisites" -}}
{{- if eq .Values.managedRunners.launcher "kubernetes" -}}
{{- if not .Values.managedRunners.kubernetes.workspace.claimName -}}
{{- fail "managedRunners.launcher=kubernetes requires managedRunners.kubernetes.workspace.claimName — the name of an EXISTING ReadWriteMany PersistentVolumeClaim shared by the worker and every runner Job. Kubernetes has no `docker cp`, so the runner's inputs and evidence move through this volume; this chart does not create it because RWX is a storage-class capability you provision (NFS/CephFS/EFS/Azure Files). The chart's own PVCs are ReadWriteOnce and cannot be reused." -}}
{{- end -}}
{{- if ne (include "commanderscp.anyManagedClass" .) "true" -}}
{{- fail "managedRunners.launcher=kubernetes is set but no managed executor class is enabled, so nothing will ever launch. Enable managedIac.enabled (with managedIac.runnerImage) and/or set managedDep.runnerImage and/or set managedScan.runnerImage, or leave managedRunners.launcher at its default of `docker`." -}}
{{- end -}}
{{/*
  M23.5 MEDIUM-7 — THE DEFAULT POSTURE, MADE SAFE RATHER THAN MERELY RECOMMENDED.

  `perRunSecrets: true` (the default since 2026-08-20) grants `create` AND `delete` on `""/secrets`,
  NAMESPACE-WIDE — `resourceNames` cannot scope `create` by name because the per-run name is not
  known to the authorizer at admission time (see the Role's own comment and ADR-0035 §6). The
  Role's comment reasoned carefully about `list`'s blast radius (every Secret BODY in the namespace)
  and was SILENT about `delete`'s — proved with the worker's own token against a live cluster:

    DELETE …/secrets/<this-release's-db-credential> -> {"status":"Success"} ; then GET -> NotFound

  `managedRunners.kubernetes.namespace` is "the narrowing that IS available" per that same comment,
  but until this guard it was a recommendation nobody was made to read: the default install with the
  default `perRunSecrets` handed a worker ServiceAccount the ability to destroy its own release's
  Postgres credential, silently. This makes that combination a render-time refusal instead — set a
  runner namespace, turn `perRunSecrets` off, or state that you accept the blast radius.
*/}}
{{- if and .Values.managedRunners.kubernetes.perRunSecrets (not .Values.managedRunners.kubernetes.namespace) (not .Values.managedRunners.kubernetes.acceptSharedNamespaceSecretDelete) -}}
{{- fail "managedRunners.kubernetes.perRunSecrets=true with no managedRunners.kubernetes.namespace grants the worker ServiceAccount `delete` on EVERY Secret in THIS RELEASE'S OWN NAMESPACE, this release's database credential included (measured: DELETE .../secrets/<db-secret> -> Success). Set managedRunners.kubernetes.namespace to a dedicated runner namespace (the narrowing this Role's RBAC cannot express any other way — see runner-iac.yaml), set managedRunners.kubernetes.perRunSecrets=false if managed-iac's Kubernetes credentials are not needed, or set managedRunners.kubernetes.acceptSharedNamespaceSecretDelete=true to proceed with this release's own Secrets in the blast radius." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
MULTI-CLUSTER SELF-CONSISTENCY GUARD (M26.3 — multi-region-instance-resilience.md §5-I2, §7.4,
B3/B4/B9). `multiCluster.enabled: true` means this release is one member cluster of an instance
that spans more than one Kubernetes cluster. This render can only see ITS OWN values — it cannot
compare this cluster's Secret CONTENT against another cluster's (that equality is an operator
discipline, documented in deploy/helm/MULTI-CLUSTER.md, not a fact Helm can check) — but it CAN
refuse the one thing that is always wrong under that flag: relying on the chart's OWN generated
postgres/appSecrets Secrets, which are single-cluster-only by construction. See values.yaml's
`multiCluster`/`postgres.existingSecret`/`appSecrets.existingSecret` comments for the full B3/B4/B9
reasoning this failure message summarizes.
*/}}
{{- define "commanderscp.assertMultiClusterPrerequisites" -}}
{{- if .Values.multiCluster.enabled -}}
{{- if not .Values.postgres.existingSecret -}}
{{- fail "multiCluster.enabled requires postgres.existingSecret — chart-generated database credentials are single-cluster-only: a second member cluster's install would generate its OWN random scp_app/scp_pgboss passwords, and its migrations Job would try to reset the shared database's live credentials to them (B9). Create the Secret ONCE and set the IDENTICAL postgres.existingSecret name on every member cluster's release. See deploy/helm/MULTI-CLUSTER.md." -}}
{{- end -}}
{{- if not .Values.appSecrets.existingSecret -}}
{{- fail "multiCluster.enabled requires appSecrets.existingSecret — the chart-generated SCP_SECRETS_MASTER_KEY/SCP_COOKIE_SECRET are per-cluster k8s Secrets, not replicated with Postgres. A standby/second cluster promoted without the IDENTICAL key holds every plugin/managed-IaC credential permanently undecryptable, discovered only at first use (B3/B4). Create the Secret ONCE and set the IDENTICAL appSecrets.existingSecret name on every member cluster's release. See deploy/helm/MULTI-CLUSTER.md." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
RETRANS VOLUME PREREQUISITES (M26.3, C4 — multi-region-instance-resilience.md §6/§7.4/§9.4).
Refuses a render that pairs an unattended relay loop with either (a) `volumes.type: pvc` and no
claim name, or (b) a pod-local (`emptyDir`) drop directory shared by MORE THAN ONE replica that
actually runs the worker role — the same predicate `workerRoleVolumeMounts`/`workerRoleVolumes`
use (`commanderscp.podRunsWorkerRole`), summed across both Deployments because either one (or
both, on a mixed `api.role=all` + `worker.replicaCount>0` topology) can run the loops. This is the
WITHIN-ONE-CLUSTER half of the guard the proposal asks for; the ACROSS-MEMBER-CLUSTERS half (a
plain RWX volume essentially never spans clusters) is documented guidance only — see
`federation.relay.volumes`'s values.yaml comment and deploy/helm/MULTI-CLUSTER.md — because no one
release's render can see another cluster's values at all. NO `hostPath` case here, deliberately:
this chart offers only `none`/`emptyDir`/`pvc` (values.yaml's `federation.relay.volumes.type`
comment explains why — the `helm-verify` "socket invariant" gate, M23.6 clause 6, asserts NO
`hostPath:` volume exists anywhere in this chart).
*/}}
{{- define "commanderscp.assertRetransVolumePrerequisites" -}}
{{- $relay := .Values.federation.relay -}}
{{- $anyRelayLoop := or $relay.inbox.enabled $relay.autoRelay.enabled -}}
{{- $volType := $relay.volumes.type | default "none" -}}
{{- if and $anyRelayLoop (eq $volType "pvc") (not $relay.volumes.pvc.claimName) -}}
{{- fail "federation.relay.volumes.type=pvc requires federation.relay.volumes.pvc.claimName — an EXISTING ReadWriteMany PersistentVolumeClaim shared by every replica that runs the worker role. This chart does not create it (RWX is a storage-class capability you provision — NFS/CephFS/EFS/Azure Files/…)." -}}
{{- end -}}
{{- if and $anyRelayLoop (eq $volType "emptyDir") -}}
{{- $apiCount := 0 -}}
{{- if eq (include "commanderscp.podRunsWorkerRole" (dict "root" . "role" "api")) "true" -}}
{{- $apiCount = int .Values.api.replicaCount -}}
{{- end -}}
{{- $workerCount := 0 -}}
{{- if eq (include "commanderscp.podRunsWorkerRole" (dict "root" . "role" "worker")) "true" -}}
{{- $workerCount = int .Values.worker.replicaCount -}}
{{- end -}}
{{- if gt (add $apiCount $workerCount) 1 -}}
{{- fail (printf "federation.relay.{inbox,autoRelay}.enabled with more than one worker-role-capable replica (api.role=all -> %d api replica(s); worker -> %d worker replica(s)) and federation.relay.volumes.type=%q: a multi-replica retrans release cannot use a pod-local drop directory (emptyDir) — each replica sees a DIFFERENT filesystem, so a build claimed by one pod's tick and read by another silently misses it, and a crash after commit strands a submitted artifact with no retry (multi-region-instance-resilience.md §9.4). Set federation.relay.volumes.type: pvc with an existing ReadWriteMany claimName (shared across every replica), or prefer S3-compatible delivery (federation.relay.s3.endpoints), which needs no filesystem volume at all. See deploy/helm/MULTI-CLUSTER.md." $apiCount $workerCount $volType) -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
IS ANY MANAGED EXECUTOR CLASS ENABLED? All THREE of them, and the third one is the point.

`managedScan.runnerImage` is net-new in M23.4 and its absence was a hole rather than a choice: the
server has gated managed-scan on `SCP_MANAGED_SCAN_RUNNER_IMAGE` since M13.3b and this chart never
rendered it, so managed-scan could not be enabled by `helm install` on any launcher. Every predicate
that means "a managed run can happen here" has to name all three, or the class left out gets the
half of the wiring that is keyed on something else and fails at the first call it makes.
*/}}
{{- define "commanderscp.anyManagedClass" -}}
{{- if or .Values.managedIac.enabled (ne (.Values.managedDep.runnerImage | default "") "") (ne (.Values.managedScan.runnerImage | default "") "") -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
WHERE THE RUNNER JOBS, THEIR SECRETS AND THEIR RBAC LIVE.

ONE DEFINITION, USED BY BOTH THE SERVER SETTING AND THE ROLE, and that is the whole reason it is a
helper. `SCP_MANAGED_RUNNER_K8S_NAMESPACE` has been operator-settable since M23.2 while the runner
Role and RoleBinding were rendered, unconditionally, into `.Release.Namespace` — so an operator who
took the chart's own advice and separated the runners got a Role in one namespace and Jobs created
in another, i.e. a 403 on every launch with nothing anywhere saying why. The two now derive from the
same expression and cannot drift.
*/}}
{{- define "commanderscp.runnerNamespace" -}}
{{- .Values.managedRunners.kubernetes.namespace | default .Release.Namespace -}}
{{- end }}

{{- define "commanderscp.needsRunnerApiAccess" -}}
{{- if and (eq .Values.managedRunners.launcher "kubernetes") (eq (include "commanderscp.anyManagedClass" .) "true") -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
=================================================================================================
DOES THIS POD RUN WORKER-ROLE WORK? — and everything a worker-role pod has to mount.
=================================================================================================

M23.5, and it is the SECOND HALF of a predicate this chart already got half right. M23.2 made the
api Deployment's `automountServiceAccountToken` conditional on exactly this question, because
`values.yaml` documents `api.role=all` + `worker.replicaCount: 0` as the supported single-pod
topology and a token-less pod cannot launch a runner. The pod's VOLUMES were left keyed on the
Deployment's NAME instead — `deployment-worker.yaml` mounted the managed-IaC scratch dir and the
shared runner workspace, `deployment-api.yaml` mounted neither, and on that documented topology the
one pod that runs the managed executors is the one with nowhere to write.

THE PROPERTY, RATHER THAN THE THREE INSTANCES. A path this chart puts in an env var and the process
writes to MUST have a volume behind it in EVERY pod that runs the role that writes there. A filterless
read of `commanderscp.commonEnv`'s `*_WORKSPACE_ROOT` variables against both Deployments' volumeMounts
found three holes, only one of which was reported:

  managedRunners.kubernetes.workspace.mountPath  api@role=all: NO MOUNT. Copy-in writes to the api
    container's own filesystem; the runner Job mounts the real claim and finds an empty directory.
    SILENT — `tofu` runs against an empty /workspace and managed-iac's copy-out swallows failures.
  managedIac.workspaceRoot                       api@role=all: NO MOUNT, and `containerSecurityContext.
    readOnlyRootFilesystem` is `true`, so this one is not silent — it is EROFS on the first mkdir.
  managedDep.workspaceRoot                       NEITHER POD, EVER. `managedDepServerSettings()` has
    read SCP_MANAGED_DEP_WORKSPACE_ROOT since M21.5 and `commonEnv` has rendered it since; nothing
    ever mounted anything at `/var/lib/scp/managed-dep`. Same EROFS, on the worker, today.

So the mounts move here, keyed on the ROLE, and both Deployments include the same two helpers. A
fourth path added to `commonEnv` without a mount is then one edit away from being wrong in both pods
at once rather than in whichever one the author did not open.
*/}}
{{- define "commanderscp.podRunsWorkerRole" -}}
{{- if eq .role "worker" -}}
true
{{- else if eq (include "commanderscp.apiRole" .root) "all" -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{- define "commanderscp.workerRoleVolumeMounts" -}}
{{- $root := .root -}}
{{- if eq (include "commanderscp.podRunsWorkerRole" .) "true" -}}
{{- if $root.Values.managedIac.enabled }}
- name: managed-iac-workspace
  mountPath: {{ $root.Values.managedIac.workspaceRoot }}
{{- end }}
{{- if $root.Values.managedDep.runnerImage }}
- name: managed-dep-workspace
  mountPath: {{ $root.Values.managedDep.workspaceRoot }}
{{- end }}
{{- if eq (include "commanderscp.needsRunnerApiAccess" $root) "true" }}
{{- /* THE SHARED RUNNER WORKSPACE (M23.2, owner decision 5). This pod writes each run's inputs into
       a per-run subtree here and the runner Job mounts the SAME volume at subpaths, because
       Kubernetes has no `docker cp` (a ConfigMap fails the 1 MiB etcd limit and `pods/exec` + tar is
       impossible against `apps/runner-dep`'s seven-applet `FROM scratch` image). It MUST be
       ReadWriteMany and it must already exist — `commanderscp.assertRunnerPrerequisites` refuses the
       render otherwise rather than letting a runner Job hang unschedulable, and the chart's own PVCs
       are RWO so none can be reused. */}}
- name: runner-workspace
  mountPath: {{ $root.Values.managedRunners.kubernetes.workspace.mountPath }}
{{- end }}
{{- if ne ($root.Values.federation.relay.volumes.type | default "none") "none" }}
{{- /* M26.3 (C4) — the retrans byte-channel drop directories. ONE volume at a fixed mount path;
       SCP_RELAY_OUT_DIR/IN_DIR/BLOB_OUT_DIR (commonEnv above) stay as subdirectories under it —
       the server itself `mkdir -p`s them on first write, so no init container is needed. Guarded
       against an unsafe pod-local/multi-replica combination by
       `commanderscp.assertRetransVolumePrerequisites`. */}}
- name: retrans-relay
  mountPath: /var/lib/scp/relay
{{- end }}
{{- end -}}
{{- end }}

{{- define "commanderscp.workerRoleVolumes" -}}
{{- $root := .root -}}
{{- if eq (include "commanderscp.podRunsWorkerRole" .) "true" -}}
{{- if $root.Values.managedIac.enabled }}
- name: managed-iac-workspace
  emptyDir: {}
{{- end }}
{{- if $root.Values.managedDep.runnerImage }}
- name: managed-dep-workspace
  emptyDir: {}
{{- end }}
{{- if eq (include "commanderscp.needsRunnerApiAccess" $root) "true" }}
{{- /* AN EXISTING CLAIM, NEVER ONE THIS CHART CREATES. RWX is a storage-class capability an operator
       provisions (NFS, CephFS, EFS, Azure Files, …); a chart that created a PVC and asked for
       ReadWriteMany against a class that cannot serve it would produce a Pending claim and an
       unschedulable runner Job — the "mysterious hang" owner decision 5 asks for a clear failure
       message instead of. */}}
- name: runner-workspace
  persistentVolumeClaim:
    claimName: {{ $root.Values.managedRunners.kubernetes.workspace.claimName | quote }}
{{- end }}
{{- if ne ($root.Values.federation.relay.volumes.type | default "none") "none" }}
{{- /* Only "emptyDir" or "pvc" ever reach here — no `hostPath` case: this chart offers no
       hostPath option at all (see the guard's own doc comment above for why). */}}
- name: retrans-relay
  {{- if eq $root.Values.federation.relay.volumes.type "pvc" }}
  persistentVolumeClaim:
    claimName: {{ $root.Values.federation.relay.volumes.pvc.claimName | quote }}
  {{- else }}
  emptyDir: {}
  {{- end }}
{{- end }}
{{- end -}}
{{- end }}
