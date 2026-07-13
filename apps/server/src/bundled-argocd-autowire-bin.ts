/**
 * Bundled Argo CD auto-wire entrypoint (M11 — the "zero token plumbing" step of Mode B, docs/
 * proposals/bundled-executor-backends.md). `deploy/helm`'s bundled-argocd-autowire Job runs exactly
 * `node dist/bundled-argocd-autowire-bin.js` as a Helm `post-install,post-upgrade` hook when
 * `bundledExecutor.argocd.enabled`. It mints a SCOPED (never admin) Argo CD API token and stores it
 * in SCP's encrypted secret store so an operator can bind any graph object to the `argocd` executor
 * with `--secret-refs '{"tokenSecretKey":"<key>"}'` and no manual token creation.
 *
 * Why a DB-seed bin (like migrate-bin.ts) rather than the public API: this is INSTALL-TIME bootstrap
 * plumbing, run by the operator's `helm install` (not by scpd at runtime), so it uses the same admin
 * `DATABASE_URL` + `SCP_SECRETS_MASTER_KEY` the migrations Job already uses — no bootstrap PAT
 * chicken-and-egg. It never holds Argo CD's kube credentials: it obtains only a scoped API token
 * (applications get/sync), which is exactly what the credential-asymmetry invariant permits.
 *
 * Idempotent: re-running (e.g. a `helm upgrade`) simply re-mints + overwrites the stored token.
 * The per-object executor BINDING is deliberately NOT seeded here — bindings attach to a graph
 * object (Component/DeploymentTarget), which the operator creates later; the value delivered here is
 * that the token already exists, so the bind is a single command with no token step.
 *
 * Env contract (all injected by the Helm hook Job):
 *   SCP_ARGOCD_SERVER_URL        in-cluster Argo CD API base (http, behind NetworkPolicy), e.g.
 *                                http://scp-argocd-server.scp-argocd.svc
 *   SCP_ARGOCD_ADMIN_SECRET_NS   namespace of Argo CD's initial-admin secret (scp-argocd)
 *   SCP_ARGOCD_ADMIN_SECRET_NAME argocd-initial-admin-secret
 *   SCP_ARGOCD_ACCOUNT           the scoped account to mint a token for (scp-coordinator)
 *   SCP_ARGOCD_TOKEN_SECRET_KEY  the SCP secret key to store the token under
 *   SCP_BOOTSTRAP_ORG            the org whose secret store receives the token
 *   DATABASE_URL, SCP_SECRETS_MASTER_KEY   admin DB + master key (same as migrate-bin)
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { orgs } from "./db/schema.js";
import { withTenantTx } from "./db/tenant-tx.js";
import { putSecret } from "./secrets/secrets-repo.js";

const K8S_SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[argocd-autowire] required env ${name} is unset`);
  return v;
}

/** Poll `fn` until it resolves truthy or the deadline passes — the bundled Argo CD Deployments and
 *  their initial-admin secret come up asynchronously after the post-install hook fires. */
async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`[argocd-autowire] timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Read a key out of a k8s Secret via the in-cluster API using the pod's ServiceAccount token. */
async function readK8sSecretKey(namespace: string, name: string, key: string): Promise<string | undefined> {
  const [token, ca] = await Promise.all([
    readFile(`${K8S_SA_DIR}/token`, "utf8"),
    readFile(`${K8S_SA_DIR}/ca.crt`, "utf8").catch(() => undefined)
  ]);
  // Node's global fetch can't take a custom CA without an undici Agent; the in-cluster API server
  // presents the cluster CA. We pin trust by passing it via NODE_EXTRA_CA_CERTS in the Job spec, so
  // here a plain fetch to the in-cluster API validates normally.
  void ca;
  const res = await fetch(`https://kubernetes.default.svc/api/v1/namespaces/${namespace}/secrets/${name}`, {
    headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" }
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`k8s GET secret ${namespace}/${name} → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, string> };
  const b64 = body.data?.[key];
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : undefined;
}

async function argocdLogin(baseUrl: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password })
  });
  if (!res.ok) throw new Error(`argocd login → HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("argocd login returned no token");
  return body.token;
}

async function argocdMintAccountToken(baseUrl: string, adminJwt: string, account: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/account/${encodeURIComponent(account)}/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({})
  });
  if (!res.ok) {
    throw new Error(
      `argocd mint token for account '${account}' → HTTP ${res.status} (is the account configured with apiKey capability in argocd-cm?)`
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("argocd token mint returned no token");
  return body.token;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const baseUrl = reqEnv("SCP_ARGOCD_SERVER_URL").replace(/\/+$/, "");
  const adminSecretNs = reqEnv("SCP_ARGOCD_ADMIN_SECRET_NS");
  const adminSecretName = reqEnv("SCP_ARGOCD_ADMIN_SECRET_NAME");
  const account = reqEnv("SCP_ARGOCD_ACCOUNT");
  const tokenSecretKey = reqEnv("SCP_ARGOCD_TOKEN_SECRET_KEY");

  console.log(`[argocd-autowire] waiting for Argo CD admin secret ${adminSecretNs}/${adminSecretName}...`);
  const adminPassword = await waitFor("argocd-initial-admin-secret", () =>
    readK8sSecretKey(adminSecretNs, adminSecretName, "password")
  );

  console.log(`[argocd-autowire] waiting for Argo CD API at ${baseUrl}...`);
  const adminJwt = await waitFor("argocd API session", () => argocdLogin(baseUrl, adminPassword));

  console.log(`[argocd-autowire] minting scoped token for account '${account}'...`);
  const scopedToken = await argocdMintAccountToken(baseUrl, adminJwt, account);

  const pool = createPool(config.databaseUrl);
  const db = createDb(pool);
  try {
    // secrets are keyed by org UUID; resolve it from the bootstrap org NAME (the app must have
    // booted + seeded the org at least once — the api Deployment does this on first start).
    const orgRows = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.name, config.bootstrapOrgName))
      .limit(1);
    const orgId = orgRows[0]?.id;
    if (!orgId) {
      throw new Error(
        `[argocd-autowire] bootstrap org '${config.bootstrapOrgName}' not found — the app must boot + seed once before this hook can store the token`
      );
    }
    await withTenantTx(db, orgId, (tx) =>
      putSecret(tx, { orgId, key: tokenSecretKey, value: scopedToken, masterKey: config.secretsMasterKey })
    );
    console.log(
      `[argocd-autowire] done — scoped Argo CD token stored as SCP secret '${tokenSecretKey}' (org ${orgId}). ` +
        `Bind any object with: scp executor bind <idOrUrn> --module argocd ` +
        `--config '{"serverUrl":"${baseUrl}"}' --secret-refs '{"tokenSecretKey":"${tokenSecretKey}"}'`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[argocd-autowire] fatal:", err);
  process.exitCode = 1;
});
