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
*/}}
{{- define "commanderscp.egressToBlock" -}}
{{- if . -}}
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
{{- if .Values.managedIac.enabled }}
- name: SCP_MANAGED_IAC_RUNNER_IMAGE
  value: {{ .Values.managedIac.runnerImage | quote }}
- name: SCP_MANAGED_IAC_NETWORK_MODE
  value: {{ .Values.managedIac.networkMode | quote }}
- name: SCP_MANAGED_IAC_WORKSPACE_ROOT
  value: {{ .Values.managedIac.workspaceRoot | quote }}
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
