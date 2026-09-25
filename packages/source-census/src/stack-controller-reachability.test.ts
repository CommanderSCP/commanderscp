import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trackedFiles } from "./tracked.js";
import { stripComments } from "./ts.js";

/**
 * THE INSTALLATION GATE for the Standard Stack controller (M29.4, ADR-0058).
 *
 * "Built, never installed" is this repo's dominant defect, and a controller is its purest form: a
 * reconcile loop every test drives directly, reachable from no binary, passes every behavioural
 * test while installing nothing. Each function below is load-bearing for the path from the API to
 * a running backend, and each must have a caller that is not a test, in a file other than its own.
 * (In-file wiring — the loop calling `reconcileStack` — is proved by deleting it: the kind suite
 * and `reconcile.test.ts` both go red.) Sources are read with comments stripped and with
 * `readFileSync`, never a grep tool (BUILD_AND_TEST.md §4.4b).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

const MUST_HAVE_A_PRODUCTION_CALLER: Record<string, string> = {
  // The binary.
  startStackController: "is the reconcile loop; with no caller the image starts and does nothing",
  buildControllerDeps: "assembles the controller from its configuration and the pinned helm",
  loadControllerConfig: "reads the controller's deployment facts (API URL, credential, namespace)",
  inClusterTransport: "is the controller's ONLY route to the Kubernetes API in a pod",
  resolveHelm: "asserts the helm binary IS the pin before anything is rendered",
  loadRelease: "loads the chart the image carries and the deploy-time image retargets",
  // The reconcile.
  deriveBackendValues: "is the only place helm values are made from the typed spec",
  backendNeeds: "names the templates a backend cannot render yet (the Stack page's 'needs')",
  parseManifests: "turns a render into the objects that are applied",
  stamp: "labels every applied object — the label is what prune and removal require",
  fingerprint: "decides whether a set changed, and so whether to apply and health-check it",
  checkReadiness: "is the health check an upgrade must pass before it counts",
  mintSelfSignedCertificate:
    "gives argo-server the persistent certificate it cannot start well without",
  // The server half.
  registerStackRoutes: "puts the stack's desired state, and the controller's two doors, on the API",
  registerStackCommands: "is `scp stack …`",
  provisionInstallTimePrincipals:
    "records the controller's credential and scp_operator's login at install; with no caller the controller is locked out",
  provisionInstallOperatorCredential:
    "hashes the chart-generated controller credential into the table",
  provisionOperatorRole: "gives scp_operator its login so the operator doors can write at all",
  // The review round (#421): the instance-operator role, the audit chain, the read-back checks.
  requireInstanceAuthority:
    "is the one check every instance-level stack write passes — a session holding the role, or a full operator credential",
  sessionHoldsInstanceOperator: "is how the Stack page learns whether to offer its switches",
  requireStackControllerCredential:
    "is what keeps the controller's scoped credential to the spec and status doors",
  appendInstanceAudit: "writes every instance-level stack write into the hash chain, in its tx",
  verifyInstanceAuditChain: "re-verifies the chain on every read of it",
  registerInstanceOperatorRoutes: "puts the grant/revoke doors and the audit chain on the API",
  registerInstanceOperatorCommands: "is `scp instance-operator …`",
  grantBootstrapInstanceOperator:
    "is the M29.1 installer's seam: the bootstrap admin's first grant with no SQL",
  assertStackSet:
    "holds every render and every stored set to the kinds and namespace a backend may contain",
  refViolation: "is what a prune checks before it deletes anything",
  stateDigests: "is what the controller reports to scpd about the state it left",
  inventoryDigest: "is how the controller checks its stored inventory against scpd's record",
  // M29.2 (ADR-0061): the auto-wire. Controller half, then scpd half.
  wireBackend:
    "is the wiring step itself — token, CA, both egress layers, the hand-off; with no caller every backend installs and stays unwired",
  unwireBackend: "takes the wiring back before a disabled backend is removed",
  nodeBackendHttp: "is the controller's only client for the backends' own APIs (the token mint)",
  storeWiring:
    "persists the hand-off — the token encrypted at the instance tier, the facts, the audit link",
  dropWiring: "withdraws a backend's token and wiring when the controller unwires it",
  validateWiring: "holds each backend's hand-off to its shape before anything is stored",
  reconcileStackRegistrations:
    "registers the execution systems in every served org; with no caller a wired backend is registered nowhere",
  stackWiredRouting:
    "is the ONE place a stack registration's endpoint, token, CA and egress come from; with no caller the resolver routes it by its properties",
  assertStackRegistrationWrite:
    "refuses every writer but the stack at the object write choke point — the tenant re-point refusal",
  attachServedOrg: "is the instance operator's decision to serve another organization",
  detachServedOrg: "stops serving one",
  listServedOrgs: "is the served-organizations read",
  // M29.3 (ADR-0062): canary out of the box. (In-file steps — pushCarrier, the projects, the
  // Rollouts-to-target Application, refuseUnauthoredRollout — are proved by deletion instead:
  // `authoring.test.ts`, `stack-authoring.integration.test.ts` and the kind suite go red.)
  reconcileAuthoring:
    "is the authoring step — carrier, projects, Rollouts on every target, the hand-off; with no caller Rollouts installs and nothing can author a canary",
  storeAuthoring: "persists the controller's authoring hand-off with its audit link",
  withdrawAuthoring:
    "withdraws authoring when a backend it needs is disabled or unwired — without it a canary is authored against a carrier that is gone",
  stackAuthoringDocument:
    "derives the registered Argo CD's authoring from the hand-off and release constants — the only source of it",
  readStackAuthoringAsTenant: "reads the hand-off inside the tenant transaction that routes a trigger",
  registeredArgoCdAuthoring:
    "is how the deploy lane takes a registration's authoring from the stack, never its properties",
  stackAuthoringView: "is the Stack page's (and `scp stack status`'s) authoring line"
};

const isTest = (p: string): boolean =>
  p.includes(".test.") || p.includes("/test-support/") || p.includes("/testkit/");

const PRODUCTION_SOURCES = trackedFiles(REPO_ROOT).filter(
  (p) =>
    (p.startsWith("apps/") || p.startsWith("packages/")) &&
    p.endsWith(".ts") &&
    !p.endsWith(".d.ts") &&
    !isTest(p)
);

const stripped = new Map<string, string>();
const read = (p: string): string => {
  let text = stripped.get(p);
  if (text === undefined) {
    text = stripComments(readFileSync(resolve(REPO_ROOT, p), "utf8"));
    stripped.set(p, text);
  }
  return text;
};

function definitionFiles(name: string): Set<string> {
  const declaration = new RegExp(`export (?:async )?function ${name}\\b`);
  return new Set(PRODUCTION_SOURCES.filter((p) => declaration.test(read(p))));
}

function callersOf(name: string): string[] {
  const defined = definitionFiles(name);
  const used = new RegExp(`\\b${name}\\s*\\(`);
  return PRODUCTION_SOURCES.filter((p) => !defined.has(p)).filter((p) => used.test(read(p)));
}

describe("the stack controller is INSTALLED, not merely built", () => {
  it.each(Object.entries(MUST_HAVE_A_PRODUCTION_CALLER))(
    "%s has at least one non-test caller",
    (name, why) => {
      expect(
        callersOf(name),
        `${name}() has NO production caller outside its own file. It ${why}. A test calling it ` +
          `directly does not make it reachable. Wire it, or delete it and say so.`
      ).not.toEqual([]);
    }
  );

  it("every name in the census is DEFINED somewhere (a rename must not empty the gate)", () => {
    for (const name of Object.keys(MUST_HAVE_A_PRODUCTION_CALLER)) {
      expect(
        [...definitionFiles(name)],
        `${name} is in the census but nothing exports it`
      ).not.toEqual([]);
    }
  });

  it("the binary's entrypoint starts the loop (main.ts -> startStackController)", () => {
    expect(read("apps/stackd/src/main.ts")).toMatch(/\bstartStackController\s*\(/);
  });

  it("the migrations entrypoint provisions the install-time principals", () => {
    expect(read("apps/server/src/migrate-bin.ts")).toMatch(/\bprovisionInstallTimePrincipals\s*\(/);
  });
});
