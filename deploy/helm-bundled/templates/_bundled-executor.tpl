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
{{- end }}
{{/* The newline above is LOAD-BEARING — `{{- end }}`, not `{{- end -}}`.

     This helper's output STARTS with `apiVersion: v1`, and every caller reaches it through a run of
     `{{- ... -}}` actions that chomp the newline after their own leading comment block. With the
     newline also chomped here, the emitted text was appended DIRECTLY onto the caller's last
     comment line:

         # =========================================================apiVersion: v1
         kind: Namespace

     — so `apiVersion` was swallowed by a YAML comment and the Namespace document began at `kind:`.
     `kubectl apply` then refused the whole stream with "error validating data: apiVersion not set",
     which reads like a malformed vendored manifest rather than a whitespace bug in a template.

     MEASURED 2026-08-29: it broke ALL THREE callers of this helper (argo-workflows, argo-events,
     gitea) — every backend rendered a Namespace with no apiVersion. Argo CD was unaffected only
     because it does not use this helper. It surfaced as the air-gap drill failing on argo-workflows
     the moment the Argo CD egress bug ahead of it was fixed.

     Fixed HERE rather than in the three callers: the helper owns emitting this document, so the
     newline it needs is its own invariant. tools/helm-verify asserts every rendered doc carries an
     apiVersion, so a regression is a red gate rather than a drill failure days later.

     NOTE FOR ANYONE MUTATION-TESTING THIS: the newline is now supplied TWICE — by the `{{- end }}`
     above AND by this comment block's own trailing newline. Either alone is sufficient, so flipping
     just one back does NOT reproduce the bug and the guard correctly stays green. That is redundant
     defence, not a weak test. To see the real failure, render against the pre-fix helper
     (`git show <commit>^:deploy/helm-bundled/templates/_bundled-executor.tpl`) — which is how the
     helm-verify guard was actually proven to fire. */}}
apiVersion: v1
kind: Namespace
metadata:
  name: {{ $ns }}
  labels:
    {{- include "commanderscp.labels" .ctx | nindent 4 }}
    app.kubernetes.io/component: {{ .component }}
    # M15.4 metadata (see values.yaml federationRole): the operator's declared federation role,
    # stamped here so the chart-render-time guardrail lint (tools/helm-verify) can read the role
    # straight from the render and check it against the enabled bundled backends. Not runtime authority.
    commanderscp.io/federation-role: {{ include "commanderscp.federationRole" .ctx }}
---
{{ $out | join "\n---\n" }}
{{- end -}}
