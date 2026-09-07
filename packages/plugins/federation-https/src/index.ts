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

/** The connected and intermittent federation transport. See docs/plugins.md §73. */

export interface FederationHttpsConfig {
  /** The commander's public API base URL (e.g. `https://commander.example.com/api/v1`) — set on
   *  this domain's OWN peer record for the commander (federation_peers.base_url), surfaced into
   *  plugin config by the host. Always DIALED, never listened on (outpost-initiated-only). */
  commanderBaseUrl: string;
  /** This domain's own name/id as registered with the commander — the `peer` identifier the
   *  commander's `/federation/exports` expects. */
  selfPeerName: string;
}

function asConfig(config: unknown): FederationHttpsConfig {
  const c = config as Partial<FederationHttpsConfig> | undefined;
  if (!c?.commanderBaseUrl || !c.selfPeerName) {
    throw new Error(
      "federation-https: config.commanderBaseUrl and config.selfPeerName are required"
    );
  }
  return { commanderBaseUrl: c.commanderBaseUrl, selfPeerName: c.selfPeerName };
}

/** Pulls the commander's config-journal since `cursor.sequence`. See docs/plugins.md §74. */
async function pull(ctx: PluginContext, cursor: DomainCursor): Promise<JournalSegment[]> {
  const config = asConfig(ctx.config);
  const response = await ctx.http.request({
    method: "POST",
    url: `${config.commanderBaseUrl}/federation/exports`,
    headers: { "content-type": "application/json" },
    body: { peer: config.selfPeerName, sinceSequence: cursor.sequence }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`federation-https pull: commander returned HTTP ${response.status}`);
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

/** Pushes this domain's own status/audit segment TO the commander. See docs/plugins.md §75. */
async function push(
  ctx: PluginContext,
  segment: JournalSegment & { bundle?: unknown }
): Promise<void> {
  const config = asConfig(ctx.config);
  const body = segment.bundle ?? segment.entries;
  const response = await ctx.http.request({
    method: "POST",
    url: `${config.commanderBaseUrl}/federation/imports`,
    headers: { "content-type": "application/json" },
    body
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`federation-https push: commander returned HTTP ${response.status}`);
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
    required: ["commanderBaseUrl", "selfPeerName"],
    properties: {
      commanderBaseUrl: { type: "string", format: "uri" },
      selfPeerName: { type: "string", minLength: 1 }
    }
  }
};

export default federationHttpsPlugin;
