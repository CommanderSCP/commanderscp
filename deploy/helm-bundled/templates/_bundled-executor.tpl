{{/*
commanderscp.renderVendoredBackend — render a vendored, UNMODIFIED upstream Mode-B backend manifest
(ADR-0002, docs/proposals/bundled-executor-backends.md) into its own namespace. Shared by the
Argo CD / Argo Workflows / Argo Events bundle templates so the 33k-line render logic lives once.

  - Applies the caller's image-retarget substitutions (`replaces`: a list of [from, to] pairs) —
    the ONLY changes to upstream; bumping a backend = bumping its pinned vendored file.
  - Re-homes every NAMESPACED resource (metadata.namespace) AND every RoleBinding/ClusterRoleBinding
    SUBJECT to the target namespace — surgically, via fromYaml, so no config VALUE that happens to
    mention the upstream namespace is clobbered.
    RoleBinding subjects were MISSED until 2026-09-20: a RoleBinding fell through to the
    metadata-only branch, so upstream Argo Workflows' `argo-binding` moved into the target namespace
    while still naming `ServiceAccount argo` in namespace `argo`, which does not exist here. That
    binding carries `coordination.k8s.io/leases` create/get/update — LEADER ELECTION for the
    workflow-controller — so the bundled backend deployed a controller that could never take
    leadership. A ClusterRoleBinding is cluster-scoped and must NOT gain a metadata.namespace, which
    is why the two kinds share the subject walk but not the metadata write.
  - Passes CustomResourceDefinitions through byte-for-byte (never fromYaml'd — they carry multi-MB
    schemas); ClusterRoles pass through unchanged (cluster-scoped, no namespace).
  - Applies per-container RESOURCES to every Deployment/StatefulSet/DaemonSet, keyed by CONTAINER
    name. Upstream ships all four bundled backends with no requests and no limits on any workload,
    which makes every one BestEffort: unbounded, and first evicted under node pressure. On a
    single-node install the thing they evict is the SCP database.
    Keyed by container rather than workload because the container name is the stable identifier —
    `argocd-redis`'s container is `redis`, and a workload can be renamed upstream without its
    container being renamed. A container with no entry is left exactly as upstream shipped it.
  - Emits the Namespace, then every resource, join'd with clean "\n---\n".

Args (dict): ctx (root context `.`), namespace, component (label), manifest (raw yaml string from
`.Files.Get`), replaces (list of [from, to] pairs), resources (dict: container name -> resource
block; optional), containerArgs (dict: container name -> list of args APPENDED to the vendored
ones; optional). Args are appended rather than replaced so upstream's own invocation is preserved
and only augmented — a replace would silently drop whatever upstream adds in a later version.
*/}}
{{- define "commanderscp.renderVendoredBackend" -}}
{{- $ns := .namespace -}}
{{- $res := (.resources | default dict) -}}
{{- $extraArgs := (.containerArgs | default dict) -}}
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
{{- if or (eq $kind "ClusterRoleBinding") (eq $kind "RoleBinding") -}}
{{- $subs := list -}}
{{- range $s := ($obj.subjects | default (list)) -}}
{{- if $s.namespace -}}{{- $_ := set $s "namespace" $ns -}}{{- end -}}
{{- $subs = append $subs $s -}}
{{- end -}}
{{- $_ := set $obj "subjects" $subs -}}
{{- if eq $kind "RoleBinding" -}}{{- $_ := set $obj.metadata "namespace" $ns -}}{{- end -}}
{{- else if ne $kind "ClusterRole" -}}
{{- $_ := set $obj.metadata "namespace" $ns -}}
{{- end -}}
{{- if or (eq $kind "Deployment") (eq $kind "StatefulSet") (eq $kind "DaemonSet") -}}
{{- $podSpec := ((($obj.spec).template).spec) -}}
{{- if $podSpec -}}
{{- range $field := (list "containers" "initContainers") -}}
{{- $walked := list -}}
{{- range $c := ((index $podSpec $field) | default (list)) -}}
{{- $entry := index $res ($c.name | default "") -}}
{{- if $entry -}}{{- $_ := set $c "resources" $entry -}}{{- end -}}
{{- $extra := index $extraArgs ($c.name | default "") -}}
{{- if $extra -}}{{- $_ := set $c "args" (concat ($c.args | default (list)) $extra) -}}{{- end -}}
{{- $walked = append $walked $c -}}
{{- end -}}
{{- if $walked -}}{{- $_ := set $podSpec $field $walked -}}{{- end -}}
{{- end -}}
{{- end -}}
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
