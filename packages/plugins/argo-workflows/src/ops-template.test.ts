import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import nock from "nock";
import type { PluginContext } from "@scp/plugin-api";
import { createArgoWorkflowsExecutorPlugin } from "./index.js";
import { createNodeHttpTestClient } from "./test-node-http-client.js";
import {
  OPS_TEMPLATE_REFUSED_MARKER,
  opsTemplateShapeProblems,
  scpOpsV1ReferenceTemplate
} from "./ops-template.js";

/**
 * THE scp-ops-v1 READ-BACK, through the REAL plugin's trigger (M28.2 fix rounds, ADR-0054 D9(d)).
 *
 * T1–T4 are the four bypasses #414's re-verification submitted past the first, denylist version —
 * each with the pinned image and `SCP_OPS_CATALOG_VERIFY=required` intact. They are permanent here,
 * beside the control (the chart's own shape submits) and the rest of the allowlist's edges.
 */

const SERVER_URL = "http://argo-workflows.test";
const NS = "scp-argo-workflows";
const DIGEST = `sha256:${"a".repeat(64)}`;
const API_URL = "http://commanderscp-api.scp.svc:8080";
const PIN = {
  serverUrl: SERVER_URL,
  namespace: NS,
  templateRef: "scp-ops-v1",
  runnerImageDigest: DIGEST,
  redeemUrl: API_URL
};

/** scp-ops-v1 exactly as deploy/helm-bundled renders it (helm-verify asserts the chart matches). */
function chartShape(): Record<string, unknown> {
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
            image: `registry.example.com/scp/scp-runner-ops:v1@${DIGEST}`,
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
              { name: "SCP_OPS_API_URL", value: API_URL },
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

/** The fixture is edited by path in each case below (that is the point of a mutation table), so it
 *  is typed as deliberately loose JSON rather than restating the whole template type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = any;
type Tpl = ReturnType<typeof chartShape> & { spec: Record<string, LooseJson> };
const mutate = (fn: (t: Tpl) => void): Tpl => {
  const t = chartShape() as Tpl;
  fn(t);
  return t;
};
const container = (t: Tpl): Record<string, LooseJson> => t.spec.templates[0].container;

function ctx(extra: Record<string, unknown> = {}): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "d",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createNodeHttpTestClient(),
    config: {
      serverUrl: SERVER_URL,
      namespace: NS,
      token: "t",
      statePath: join(tmpdir(), `ops-template-${randomUUID()}.json`),
      opsTemplatePins: [PIN],
      ...extra
    }
  };
}

async function outcome(template: unknown, extraConfig: Record<string, unknown> = {}) {
  nock(SERVER_URL)
    .get(`/api/v1/workflow-templates/${NS}/scp-ops-v1`)
    .reply(200, template as never);
  const submit = nock(SERVER_URL)
    .post(`/api/v1/workflows/${NS}/submit`)
    .reply(200, { metadata: { name: "scp-ops-v1-x", uid: "u" } });
  try {
    await createArgoWorkflowsExecutorPlugin().trigger(ctx(extraConfig), {
      kind: "workflow_dispatch",
      targetRef: "scp-ops-v1",
      idempotencyKey: randomUUID(),
      parameters: { opsRunTokenSealed: "c", opsRunId: "r" }
    } as never);
  } catch (e) {
    return { submitted: submit.isDone(), refused: (e as Error).message };
  }
  return { submitted: submit.isDone(), refused: undefined };
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe("scp-ops-v1 read-back: an EXACT allowlist of the chart's shape", () => {
  it("the exported reference IS this file's independent copy of the chart's shape", () => {
    expect(scpOpsV1ReferenceTemplate(PIN)).toEqual(chartShape());
  });

  it("CONTROL: the chart's own shape submits", async () => {
    expect(opsTemplateShapeProblems(chartShape(), PIN)).toEqual([]);
    const r = await outcome(chartShape());
    expect(r.refused).toBeUndefined();
    expect(r.submitted).toBe(true);
  });

  const BYPASSES: [string, Tpl][] = [
    [
      "T1: the pinned image with a `command` override",
      mutate((t) => {
        container(t).command = ["python", "-c", "exfil()"];
      })
    ],
    [
      "T2: a `steps` entrypoint calling an external templateRef",
      mutate((t) => {
        t.spec.entrypoint = "main";
        t.spec.templates.push({
          name: "main",
          steps: [[{ name: "s", templateRef: { name: "org-evil", template: "x" } }]]
        });
      })
    ],
    [
      "T3: SCP_OPS_CATALOG_PUBKEY / SCP_OPS_CATALOG_DIR redirected beside VERIFY=required",
      mutate((t) => {
        const env = container(t).env as { name: string; value: string }[];
        env.find((e) => e.name === "SCP_OPS_CATALOG_PUBKEY")!.value = "/evil/cosign.pub";
        env.push({ name: "SCP_OPS_CATALOG_DIR", value: "/evil/catalog" });
      })
    ],
    [
      "T4: an onExit dag with an external templateRef",
      mutate((t) => {
        t.spec.onExit = "exit";
        t.spec.templates.push({
          name: "exit",
          dag: { tasks: [{ name: "t", templateRef: { name: "org-evil", template: "x" } }] }
        });
      })
    ],
    [
      "a second template, even one nothing references",
      mutate((t) => void t.spec.templates.push({ name: "spare", container: { image: "evil" } }))
    ],
    ["args appended", mutate((t) => void (container(t).args = ["--x"]))],
    [
      "an extra env var",
      mutate((t) => void container(t).env.push({ name: "PYTHONSTARTUP", value: "/x" }))
    ],
    [
      "an env value from a Secret",
      mutate((t) => {
        container(t).env[0] = {
          name: "SCP_OPS_API_URL",
          valueFrom: { secretKeyRef: { name: "x", key: "y" } }
        };
      })
    ],
    [
      "the API URL pointed elsewhere (the pod would hand another server the token)",
      mutate((t) => void (container(t).env[0].value = "http://evil.example.test"))
    ],
    [
      "a different image digest",
      mutate((t) => void (container(t).image = `x@sha256:${"b".repeat(64)}`))
    ],
    ["an image by tag only", mutate((t) => void (container(t).image = "x:latest"))],
    [
      "an initContainer",
      mutate((t) => void (t.spec.templates[0].initContainers = [{ name: "i", image: "evil" }]))
    ],
    [
      "a sidecar",
      mutate((t) => void (t.spec.templates[0].sidecars = [{ name: "s", image: "evil" }]))
    ],
    ["a workflow podSpecPatch", mutate((t) => void (t.spec.podSpecPatch = "{}"))],
    ["hooks", mutate((t) => void (t.spec.hooks = { exit: { template: "run" } }))],
    [
      "an extra volume",
      mutate((t) => void t.spec.templates[0].volumes.push({ name: "h", hostPath: { path: "/" } }))
    ],
    [
      "a mount moved over /catalog",
      mutate((t) => void (container(t).volumeMounts[1].mountPath = "/catalog"))
    ],
    [
      "a Secret mounted writable",
      mutate((t) => void (container(t).volumeMounts[2].readOnly = false))
    ],
    [
      "privilege escalation allowed",
      mutate((t) => void (container(t).securityContext.allowPrivilegeEscalation = true))
    ],
    [
      "a capability added",
      mutate((t) => void (container(t).securityContext.capabilities.add = ["NET_ADMIN"]))
    ],
    [
      "root filesystem writable",
      mutate((t) => void (container(t).securityContext.readOnlyRootFilesystem = false))
    ],
    [
      "pod annotations (e.g. sidecar injection)",
      mutate((t) => void (t.spec.podMetadata.annotations = { a: "b" }))
    ],
    ["the egress policy's label removed", mutate((t) => void (t.spec.podMetadata.labels = {}))],
    ["a deadline past the certificate", mutate((t) => void (t.spec.activeDeadlineSeconds = 3600))],
    ["hostNetwork", mutate((t) => void (t.spec.hostNetwork = true))],
    [
      "an extra Workflow parameter",
      mutate((t) => void t.spec.arguments.parameters.push({ name: "opsInventory" }))
    ]
  ];

  it.each(BYPASSES)(
    "REFUSES %s — nothing is submitted, and the refusal is terminal-marked",
    async (_label, tpl) => {
      expect(opsTemplateShapeProblems(tpl, PIN).length).toBeGreaterThan(0);
      const r = await outcome(tpl);
      expect(r.submitted, "a refused template must never be submitted").toBe(false);
      expect(r.refused).toContain(OPS_TEMPLATE_REFUSED_MARKER);
    }
  );

  it("the RUNNING instance's own endpoint must be pinned — a stale or re-pointed instance refuses", async () => {
    const r = await outcome(chartShape(), {
      opsTemplatePins: [{ ...PIN, serverUrl: "http://some-other-argo.test" }]
    });
    expect(r.submitted).toBe(false);
    expect(r.refused).toContain("no Argo host-ops pin names this instance's endpoint");
  });

  it("no pins at all → refused before any read", async () => {
    const r = await outcome(chartShape(), { opsTemplatePins: [] });
    expect(r.submitted).toBe(false);
    expect(r.refused).toContain(OPS_TEMPLATE_REFUSED_MARKER);
  });

  it("a read-back HTTP 5xx is NOT terminal-marked (the server's retry path), and nothing is submitted", async () => {
    nock(SERVER_URL).get(`/api/v1/workflow-templates/${NS}/scp-ops-v1`).reply(503, {});
    const submit = nock(SERVER_URL).post(`/api/v1/workflows/${NS}/submit`).reply(200, {});
    const err = await createArgoWorkflowsExecutorPlugin()
      .trigger(ctx(), {
        kind: "workflow_dispatch",
        targetRef: "scp-ops-v1",
        idempotencyKey: randomUUID(),
        parameters: {}
      } as never)
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("HTTP 503");
    expect((err as Error).message).not.toContain(OPS_TEMPLATE_REFUSED_MARKER);
    expect(submit.isDone()).toBe(false);
  });
});
