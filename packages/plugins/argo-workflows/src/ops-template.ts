/**
 * THE EXACT SHAPE OF `scp-ops-v1` (M28.2, ADR-0054 D9(d)) — what the argo-workflows plugin
 * requires of the WorkflowTemplate it reads back before submitting a sealed host-ops run token.
 *
 * An ALLOWLIST, not a list of known-bad fields. #414's re-verification submitted four bypasses
 * past the first (denylist) version, each with the pinned image and `SCP_OPS_CATALOG_VERIFY=required`
 * intact: a `command` override running `python -c`; a `steps` entrypoint calling an external
 * `templateRef`; `SCP_OPS_CATALOG_PUBKEY`/`SCP_OPS_CATALOG_DIR` pointed at an attacker volume; and an
 * `onExit` `dag` with an external `templateRef`. Each passed because the check enumerated what it
 * feared rather than what the chart renders. So this enumerates what the chart renders — every key,
 * every env name and value, every volume and mount — and refuses anything else.
 *
 * THE SAME FUNCTION CHECKS THE CHART. `tools/helm-verify` renders
 * `deploy/helm-bundled/templates/argo-workflows-ops-catalog.yaml` and asserts this returns no
 * problems for it, so the chart and the runtime check cannot drift apart silently: a chart change
 * that this function would refuse fails the build rather than every run.
 *
 * WHAT THIS IS NOT: attestation. A cluster admin or a WorkflowTemplate editor can change the template
 * between this read and the pod's start, and can run any pod with the sealing Secret mounted. It
 * makes "the template SCP read was SCP's template" true; it cannot make "the pod that redeems ran
 * it" true. ADR-0054 names those parties as the residual trust set.
 */

/** SCP's host-ops catalog template names. */
export const SCP_OPS_TEMPLATE_PATTERN = /^scp-ops-v\d+$/;

/** Prefix of every read-back refusal, so the server can terminalise the target with a Decision
 *  rather than retrying (the message crosses the plugin-host RPC boundary; this is the one stable
 *  part of it). */
export const OPS_TEMPLATE_REFUSED_MARKER = "scp-ops-template-refused:";

/** One spelling of an endpoint URL. The server's `normalizeServerUrl` is the same function, asserted
 *  equal by `ops-argo-pin.test.ts`. Scheme, host (lower-cased), port and path (trailing `/` dropped). */
export function normalizeOpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

export interface OpsTemplatePin {
  serverUrl: string;
  namespace: string;
  templateRef: string;
  runnerImageDigest: string;
  redeemUrl: string;
}

const SEALING_KEY_FILE = "/var/run/scp-ops/sealing/sealing-key.pem";
const CATALOG_PUBKEY = "/var/run/scp-ops/catalog/cosign.pub";
const API_CA_FILE = "/var/run/scp-ops/api-ca/ca.crt";
const TOKEN_PARAM = "{{inputs.parameters.opsRunTokenSealed}}";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Inert values Argo's API may serialise for an unset field (`{}`, `[]`, null). */
const isEmpty = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (Array.isArray(v) && v.length === 0) ||
  (isObj(v) && Object.keys(v).length === 0);

function onlyKeys(where: string, o: Obj, allowed: readonly string[], problems: string[]): void {
  for (const [k, v] of Object.entries(o)) {
    if (!allowed.includes(k) && !isEmpty(v))
      problems.push(`${where} has '${k}', which scp-ops-v1 does not`);
  }
}

function exact(where: string, actual: unknown, expected: unknown, problems: string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(`${where} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`);
  }
}

function paramNames(where: string, v: unknown, allowValue: boolean, problems: string[]): void {
  const params = isObj(v) && Array.isArray(v["parameters"]) ? (v["parameters"] as unknown[]) : [];
  if (isObj(v)) onlyKeys(where, v, ["parameters"], problems);
  const names = params.map((p) => (isObj(p) ? p["name"] : undefined)).sort();
  exact(`${where}.parameters names`, names, ["opsRunId", "opsRunTokenSealed"], problems);
  for (const p of params) {
    if (!isObj(p)) continue;
    onlyKeys(
      `${where}.parameters[${String(p["name"])}]`,
      p,
      allowValue ? ["name", "value"] : ["name"],
      problems
    );
    if (allowValue && p["value"] !== undefined && p["value"] !== "") {
      problems.push(`${where}.parameters[${String(p["name"])}] has a default value`);
    }
  }
}

/**
 * Every way `template` differs from the scp-ops-v1 the chart renders. Empty means it matches.
 * `expected.runnerImageDigest` and `expected.redeemUrl` come from the domain's pin.
 */
export function opsTemplateShapeProblems(
  template: unknown,
  expected: { runnerImageDigest: string; redeemUrl: string }
): string[] {
  const problems: string[] = [];
  const spec = isObj(template) && isObj(template["spec"]) ? template["spec"] : undefined;
  if (!spec) return ["the template has no spec"];

  onlyKeys(
    "spec",
    spec,
    [
      "serviceAccountName",
      "entrypoint",
      "activeDeadlineSeconds",
      "podMetadata",
      "securityContext",
      "arguments",
      "templates"
    ],
    problems
  );
  if (typeof spec["serviceAccountName"] !== "string")
    problems.push("spec.serviceAccountName is not set");
  const deadline = spec["activeDeadlineSeconds"];
  if (typeof deadline !== "number" || deadline <= 0 || deadline > 600) {
    problems.push(`spec.activeDeadlineSeconds is ${String(deadline)}, not within (0, 600]`);
  }
  // podMetadata: labels only, and the one the egress policy selects on.
  const podMetadata = spec["podMetadata"];
  if (!isObj(podMetadata)) problems.push("spec.podMetadata is missing");
  else {
    onlyKeys("spec.podMetadata", podMetadata, ["labels"], problems);
    const labels = isObj(podMetadata["labels"]) ? podMetadata["labels"] : {};
    if (labels["commanderscp.io/catalog"] !== "ops") {
      problems.push(
        "spec.podMetadata.labels lacks commanderscp.io/catalog=ops (the egress policy's selector)"
      );
    }
  }
  // The pod security context, exactly as the chart renders it.
  const psc = spec["securityContext"];
  if (!isObj(psc)) problems.push("spec.securityContext is missing");
  else {
    onlyKeys(
      "spec.securityContext",
      psc,
      ["runAsNonRoot", "runAsUser", "runAsGroup", "fsGroup", "seccompProfile"],
      problems
    );
    exact("spec.securityContext.runAsNonRoot", psc["runAsNonRoot"], true, problems);
    for (const k of ["runAsUser", "runAsGroup", "fsGroup"]) {
      if (typeof psc[k] !== "number" || (psc[k] as number) <= 0)
        problems.push(`spec.securityContext.${k} is not a non-root id`);
    }
    exact(
      "spec.securityContext.seccompProfile",
      psc["seccompProfile"],
      { type: "RuntimeDefault" },
      problems
    );
  }
  paramNames("spec.arguments", spec["arguments"], true, problems);

  // ONE container template, which is the entrypoint. No steps, dag, onExit, hooks, templateRef.
  const templates = Array.isArray(spec["templates"]) ? (spec["templates"] as unknown[]) : [];
  if (templates.length !== 1 || !isObj(templates[0])) {
    problems.push(`spec.templates has ${templates.length} entries; scp-ops-v1 has exactly one`);
    return problems;
  }
  const t = templates[0];
  if (t["name"] !== spec["entrypoint"]) problems.push("the single template is not the entrypoint");
  onlyKeys(
    `template '${String(t["name"])}'`,
    t,
    ["name", "inputs", "volumes", "container"],
    problems
  );
  paramNames("template.inputs", t["inputs"], false, problems);

  const volumes = Array.isArray(t["volumes"]) ? (t["volumes"] as unknown[]).filter(isObj) : [];
  const byName = new Map(volumes.map((v) => [String(v["name"]), v]));
  const hasCa = byName.has("api-ca");
  exact(
    "template.volumes names",
    [...byName.keys()].sort(),
    ["catalog-pubkey", "sealing", "tmp", "work", ...(hasCa ? ["api-ca"] : [])].sort(),
    problems
  );
  for (const v of volumes) {
    const name = String(v["name"]);
    if (name === "work" || name === "tmp") {
      onlyKeys(`volume '${name}'`, v, ["name", "emptyDir"], problems);
      if (!isEmpty(v["emptyDir"]) && !isObj(v["emptyDir"]))
        problems.push(`volume '${name}' is not an emptyDir`);
      if (!("emptyDir" in v)) problems.push(`volume '${name}' is not an emptyDir`);
    } else {
      onlyKeys(`volume '${name}'`, v, ["name", "secret"], problems);
      const secret = v["secret"];
      if (!isObj(secret) || typeof secret["secretName"] !== "string") {
        problems.push(`volume '${name}' is not a Secret volume`);
      } else {
        onlyKeys(`volume '${name}'.secret`, secret, ["secretName", "defaultMode"], problems);
      }
    }
  }

  const c = t["container"];
  if (!isObj(c)) {
    problems.push("the template has no container");
    return problems;
  }
  onlyKeys(
    "container",
    c,
    ["name", "image", "command", "securityContext", "env", "volumeMounts", "resources"],
    problems
  );
  if (c["name"] !== undefined && c["name"] !== "main")
    problems.push("container.name is not 'main'");
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(
    typeof c["image"] === "string" ? c["image"] : ""
  )?.[1];
  if (digest !== expected.runnerImageDigest) {
    problems.push(
      `container.image '${String(c["image"])}' is not the pinned ${expected.runnerImageDigest}`
    );
  }
  exact("container.command", c["command"], ["/usr/local/bin/run.sh"], problems);

  const csc = c["securityContext"];
  exact(
    "container.securityContext (except ids)",
    isObj(csc)
      ? {
          allowPrivilegeEscalation: csc["allowPrivilegeEscalation"],
          capabilities: csc["capabilities"],
          privileged: csc["privileged"],
          readOnlyRootFilesystem: csc["readOnlyRootFilesystem"],
          runAsNonRoot: csc["runAsNonRoot"],
          seccompProfile: csc["seccompProfile"]
        }
      : null,
    {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" }
    },
    problems
  );
  if (isObj(csc)) {
    onlyKeys(
      "container.securityContext",
      csc,
      [
        "runAsNonRoot",
        "runAsUser",
        "runAsGroup",
        "readOnlyRootFilesystem",
        "allowPrivilegeEscalation",
        "privileged",
        "seccompProfile",
        "capabilities"
      ],
      problems
    );
    for (const k of ["runAsUser", "runAsGroup"]) {
      if (typeof csc[k] !== "number" || (csc[k] as number) <= 0)
        problems.push(`container.securityContext.${k} is not a non-root id`);
    }
  }

  // ENV: exactly these names, each with its fixed value (the API URL must be the pinned one).
  const env = Array.isArray(c["env"]) ? (c["env"] as unknown[]) : [];
  const want: Record<string, (v: unknown) => boolean> = {
    SCP_OPS_API_URL: (v) => normalizeOpsUrl(v) === normalizeOpsUrl(expected.redeemUrl),
    SCP_OPS_RUN_TOKEN_SEALED: (v) => v === TOKEN_PARAM,
    SCP_OPS_SEALING_KEY_FILE: (v) => v === SEALING_KEY_FILE,
    SCP_OPS_CATALOG_VERIFY: (v) => v === "required",
    SCP_OPS_CATALOG_PUBKEY: (v) => v === CATALOG_PUBKEY,
    HOME: (v) => v === "/work",
    ...(hasCa ? { SCP_OPS_API_CA_FILE: (v: unknown) => v === API_CA_FILE } : {})
  };
  const seen = new Set<string>();
  for (const e of env) {
    if (!isObj(e) || typeof e["name"] !== "string") {
      problems.push("container.env has a malformed entry");
      continue;
    }
    const name = e["name"];
    onlyKeys(`container.env[${name}]`, e, ["name", "value"], problems);
    if (seen.has(name)) problems.push(`container.env sets ${name} twice`);
    seen.add(name);
    const check = want[name];
    if (!check) problems.push(`container.env sets ${name}, which scp-ops-v1 does not`);
    else if (!check(e["value"]))
      problems.push(
        `container.env ${name} is ${JSON.stringify(e["value"])}, not the pinned/fixed value`
      );
  }
  for (const name of Object.keys(want))
    if (!seen.has(name)) problems.push(`container.env does not set ${name}`);

  // MOUNTS: exactly the chart's, at the chart's paths, read-only where the chart says.
  const mounts = Array.isArray(c["volumeMounts"])
    ? (c["volumeMounts"] as unknown[]).filter(isObj)
    : [];
  const wantMounts: Record<string, { mountPath: string; readOnly: boolean }> = {
    work: { mountPath: "/work", readOnly: false },
    tmp: { mountPath: "/tmp", readOnly: false },
    sealing: { mountPath: "/var/run/scp-ops/sealing", readOnly: true },
    "catalog-pubkey": { mountPath: "/var/run/scp-ops/catalog", readOnly: true },
    ...(hasCa ? { "api-ca": { mountPath: "/var/run/scp-ops/api-ca", readOnly: true } } : {})
  };
  exact(
    "container.volumeMounts names",
    mounts.map((m) => String(m["name"])).sort(),
    Object.keys(wantMounts).sort(),
    problems
  );
  for (const m of mounts) {
    const w = wantMounts[String(m["name"])];
    if (!w) continue;
    onlyKeys(`volumeMount '${String(m["name"])}'`, m, ["name", "mountPath", "readOnly"], problems);
    exact(`volumeMount '${String(m["name"])}'.mountPath`, m["mountPath"], w.mountPath, problems);
    if (Boolean(m["readOnly"]) !== w.readOnly)
      problems.push(`volumeMount '${String(m["name"])}' readOnly is not ${w.readOnly}`);
  }
  const resources = c["resources"];
  if (isObj(resources))
    onlyKeys("container.resources", resources, ["requests", "limits"], problems);
  return problems;
}

/** The pins this running instance may submit an ops template under: its OWN server and namespace
 *  (the running instance's config, not what reconcile believes it is) and the template name. */
export function pinsForInstance(
  pins: unknown,
  instance: { serverUrl: string; namespace: string },
  templateName: string
): OpsTemplatePin[] {
  if (!Array.isArray(pins)) return [];
  const own = normalizeOpsUrl(instance.serverUrl);
  return (pins as OpsTemplatePin[]).filter(
    (p) =>
      isObj(p) &&
      normalizeOpsUrl(p.serverUrl) === own &&
      p.namespace === instance.namespace &&
      p.templateRef === templateName
  );
}

/**
 * scp-ops-v1 as the chart renders it (as JSON), for a given pin. A REFERENCE, used by the tests of
 * every layer that must agree with the chart; `tools/helm-verify` checks the actual render with
 * `opsTemplateShapeProblems`, which is what makes this and the chart the same thing.
 */
export function scpOpsV1ReferenceTemplate(pin: {
  runnerImageDigest: string;
  redeemUrl: string;
}): Record<string, unknown> {
  return {
    metadata: { name: "scp-ops-v1" },
    spec: {
      serviceAccountName: "scp-ops",
      entrypoint: "run",
      activeDeadlineSeconds: 600,
      podMetadata: { labels: { "commanderscp.io/catalog": "ops" } },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" }
      },
      arguments: { parameters: [{ name: "opsRunTokenSealed" }, { name: "opsRunId", value: "" }] },
      templates: [
        {
          name: "run",
          inputs: { parameters: [{ name: "opsRunTokenSealed" }, { name: "opsRunId" }] },
          volumes: [
            { name: "work", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
            { name: "sealing", secret: { secretName: "scp-ops-sealing", defaultMode: 288 } },
            {
              name: "catalog-pubkey",
              secret: { secretName: "scp-ops-catalog-pubkey", defaultMode: 288 }
            }
          ],
          container: {
            image: `registry.example.com/scp/scp-runner-ops:v1@${pin.runnerImageDigest}`,
            command: ["/usr/local/bin/run.sh"],
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              privileged: false,
              seccompProfile: { type: "RuntimeDefault" },
              capabilities: { drop: ["ALL"] }
            },
            env: [
              { name: "SCP_OPS_API_URL", value: pin.redeemUrl },
              {
                name: "SCP_OPS_RUN_TOKEN_SEALED",
                value: "{{inputs.parameters.opsRunTokenSealed}}"
              },
              {
                name: "SCP_OPS_SEALING_KEY_FILE",
                value: "/var/run/scp-ops/sealing/sealing-key.pem"
              },
              { name: "SCP_OPS_CATALOG_VERIFY", value: "required" },
              { name: "SCP_OPS_CATALOG_PUBKEY", value: "/var/run/scp-ops/catalog/cosign.pub" },
              { name: "HOME", value: "/work" }
            ],
            volumeMounts: [
              { name: "work", mountPath: "/work" },
              { name: "tmp", mountPath: "/tmp" },
              { name: "sealing", mountPath: "/var/run/scp-ops/sealing", readOnly: true },
              { name: "catalog-pubkey", mountPath: "/var/run/scp-ops/catalog", readOnly: true }
            ],
            resources: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { cpu: "1", memory: "1Gi" }
            }
          }
        }
      ]
    }
  };
}
