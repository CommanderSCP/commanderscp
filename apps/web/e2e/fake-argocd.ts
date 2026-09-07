import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

/** A fake Argo CD API server for the connect wizard. See docs/web.md §8. */

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
