import { createHash, randomBytes } from "node:crypto";
import type {
  PutStackWiringRequest,
  StackBackend,
  StackBackendSpec,
  StackBackendWiringSpec,
  StackNeed,
  StackWireableBackend
} from "@scp/schemas";
import type { BackendHttp } from "./backend-http.js";
import type { KubeObject, ObjectRef } from "./manifests.js";
import { checkReadiness } from "./readiness.js";
import { backendNamespace, chartBackendDefaults, type StackRelease } from "./release.js";
import type { ControllerDeps } from "./reconcile.js";
import { mintSelfSignedCertificate } from "./tls.js";

/**
 * WIRING A HEALTHY BACKEND INTO SCP (M29.2, ADR-0060) — the half of the reconcile that runs once a
 * backend's set is ready. For each backend SCP calls (Argo CD, Argo Workflows, Gitea) it, in order:
 *
 *   1. derives the endpoint from ITS OWN RENDER — the Service the chart rendered, its port and its
 *      selector — never from anything the API hands it (`backendEndpoint`);
 *   2. opens scpd's NetworkPolicy egress to exactly that Service's pods and port, in SCP's
 *      namespace (`egressPolicy`) — before scpd can use the wiring, so the network is never the
 *      step that is missing;
 *   3. mints the scoped account's token ON the backend (Argo CD: an apiKey token for the scoped
 *      account; Gitea: a write:repository + write:package token; Argo Workflows: the scoped
 *      ServiceAccount's bound token), and reads the CA the endpoint's certificate chains to;
 *   4. hands all of it to scpd through the one door its credential opens (`putWiring`), which
 *      keeps the token encrypted, registers the execution systems and opens the application egress
 *      for them — and only then revokes every older token of that account.
 *
 * THE TOKEN'S LIFE IN THE CONTROLLER: minted into a local, sent in the request body, dropped when
 * the function returns. It is never written to the controller's state, a Secret, a log line or a
 * status report — the wiring hash the controller compares next tick is over the endpoint facts,
 * not the token.
 *
 * Idempotent: scpd hands back the hash of the facts it holds and the rotation generation they
 * satisfied (`StackSpecDocument.wiring`); when both match what the controller derives now, nothing
 * is minted. A new backend install (a different Secret or volume identity), a changed endpoint or
 * CA, or an operator's rotation request re-wires. Argo Events is registered with no endpoint: SCP
 * never calls it (its sensors would call SCP — the inbound half is not built, ADR-0060 §open).
 */

export type WireableBackend = StackWireableBackend;

export const WIREABLE: readonly WireableBackend[] = [
  "argocd",
  "argo-workflows",
  "argo-events",
  "gitea"
];

export const isWireable = (b: StackBackend): b is WireableBackend =>
  (WIREABLE as readonly string[]).includes(b);

/** Where to find each called backend's API in its render. */
const SERVICE: Partial<Record<WireableBackend, { name: string; scheme: "http" | "https" }>> = {
  argocd: { name: "argocd-server", scheme: "http" },
  "argo-workflows": { name: "argo-server", scheme: "https" },
  gitea: { name: "scp-gitea-http", scheme: "http" }
};

export interface BackendEndpoint {
  serverUrl: string;
  namespace: string;
  service: string;
  /** The pods the Service selects, and the port they listen on — what the NetworkPolicy opens. */
  podSelector: Record<string, string>;
  targetPort: number;
}

/** The endpoint, from the Service object the chart rendered for this backend. */
export function backendEndpoint(
  release: StackRelease,
  backend: StackBackend,
  objects: KubeObject[]
): BackendEndpoint | null {
  if (!isWireable(backend)) return null;
  const svc = SERVICE[backend];
  if (!svc) return null;
  const namespace = backendNamespace(release, backend);
  const obj = objects.find(
    (o) =>
      o.kind === "Service" &&
      o.apiVersion === "v1" &&
      o.metadata.name === svc.name &&
      o.metadata.namespace === namespace
  );
  if (!obj) throw new Error(`the render of ${backend} has no Service ${namespace}/${svc.name}`);
  const spec = obj["spec"] as
    | {
        ports?: { name?: string; port?: number; targetPort?: number | string | null }[];
        selector?: Record<string, string>;
      }
    | undefined;
  const port = spec?.ports?.find((p) => p.name === "http") ?? spec?.ports?.[0];
  if (!port?.port) throw new Error(`Service ${namespace}/${svc.name} renders no port`);
  const selector = spec?.selector ?? {};
  if (Object.keys(selector).length === 0) {
    throw new Error(`Service ${namespace}/${svc.name} renders no selector`);
  }
  const target = typeof port.targetPort === "number" ? port.targetPort : port.port;
  const defaultPort = svc.scheme === "http" ? 80 : 443;
  return {
    serverUrl: `${svc.scheme}://${svc.name}.${namespace}.svc${port.port === defaultPort ? "" : `:${port.port}`}`,
    namespace,
    service: svc.name,
    podSelector: selector,
    targetPort: target
  };
}

/** The NetworkPolicy that lets scpd's pods reach one backend — the network half of egress. */
export const egressPolicyName = (backend: WireableBackend): string => `scp-stack-egress-${backend}`;

export function egressPolicy(
  scpNamespace: string,
  scpPodLabels: Record<string, string>,
  backend: WireableBackend,
  ep: BackendEndpoint
): KubeObject {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: egressPolicyName(backend),
      namespace: scpNamespace,
      labels: {
        "stack.commanderscp.io/managed-by": "scp-stackd",
        "stack.commanderscp.io/backend": backend,
        "stack.commanderscp.io/wiring": "egress"
      }
    },
    spec: {
      podSelector: { matchLabels: scpPodLabels },
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": ep.namespace }
              },
              podSelector: { matchLabels: ep.podSelector }
            }
          ],
          // The CONTAINER port: a NetworkPolicy is matched after the Service's DNAT.
          ports: [{ protocol: "TCP", port: ep.targetPort }]
        }
      ]
    }
  };
}

export interface WiringFacts {
  serverUrl: string | null;
  namespace: string | null;
  caPem: string | null;
  account: string | null;
  /** The identity of what holds the token on the backend side (a Secret's or a volume's uid): a
   *  reinstalled backend has forgotten every token, so a new identity re-wires. */
  instanceUid: string | null;
}

export function factsDigest(backend: WireableBackend, f: WiringFacts): string {
  const caSha = f.caPem === null ? null : createHash("sha256").update(f.caPem.trim()).digest("hex");
  return createHash("sha256")
    .update(JSON.stringify([backend, f.serverUrl, f.namespace, caSha, f.account, f.instanceUid]))
    .digest("hex");
}

// ---- kube helpers --------------------------------------------------------------------------------

const secretRef = (name: string, namespace: string): ObjectRef => ({
  apiVersion: "v1",
  kind: "Secret",
  name,
  namespace
});

async function secretValue(
  deps: ControllerDeps,
  name: string,
  namespace: string,
  key: string
): Promise<string | undefined> {
  const s = await deps.kube.get(secretRef(name, namespace));
  const raw = (s?.["data"] as Record<string, string> | undefined)?.[key];
  return raw === undefined ? undefined : Buffer.from(raw, "base64").toString("utf8");
}

async function uidOf(deps: ControllerDeps, ref: ObjectRef): Promise<string | null> {
  const o = await deps.kube.get(ref);
  return ((o?.metadata as { uid?: string } | undefined)?.uid ?? null) || null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function poll<T>(
  deps: ControllerDeps,
  what: string,
  probe: () => Promise<T | undefined>
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + deps.readyTimeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`
      );
    }
    await sleep(deps.pollMs);
  }
}

// ---- argo-server's certificate --------------------------------------------------------------------

export function argoServerTlsSecretName(release: StackRelease): string {
  const w = chartBackendDefaults(release, "argo-workflows") as { tlsSecretName?: string };
  return w.tlsSecretName || "argo-server-tls";
}

/** argo-server's persistent certificate: minted once, and again only on a rotation request. */
export async function ensureArgoServerTls(deps: ControllerDeps): Promise<void> {
  const namespace = backendNamespace(deps.release, "argo-workflows");
  const name = argoServerTlsSecretName(deps.release);
  if (await deps.kube.get(secretRef(name, namespace))) return;
  const host = `argo-server.${namespace}`;
  const minted = mintSelfSignedCertificate({
    commonName: `${host}.svc`,
    dnsNames: ["argo-server", host, `${host}.svc`, `${host}.svc.cluster.local`],
    validDays: 3650
  });
  await deps.kube.apply({
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/tls",
    metadata: {
      name,
      namespace,
      labels: {
        "stack.commanderscp.io/managed-by": "scp-stackd",
        "stack.commanderscp.io/backend": "argo-workflows"
      }
    },
    stringData: { "tls.crt": minted.certPem, "tls.key": minted.keyPem }
  });
  deps.log(`minted argo-server's persistent certificate into ${namespace}/${name}`);
}

/** Rolls a Deployment's pods (a pod-template annotation, under a field manager of its own so the
 *  next render's apply leaves it alone) and waits for the new ones. */
async function restartDeployment(
  deps: ControllerDeps,
  namespace: string,
  name: string,
  generation: number
): Promise<void> {
  await deps.kube.mergePatch(
    { apiVersion: "apps/v1", kind: "Deployment", name, namespace },
    {
      spec: {
        template: {
          metadata: {
            annotations: { "stack.commanderscp.io/credentials-rotation": String(generation) }
          }
        }
      }
    }
  );
  await poll(deps, `${namespace}/${name} to roll onto the rotated certificate`, async () => {
    const r = await checkReadiness(deps.kube, [
      { apiVersion: "apps/v1", kind: "Deployment", name, namespace }
    ]);
    return r.ready ? true : undefined;
  });
}

// ---- minting, per backend ------------------------------------------------------------------------

interface Minted {
  token: string | null;
  /** Revokes every OTHER token of the account — run only after scpd holds the new one. */
  revokeOthers: () => Promise<void>;
}

const suffix = (): string => randomBytes(4).toString("hex");

function argoCdAccount(release: StackRelease): string {
  const a = chartBackendDefaults(release, "argocd") as { scpAccount?: string };
  if (!a.scpAccount) throw new Error("the chart names no Argo CD scpAccount");
  return a.scpAccount;
}

function argoWorkflowsAccount(release: StackRelease): string {
  const w = chartBackendDefaults(release, "argo-workflows") as { scpAccount?: string };
  if (!w.scpAccount) throw new Error("the chart names no Argo Workflows scpAccount");
  return w.scpAccount;
}

async function argoCdSession(deps: ControllerDeps, ep: BackendEndpoint): Promise<string> {
  const http = requireHttp(deps);
  const password = await poll(deps, "Argo CD's initial admin secret", () =>
    secretValue(deps, "argocd-initial-admin-secret", ep.namespace, "password")
  );
  return poll(deps, "an Argo CD admin session", async () => {
    const res = await http.request({
      method: "POST",
      url: `${ep.serverUrl}/api/v1/session`,
      json: { username: "admin", password }
    });
    const token = (res.body as { token?: string } | undefined)?.token;
    if (res.status !== 200 || !token) throw new Error(`POST /api/v1/session: HTTP ${res.status}`);
    return token;
  });
}

async function argoCdTokenIds(
  deps: ControllerDeps,
  ep: BackendEndpoint,
  session: string,
  account: string
): Promise<string[]> {
  const res = await requireHttp(deps).request({
    method: "GET",
    url: `${ep.serverUrl}/api/v1/account/${encodeURIComponent(account)}`,
    headers: { authorization: `Bearer ${session}` }
  });
  if (res.status !== 200) throw new Error(`GET /api/v1/account/${account}: HTTP ${res.status}`);
  return ((res.body as { tokens?: { id?: string }[] } | undefined)?.tokens ?? [])
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function argoCdRevoke(
  deps: ControllerDeps,
  ep: BackendEndpoint,
  session: string,
  account: string,
  keep: string | null
): Promise<void> {
  for (const id of await argoCdTokenIds(deps, ep, session, account)) {
    if (id === keep) continue;
    const res = await requireHttp(deps).request({
      method: "DELETE",
      url: `${ep.serverUrl}/api/v1/account/${encodeURIComponent(account)}/token/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${session}` }
    });
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`revoking Argo CD token ${id}: HTTP ${res.status}`);
    }
  }
}

async function mintArgoCd(
  deps: ControllerDeps,
  ep: BackendEndpoint,
  account: string,
  rotation: number
): Promise<Minted> {
  const session = await argoCdSession(deps, ep);
  const id = `scp-stack-r${rotation}-${suffix()}`;
  const res = await requireHttp(deps).request({
    method: "POST",
    url: `${ep.serverUrl}/api/v1/account/${encodeURIComponent(account)}/token`,
    headers: { authorization: `Bearer ${session}` },
    json: { name: account, id }
  });
  const token = (res.body as { token?: string } | undefined)?.token;
  if (res.status !== 200 || !token) {
    throw new Error(
      `minting a token for Argo CD account '${account}': HTTP ${res.status} (is it an apiKey account in argocd-cm?)`
    );
  }
  return { token, revokeOthers: () => argoCdRevoke(deps, ep, session, account, id) };
}

async function giteaAdmin(
  deps: ControllerDeps,
  ep: BackendEndpoint
): Promise<{ username: string; auth: string }> {
  const [username, password] = await Promise.all([
    poll(deps, "Gitea's admin secret", () =>
      secretValue(deps, "gitea-admin-secret", ep.namespace, "username")
    ),
    poll(deps, "Gitea's admin secret", () =>
      secretValue(deps, "gitea-admin-secret", ep.namespace, "password")
    )
  ]);
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  // The pod can be Ready before configure_gitea.sh has made the admin user.
  await poll(deps, "Gitea's API to accept its admin", async () => {
    const res = await requireHttp(deps).request({
      method: "GET",
      url: `${ep.serverUrl}/api/v1/user`,
      headers: { authorization: auth }
    });
    if (res.status !== 200) throw new Error(`GET /api/v1/user: HTTP ${res.status}`);
    return true;
  });
  return { username, auth };
}

/** Least privilege: push code and packages, never administer Gitea. */
export const GITEA_TOKEN_SCOPES = ["write:repository", "write:package"];
const GITEA_TOKEN_PREFIX = "scp-stack-";

async function giteaRevoke(
  deps: ControllerDeps,
  ep: BackendEndpoint,
  admin: { username: string; auth: string },
  keep: string | null
): Promise<void> {
  const http = requireHttp(deps);
  const list = await http.request({
    method: "GET",
    url: `${ep.serverUrl}/api/v1/users/${encodeURIComponent(admin.username)}/tokens`,
    headers: { authorization: admin.auth }
  });
  if (list.status !== 200) throw new Error(`listing Gitea tokens: HTTP ${list.status}`);
  for (const t of (list.body as { id?: number; name?: string }[] | undefined) ?? []) {
    if (!t.name?.startsWith(GITEA_TOKEN_PREFIX) || t.name === keep || t.id === undefined) continue;
    const res = await http.request({
      method: "DELETE",
      url: `${ep.serverUrl}/api/v1/users/${encodeURIComponent(admin.username)}/tokens/${t.id}`,
      headers: { authorization: admin.auth }
    });
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`revoking Gitea token ${t.name}: HTTP ${res.status}`);
    }
  }
}

async function mintGitea(
  deps: ControllerDeps,
  ep: BackendEndpoint,
  rotation: number
): Promise<Minted & { account: string }> {
  const admin = await giteaAdmin(deps, ep);
  const name = `${GITEA_TOKEN_PREFIX}r${rotation}-${suffix()}`;
  const res = await requireHttp(deps).request({
    method: "POST",
    url: `${ep.serverUrl}/api/v1/users/${encodeURIComponent(admin.username)}/tokens`,
    headers: { authorization: admin.auth },
    json: { name, scopes: GITEA_TOKEN_SCOPES }
  });
  const token = (res.body as { sha1?: string } | undefined)?.sha1;
  if (res.status !== 201 || !token) throw new Error(`minting a Gitea token: HTTP ${res.status}`);
  return {
    token,
    account: admin.username,
    revokeOthers: () => giteaRevoke(deps, ep, admin, name)
  };
}

function requireHttp(deps: ControllerDeps): BackendHttp {
  if (!deps.wiring) throw new Error("internal: wiring is not configured");
  return deps.wiring.http;
}

// ---- the facts ------------------------------------------------------------------------------------

async function gatherFacts(
  deps: ControllerDeps,
  backend: WireableBackend,
  ep: BackendEndpoint | null
): Promise<WiringFacts> {
  const namespace = backendNamespace(deps.release, backend);
  switch (backend) {
    case "argocd":
      return {
        serverUrl: ep!.serverUrl,
        namespace: null,
        caPem: null,
        account: argoCdAccount(deps.release),
        // Argo CD keeps its account tokens in argocd-secret.
        instanceUid: await uidOf(deps, secretRef("argocd-secret", namespace))
      };
    case "gitea":
      return {
        serverUrl: ep!.serverUrl,
        namespace: null,
        caPem: null,
        account: (await secretValue(deps, "gitea-admin-secret", namespace, "username")) ?? null,
        // Gitea's tokens live in its database, on this volume.
        instanceUid: await uidOf(deps, {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          name: "gitea-shared-storage",
          namespace
        })
      };
    case "argo-workflows": {
      const account = argoWorkflowsAccount(deps.release);
      const caPem =
        (await secretValue(deps, argoServerTlsSecretName(deps.release), namespace, "tls.crt")) ??
        null;
      if (!caPem) throw new Error(`argo-server's certificate secret is missing in ${namespace}`);
      return {
        serverUrl: ep!.serverUrl,
        namespace,
        caPem,
        account,
        instanceUid: await uidOf(deps, secretRef(`${account}-token`, namespace))
      };
    }
    case "argo-events":
      return { serverUrl: null, namespace: null, caPem: null, account: null, instanceUid: null };
  }
}

/** The ServiceAccount's bound token (the kubelet's token controller fills it in). */
async function workflowsToken(deps: ControllerDeps, namespace: string, account: string) {
  return poll(deps, `the ${account} ServiceAccount token`, () =>
    secretValue(deps, `${account}-token`, namespace, "token")
  );
}

/** Rotation for Argo Workflows: a new server certificate (argo-server rolls onto it) and a new
 *  ServiceAccount token (deleting the token Secret revokes the old one; the render re-creates it). */
async function rotateArgoWorkflows(
  deps: ControllerDeps,
  objects: KubeObject[],
  generation: number
): Promise<void> {
  const namespace = backendNamespace(deps.release, "argo-workflows");
  const account = argoWorkflowsAccount(deps.release);
  await deps.kube.delete(secretRef(argoServerTlsSecretName(deps.release), namespace));
  await ensureArgoServerTls(deps);
  await restartDeployment(deps, namespace, "argo-server", generation);
  const tokenSecret = objects.find(
    (o) => o.kind === "Secret" && o.metadata.name === `${account}-token`
  );
  if (!tokenSecret) throw new Error(`the render of argo-workflows has no Secret ${account}-token`);
  await deps.kube.delete(secretRef(`${account}-token`, namespace));
  await poll(deps, `the old ${account}-token to be gone`, async () =>
    (await deps.kube.get(secretRef(`${account}-token`, namespace))) ? undefined : true
  );
  await deps.kube.apply(tokenSecret);
  deps.log(`argo-workflows: rotated argo-server's certificate and ${account}'s token`);
}

// ---- the reconcile's two hooks ---------------------------------------------------------------------

export interface WiringContext {
  spec: StackBackendSpec;
  /** What scpd holds of this backend's wiring (a hash and a counter), if anything. */
  recorded: StackBackendWiringSpec | undefined;
}

/** THE WIRING STEP (`ControllerDeps.afterReady`). Never throws: what did not complete is a need. */
export async function wireBackend(
  deps: ControllerDeps,
  backend: StackBackend,
  objects: KubeObject[],
  ctx: WiringContext
): Promise<StackNeed[]> {
  if (!isWireable(backend) || !deps.wiring) return [];
  const wiring = deps.wiring;
  try {
    const ep = backendEndpoint(deps.release, backend, objects);
    if (ep) {
      if (Object.keys(wiring.scpPodLabels).length === 0) {
        throw new Error(
          "the controller was given no labels for scpd's pods (SCP_STACKD_SCP_POD_LABELS)"
        );
      }
      await deps.kube.apply(egressPolicy(deps.scpNamespace, wiring.scpPodLabels, backend, ep));
    }
    const rotation = ctx.spec.rotateGeneration;
    const recorded = ctx.recorded?.factsSha256 ? ctx.recorded : undefined;
    const rotating = recorded !== undefined && (recorded.rotationGeneration ?? 0) < rotation;
    if (rotating && backend === "argo-workflows")
      await rotateArgoWorkflows(deps, objects, rotation);
    let facts = await gatherFacts(deps, backend, ep);
    const digest = factsDigest(backend, facts);
    if (recorded && recorded.factsSha256 === digest && !rotating) return [];

    let minted: Minted = { token: null, revokeOthers: async () => undefined };
    if (backend === "argocd") minted = await mintArgoCd(deps, ep!, facts.account!, rotation);
    if (backend === "gitea") {
      const g = await mintGitea(deps, ep!, rotation);
      minted = g;
      facts = { ...facts, account: g.account };
    }
    if (backend === "argo-workflows") {
      minted = {
        token: await workflowsToken(deps, facts.namespace!, facts.account!),
        revokeOthers: async () => undefined
      };
    }
    const body: PutStackWiringRequest = {
      serverUrl: facts.serverUrl,
      namespace: facts.namespace,
      caPem: facts.caPem,
      account: facts.account,
      token: minted.token,
      factsSha256: factsDigest(backend, facts),
      rotationGeneration: rotation
    };
    await deps.api.putWiring(backend, body);
    await minted.revokeOthers();
    deps.log(`${backend}: wired into SCP (${facts.serverUrl ?? "registered, not called"})`);
    return [];
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log(`${backend}: wiring did not complete: ${why}`);
    return [
      {
        code: "wiring",
        message: `${backend} is running but not wired into SCP yet: ${why}`.slice(0, 500)
      }
    ];
  }
}

/** THE UNWIRING STEP, before a disabled backend is removed (`ControllerDeps.unwire`). scpd first
 *  (no request may be routed to what is going away), then the NetworkPolicy, then — best effort,
 *  bounded, and only if it was wired — its tokens on the backend while it still runs, so a kept
 *  Gitea volume holds none for later. */
export async function unwireBackend(
  deps: ControllerDeps,
  backend: StackBackend,
  ctx: { wasWired: boolean }
): Promise<void> {
  if (!isWireable(backend) || !deps.wiring) return;
  await deps.api.deleteWiring(backend);
  await deps.kube.delete({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    name: egressPolicyName(backend),
    namespace: deps.scpNamespace
  });
  if (ctx.wasWired && (backend === "argocd" || backend === "gitea")) {
    // Bounded: a backend that is already unhealthy must not hold a disable up for minutes.
    const quick: ControllerDeps = {
      ...deps,
      readyTimeoutMs: Math.min(deps.readyTimeoutMs, 15_000)
    };
    try {
      const ns = backendNamespace(deps.release, backend);
      const svc = SERVICE[backend]!;
      const ep: BackendEndpoint = {
        serverUrl:
          backend === "argocd"
            ? `http://${svc.name}.${ns}.svc`
            : `http://${svc.name}.${ns}.svc:3000`,
        namespace: ns,
        service: svc.name,
        podSelector: {},
        targetPort: 0
      };
      if (backend === "argocd") {
        await argoCdRevoke(
          quick,
          ep,
          await argoCdSession(quick, ep),
          argoCdAccount(deps.release),
          null
        );
      } else {
        await giteaRevoke(quick, ep, await giteaAdmin(quick, ep), null);
      }
    } catch (err) {
      deps.log(
        `${backend}: could not revoke its tokens before removal (${err instanceof Error ? err.message : String(err)}); scpd no longer holds any`
      );
    }
  }
  deps.log(`${backend}: unwired from SCP`);
}
