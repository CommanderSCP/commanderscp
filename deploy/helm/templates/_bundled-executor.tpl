{{/*
commanderscp.renderVendoredBackend — render a vendored, UNMODIFIED upstream Mode-B backend manifest
(ADR-0002, docs/proposals/bundled-executor-backends.md) into its own namespace. Shared by the
Argo CD / Argo Workflows / Argo Events bundle templates so the 33k-line render logic lives once.

  - Applies the caller's image-retarget substitutions (`replaces`: a list of [from, to] pairs) —
    the ONLY changes to upstream; bumping a backend = bumping its pinned vendored file.
  - Re-homes every NAMESPACED resource (metadata.namespace) AND every ClusterRoleBinding SUBJECT to
    the target namespace — surgically, via fromYaml, so no config VALUE that happens to mention the
    upstream namespace is clobbered.
  - Passes CustomResourceDefinitions through byte-for-byte (never fromYaml'd — they carry multi-MB
    schemas); ClusterRoles pass through unchanged (cluster-scoped, no namespace).
  - Emits the Namespace, then every resource, join'd with clean "\n---\n".

Args (dict): ctx (root context `.`), namespace, component (label), manifest (raw yaml string from
`.Files.Get`), replaces (list of [from, to] pairs).
*/}}
{{- define "commanderscp.renderVendoredBackend" -}}
{{- $ns := .namespace -}}
{{- $raw := .manifest -}}
{{- range $pair := (.replaces | default (list)) -}}
{{- $raw = $raw | replace (index $pair 0) (index $pair 1) -}}
{{- end -}}
{{- $out := list -}}
{{- range $doc := splitList "\n---\n" $raw -}}
{{- $t := trim $doc -}}
{{- if $t -}}
{{- $kind := $t | regexFind "(?m)^kind: [A-Za-z]+" | trimPrefix "kind: " | trim -}}
{{- if eq $kind "CustomResourceDefinition" -}}
{{- $out = append $out $t -}}
{{- else if $kind -}}
{{- $obj := fromYaml $t -}}
{{- if eq $kind "ClusterRoleBinding" -}}
{{- $subs := list -}}
{{- range $s := ($obj.subjects | default (list)) -}}
{{- if $s.namespace -}}{{- $_ := set $s "namespace" $ns -}}{{- end -}}
{{- $subs = append $subs $s -}}
{{- end -}}
{{- $_ := set $obj "subjects" $subs -}}
{{- else if ne $kind "ClusterRole" -}}
{{- $_ := set $obj.metadata "namespace" $ns -}}
{{- end -}}
{{- $out = append $out (trim (toYaml $obj)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
apiVersion: v1
kind: Namespace
metadata:
  name: {{ $ns }}
  labels:
    {{- include "commanderscp.labels" .ctx | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
---
{{ $out | join "\n---\n" }}
{{- end -}}
