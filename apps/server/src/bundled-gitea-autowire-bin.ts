/** Bundled Gitea auto-wire entrypoint. See docs/server.md §29. */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { loadConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { orgs } from "./db/schema.js";
import { withTenantTx } from "./db/tenant-tx.js";
import { putSecret } from "./secrets/secrets-repo.js";

const K8S_SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

// Least-privilege scopes for a coordinator: push code (repository) + push images/packages
// (package). Deliberately NOT any of the admin/user/org write scopes — the token cannot administer
// Gitea, only act within these two capabilities (Gitea 1.20+ scoped-token model).
const TOKEN_SCOPES = ["write:repository", "write:package"];

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[gitea-autowire] required env ${name} is unset`);
  return v;
}

/** Poll `fn` until it resolves truthy or the deadline passes — the bundled Gitea Deployment and its
 *  SCP-generated admin secret come up asynchronously after the post-install hook fires. */
async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs = 300_000
): Promise<T> {
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
      throw new Error(
        `[gitea-autowire] timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Read a key out of a k8s Secret via the in-cluster API using the pod's ServiceAccount token. */
async function readK8sSecretKey(
  namespace: string,
  name: string,
  key: string
): Promise<string | undefined> {
  const token = await readFile(`${K8S_SA_DIR}/token`, "utf8");
  // The in-cluster API server presents the cluster CA; trust is pinned via NODE_EXTRA_CA_CERTS in
  // the Job spec, so a plain fetch validates normally.
  const res = await fetch(
    `https://kubernetes.default.svc/api/v1/namespaces/${namespace}/secrets/${name}`,
    {
      headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" }
    }
  );
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`k8s GET secret ${namespace}/${name} → HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, string> };
  const b64 = body.data?.[key];
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : undefined;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Confirm Gitea's API is up (and the admin creds work) before minting — the pod may accept TCP
 *  before configure_gitea.sh has finished creating the admin user. */
async function giteaReady(baseUrl: string, auth: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/api/v1/user`, {
    headers: { authorization: auth, accept: "application/json" }
  });
  return res.ok;
}

/** DELETE any pre-existing token of this name so a `helm upgrade` re-mint doesn't hit Gitea's
 *  "access token name has been used already" (HTTP 400). Gitea accepts the token NAME as the path
 *  id for deletion. A 404 (no such token — first install) is fine. */
async function deleteExistingToken(
  baseUrl: string,
  auth: string,
  username: string,
  tokenName: string
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenName)}`,
    { method: "DELETE", headers: { authorization: auth } }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`gitea delete existing token '${tokenName}' → HTTP ${res.status}`);
  }
}

async function giteaMintScopedToken(
  baseUrl: string,
  auth: string,
  username: string,
  tokenName: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/users/${encodeURIComponent(username)}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ name: tokenName, scopes: TOKEN_SCOPES })
  });
  if (!res.ok) {
    throw new Error(`gitea mint scoped token for '${username}' → HTTP ${res.status}`);
  }
  const body = (await res.json()) as { sha1?: string };
  if (!body.sha1) throw new Error("gitea token mint returned no sha1");
  return body.sha1;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const baseUrl = reqEnv("SCP_GITEA_SERVER_URL").replace(/\/+$/, "");
  const adminSecretNs = reqEnv("SCP_GITEA_ADMIN_SECRET_NS");
  const adminSecretName = reqEnv("SCP_GITEA_ADMIN_SECRET_NAME");
  const tokenName = reqEnv("SCP_GITEA_TOKEN_NAME");
  const tokenSecretKey = reqEnv("SCP_GITEA_TOKEN_SECRET_KEY");

  console.log(`[gitea-autowire] reading Gitea admin secret ${adminSecretNs}/${adminSecretName}...`);
  const [adminUsername, adminPassword] = await Promise.all([
    waitFor("gitea admin secret username", () =>
      readK8sSecretKey(adminSecretNs, adminSecretName, "username")
    ),
    waitFor("gitea admin secret password", () =>
      readK8sSecretKey(adminSecretNs, adminSecretName, "password")
    )
  ]);
  const auth = basicAuth(adminUsername, adminPassword);

  console.log(`[gitea-autowire] waiting for Gitea API + admin user at ${baseUrl}...`);
  await waitFor("gitea API ready", () => giteaReady(baseUrl, auth));

  console.log(
    `[gitea-autowire] minting scoped token '${tokenName}' (scopes: ${TOKEN_SCOPES.join(", ")})...`
  );
  await deleteExistingToken(baseUrl, auth, adminUsername, tokenName);
  const scopedToken = await giteaMintScopedToken(baseUrl, auth, adminUsername, tokenName);

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
        `[gitea-autowire] bootstrap org '${config.bootstrapOrgName}' not found — the app must boot + seed once before this hook can store the token`
      );
    }
    await withTenantTx(db, orgId, (tx) =>
      putSecret(tx, {
        orgId,
        key: tokenSecretKey,
        value: scopedToken,
        masterKey: config.secretsMasterKey
      })
    );
    console.log(
      `[gitea-autowire] done — scoped Gitea token stored as SCP secret '${tokenSecretKey}' (org ${orgId}). ` +
        `Bind any object with: scp executor bind <idOrUrn> --module gitea ` +
        `--config '{"serverUrl":"${baseUrl}"}' --secret-refs '{"tokenSecretKey":"${tokenSecretKey}"}'`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[gitea-autowire] fatal:", err);
  process.exitCode = 1;
});
