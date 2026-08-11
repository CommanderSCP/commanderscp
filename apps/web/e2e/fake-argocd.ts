import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/**
 * A fake Argo CD API server for the M19.1 "Connect Argo CD" wizard spec — the LOCAL-target half.
 *
 * =============================================================================================
 * THERE IS A SECOND COPY OF THIS, AND THAT IS DELIBERATE. KEEP THEM IN STEP.
 * =============================================================================================
 * This suite runs in two modes (see `global-setup.ts`). In LOCAL mode the SCP server is in-process,
 * so this module simply listens on 127.0.0.1. In COMPOSE-STACK mode — which is what CI job 9 runs —
 * the SCP server is inside a container and can only reach a service on its own compose network, so
 * the fake there is a container: `deploy/compose/docker-compose.e2e.yml`, an inline `node -e` script
 * on the already-built `scp` image (no second image to pull, which keeps that job offline).
 *
 * The alternative — one implementation reached over the host network via `host-gateway` — was
 * rejected: it trades a small, self-detecting duplication for a new networking dependency in the CI
 * job whose networking has historically been the fragile part. Self-detecting because
 * `connect-argocd.spec.ts` asserts these exact Application NAMES, so the two fakes drifting apart
 * turns job 9 red on the pull request rather than rotting quietly.
 *
 * WHY IT DEMANDS A BEARER TOKEN. Without that, a green spec would prove only that the click path
 * works. With it, a green spec proves the credential really travelled secrets store → server →
 * plugin subprocess → Argo CD, which is the half of the wizard that has no other end-to-end cover.
 */

/** The Applications both fakes serve. `connect-argocd.spec.ts` asserts these names. */
export const FAKE_ARGOCD_APPS = [
  {
    metadata: { name: "e2e-checkout" },
    spec: {
      project: "default",
      destination: { namespace: "prod" },
      source: { repoURL: "https://github.com/acme/checkout.git", path: "deploy/checkout" }
    }
  },
  {
    metadata: { name: "e2e-payments" },
    spec: {
      project: "default",
      destination: { namespace: "prod" },
      source: { repoURL: "https://github.com/acme/payments.git", path: "deploy/payments" }
    }
  }
] as const;

export interface FakeArgoCd {
  /** e.g. `http://127.0.0.1:53821` — what the wizard's "Argo CD API server URL" field is given. */
  url: string;
  close(): Promise<void>;
}

export async function startFakeArgoCd(): Promise<FakeArgoCd> {
  const server: Server = createServer((req, res) => {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!/^Bearer .+/.test(req.headers.authorization ?? "")) {
      json(401, { error: "no bearer token" });
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/api/v1/applications") {
      json(200, { items: FAKE_ARGOCD_APPS });
      return;
    }
    if (path === "/api/version") {
      json(200, { Version: "v3.4.5+fake" });
      return;
    }
    json(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}
