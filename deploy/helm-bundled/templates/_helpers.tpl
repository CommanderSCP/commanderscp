{{/*
Helper subset for the bundled-backends chart — the same names the main `commanderscp` chart defines
(templates/_helpers.tpl), so the vendored-backend render templates (moved here verbatim) resolve
`commanderscp.labels` / `commanderscp.selectorLabels` / `commanderscp.fullname` unchanged. The
version label uses `.Chart.AppVersion` directly (this chart has no `.Values.image`), and there is no
digest-in-label hazard here because these labels annotate SCP's OWN wrapper resources, never the
vendored upstream objects (whose images the render helper retargets independently).
*/}}
{{- define "commanderscp.name" -}}
{{- default "commanderscp-bundled" .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "commanderscp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "commanderscp-bundled" .Values.nameOverride -}}
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
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "commanderscp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "commanderscp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
