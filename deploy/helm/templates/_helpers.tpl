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
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
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
