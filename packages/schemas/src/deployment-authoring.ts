import { z } from "zod";

/** M28.4 — the declarations SCP reads when it AUTHORS a deployment (ADR-0055).
 *
 *  Three documents, each on the graph object that owns the fact, none of them a new table:
 *
 *  - WHAT runs: `component.properties.deployment` (`AuthoredDeploymentSchema`).
 *  - HOW each place rolls: the release topology's per-wave `rollout` (`RolloutStrategySchema`,
 *    `pipeline-behaviors.ts`) — the wave plan the Rollout's steps are derived from.
 *  - WHERE Argo CD reads the authored manifests from: `execution-system.properties.authoring`
 *    (`ArgoCdAuthoringSourceSchema`) — the operator-installed carrier chart.
 *
 *  Validated when the deploy lane DERIVES, not when the object is written: every one of these
 *  object types is registered `{"type":"object"}`, and typing a key at the write door is the
 *  version-skew hazard migration 0075 §2a declined. A bad declaration is refused at trigger time
 *  with a Decision naming the key, never silently skipped. */

/** The component property key holding `AuthoredDeploymentSchema`. */
export const AUTHORED_DEPLOYMENT_PROPERTY = "deployment";

/** The execution-system property key holding `ArgoCdAuthoringSourceSchema`. */
export const ARGOCD_AUTHORING_PROPERTY = "authoring";

/** The label every SCP-authored Application and Rollout carries, and the ONLY thing that lets
 *  `@scp/plugin-argocd` update an Application: one that lacks it was authored by someone else, and
 *  SCP refuses to overwrite it. Duplicated as a string literal in the plugin (which takes no
 *  `@scp/schemas` dependency) and pinned equal by a test that imports both. */
export const SCP_AUTHORED_LABEL_KEY = "commanderscp.io/authored";
export const SCP_AUTHORED_LABEL_VALUE = "true";

/** An RFC 1123 label — a Kubernetes namespace, and the shape every authored name is folded into. */
export const Dns1123LabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, "must be an RFC 1123 label (lowercase a-z, 0-9, '-')");

export const AuthoredDeploymentSchema = z.strictObject({
  /** The image the Rollout runs. When the change carries exactly one OCI digest, the authored
   *  manifest pins `<image without tag>@<digest>` instead — the artifact this release IS. */
  image: z.string().min(1).max(512).regex(/^\S+$/, "must not contain whitespace"),
  containerPort: z.number().int().min(1).max(65535).optional(),
  replicas: z.number().int().min(1).max(1000).optional(),
  /** Absent ⇒ the deployment-target's `properties.namespace`, else the component's folded name. */
  namespace: Dns1123LabelSchema.optional()
});
export type AuthoredDeployment = z.infer<typeof AuthoredDeploymentSchema>;

/** Where the operator installed SCP's pass-through carrier chart
 *  (`deploy/helm-bundled/authoring/scp-authored-manifests`), in Argo CD's own source vocabulary:
 *  `path` for a chart kept in a git repository, `chart` for one in a Helm repository — exactly one. */
export const ArgoCdAuthoringSourceSchema = z
  .strictObject({
    repoURL: z.string().min(1),
    path: z.string().min(1).optional(),
    chart: z.string().min(1).optional(),
    /** REQUIRED: a carrier that floats with HEAD is a carrier nobody reviewed. */
    targetRevision: z.string().min(1),
    /** The Argo CD project every authored Application is created in. Absent ⇒ `default`. */
    project: z.string().min(1).optional()
  })
  .refine((s) => (s.path === undefined) !== (s.chart === undefined), {
    message:
      "declare exactly one of `path` (a chart in a git repository) or `chart` (a Helm repository)"
  });
export type ArgoCdAuthoringSource = z.infer<typeof ArgoCdAuthoringSourceSchema>;
