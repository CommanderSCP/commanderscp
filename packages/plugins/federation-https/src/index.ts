import type {
  BundleRef,
  DomainCursor,
  ExportOptions,
  FederationTransportPlugin,
  ImportReport,
  JournalSegment,
  PluginContext,
  PluginManifest
} from "@scp/plugin-api";

/**
 * `@scp/plugin-federation-https` — the connected/intermittent transport (DESIGN.md §13):
 * "the child dials the parent over mTLS HTTPS to PULL config-journal segments and to PUSH its
 * own status/audit segments; the parent NEVER initiates a connection to a child." Both `pull()`
 * and `push()` are always called FROM the child's own scheduled sync job (apps/server's federation
 * sync scheduler) dialing OUT to the parent's public `/v1/federation/*` API — there is no server
 * (listening) half of this plugin, structurally: nothing in this package ever binds a port or
 * accepts an inbound connection. That is what makes "child-initiated-only" true by CONSTRUCTION,
 * not merely by convention — a parent has no code path here that could reach INTO a child.
 *
 * All network I/O goes through the host-mediated `ctx.http` (`ScopedHttpClient`) — DESIGN.md §11:
 * "egress-controlled, instrumented HTTP — the only network path a plugin is given." This plugin
 * never opens a raw socket or TLS connection itself. Concretely, that means the mTLS client
 * certificate presentation for a given peer is a HOST-level concern: the subprocess plugin host
 * (apps/server/src/plugin-host/) resolves the target peer's vaulted client certificate (by
 * matching the request URL against the peer's registered `baseUrl` — federation/peers-repo.ts)
 * and configures the underlying HTTPS agent before dispatching the request. DEFERRED, FLAGGED IN
 * THE M6 PR BODY: wiring the subprocess host to actually inject per-peer mTLS certs into its
 * `ScopedHttpClient` implementation is real remaining work this milestone does not complete — the
 * plugin-side contract (this file) is what DOES land, structurally ready for that host wiring to
 * slot in behind it without another interface change. The FILE transport (`scp federation
 * export/import`, apps/server/src/routes/federation.ts + packages/cli) is fully implemented,
 * tested, and is what the two-domain E2E and every "SECURITY-SENSITIVE" DoD integration test
 * actually exercises — this plugin adds the LIVE/scheduled path on top of the identical verified
 * import logic, never a separate one.
 *
 * `pull`/`push` adapt between this package's stable `JournalSegment`/`BundleRef` wire shapes
 * (kept intentionally free of any `@scp/schemas` dependency — packages/plugins/* may import ONLY
 * `@scp/plugin-api`, BUILD_AND_TEST.md §7 import-boundary rule) and the actual `.scpbundle` JSON
 * the server's `/federation/exports`/`/federation/imports` endpoints speak: `entries`/the bundle
 * body are carried as opaque `unknown` payloads here, parsed and cryptographically verified
 * SERVER-SIDE (federation/import-repo.ts) exactly as a file-transport import is — this plugin
 * never itself trusts or interprets bundle contents, it only moves bytes.
 */

export interface FederationHttpsConfig {
  /** The parent's public API base URL (e.g. `https://parent.example.com/api/v1`) — set on this
   *  domain's OWN peer record for the parent (federation_peers.base_url), surfaced into plugin
   *  config by the host. Always DIALED, never listened on (child-initiated-only). */
  parentBaseUrl: string;
  /** This domain's own name/id as registered with the parent — the `peer` identifier the
   *  parent's `/federation/exports` expects. */
  selfPeerName: string;
}

function asConfig(config: unknown): FederationHttpsConfig {
  const c = config as Partial<FederationHttpsConfig> | undefined;
  if (!c?.parentBaseUrl || !c.selfPeerName) {
    throw new Error("federation-https: config.parentBaseUrl and config.selfPeerName are required");
  }
  return { parentBaseUrl: c.parentBaseUrl, selfPeerName: c.selfPeerName };
}

/** Pulls the parent's config-journal since `cursor.sequence` — a single HTTP round trip to the
 *  parent's `POST /federation/exports`, dialed by the child. Returns the ENTIRE `.scpbundle` body
 *  as one `JournalSegment` (its `entries` field is the bundle's own entries array; `contentHash`/
 *  `signature` carry the bundle-level checksum/signature — the caller applies it via the same
 *  `importSyncBundle` the file transport uses, which re-verifies everything independently). */
async function pull(ctx: PluginContext, cursor: DomainCursor): Promise<JournalSegment[]> {
  const config = asConfig(ctx.config);
  const response = await ctx.http.request({
    method: "POST",
    url: `${config.parentBaseUrl}/federation/exports`,
    headers: { "content-type": "application/json" },
    body: { peer: config.selfPeerName, sinceSequence: cursor.sequence }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`federation-https pull: parent returned HTTP ${response.status}`);
  }
  const bundle = response.body as {
    header: { exporterDomainId: string; throughSequence: number };
    entries: unknown[];
    checksum: string;
    bundleSignature: string;
  };
  return [
    {
      originDomainId: bundle.header.exporterDomainId,
      sequence: bundle.header.throughSequence,
      contentHash: bundle.checksum,
      signature: bundle.bundleSignature,
      entries: bundle.entries
    }
  ];
}

/** Pushes this domain's own status/audit segment TO the parent — a `POST /federation/imports`
 *  dialed by the child, carrying THIS domain's own signed bundle (the parent applies it through
 *  the exact same fail-closed `importSyncBundle` path any import goes through — a child's push is
 *  not a trusted shortcut). `segment` here is expected to already be a full `.scpbundle` JSON
 *  payload (reconstructed by the caller from a real `exportSyncBundle` call against this domain's
 *  OWN journal) stashed across `entries`/`contentHash`/`signature` — see this module's doc for why
 *  the exact bundle envelope fields don't map 1:1 onto `JournalSegment`'s minimal shape; the
 *  caller is responsible for supplying a segment whose `entries` is literally the bundle body.
 */
async function push(
  ctx: PluginContext,
  segment: JournalSegment & { bundle?: unknown }
): Promise<void> {
  const config = asConfig(ctx.config);
  const body = segment.bundle ?? segment.entries;
  const response = await ctx.http.request({
    method: "POST",
    url: `${config.parentBaseUrl}/federation/imports`,
    headers: { "content-type": "application/json" },
    body
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`federation-https push: parent returned HTTP ${response.status}`);
  }
}

/** The live-connected transport doesn't itself produce/consume `.scpbundle` FILES — that's the
 *  built-in file transport (`scp federation export/import`, never routed through a plugin at
 *  all). Kept as explicit, clearly-erroring stubs rather than silently no-opping, so a
 *  misconfigured deployment fails loudly instead of appearing to "work" while doing nothing. */
async function exportBundle(_ctx: PluginContext, _opts: ExportOptions): Promise<BundleRef> {
  throw new Error(
    "federation-https does not implement file export — use `scp federation export` (the built-in file transport) for air-gapped/offline transfer"
  );
}
async function importBundle(_ctx: PluginContext, _bundle: BundleRef): Promise<ImportReport> {
  throw new Error(
    "federation-https does not implement file import — use `scp federation import` (the built-in file transport) for air-gapped/offline transfer"
  );
}

export const federationHttpsPlugin: FederationTransportPlugin = {
  push,
  pull,
  exportBundle,
  importBundle
};

export const manifest: PluginManifest = {
  id: "federation-https",
  kind: "federation-transport",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["parentBaseUrl", "selfPeerName"],
    properties: {
      parentBaseUrl: { type: "string", format: "uri" },
      selfPeerName: { type: "string", minLength: 1 }
    }
  }
};

export default federationHttpsPlugin;
