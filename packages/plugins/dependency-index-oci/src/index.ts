/** The container-image version index. See docs/plugins.md §36. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DependencyIndexCapabilities,
  DependencyIndexDigestResult,
  DependencyIndexPlugin,
  DependencyIndexQuery,
  DependencyIndexResult,
  DependencyIndexUnavailableReason,
  DependencyIndexVersion,
  PluginContext,
  PluginManifest
} from "@scp/plugin-api";

const execFileAsync = promisify(execFile);

export interface OciIndexConfig {
  /** SERVER-INJECTED (never tenant): argv[0] for the pinned, vendored skopeo the server resolved
   *  with `@scp/cosign`'s `resolveSkopeo()`. Absent ⇒ this index is unavailable rather than falling
   *  back to whatever `skopeo` a PATH lookup finds — "pinned" must mean pinned (skopeo-bin.ts). */
  skopeoBinary?: string;
  /** SERVER-INJECTED (never tenant): the `host[:port]` entries this deployment may dial, parsed
   *  from the EXISTING `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist. Empty ⇒ nothing is reachable
   *  (fail-closed), symmetric with `artifact-verify.ts`'s `assertOciRegistryHostAllowed`. */
  allowedRegistryHosts?: string[];
  /** SERVER-INJECTED: registry hosts skopeo may talk to without TLS verification — the on-prem
   *  private-CA case `retrans-relay.ts` already carries. Never a blanket flag. */
  insecureRegistryHosts?: string[];
  /** ms before a skopeo invocation is killed. Default 60s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function readConfig(ctx: PluginContext): OciIndexConfig {
  return (ctx.config ?? {}) as OciIndexConfig;
}

/** The host an OCI repository coordinate names, or null. See docs/plugins.md §37. */
export function ociRegistryHostOfCoordinate(coordinate: string): string | null {
  const slash = coordinate.indexOf("/");
  if (slash <= 0) return null;
  const first = coordinate.slice(0, slash).toLowerCase();
  if (first === "localhost" || first.includes(".") || first.includes(":")) return first;
  return null;
}

function unavailable(
  reason: DependencyIndexUnavailableReason,
  detail: string
): DependencyIndexResult & { status: "unavailable" } {
  return { status: "unavailable", reason, detail };
}

/** Config + coordinate checks shared by both verbs. Returns the skopeo binary and the flags to use,
 *  or the `unavailable` answer that says which precondition failed. */
function prepare(
  ctx: PluginContext,
  coordinate: string
):
  | { bin: string; flags: string[]; timeoutMs: number }
  | (DependencyIndexResult & { status: "unavailable" }) {
  const config = readConfig(ctx);
  if (!config.skopeoBinary) {
    return unavailable(
      "not_configured",
      "no pinned skopeo was injected into this index instance — the server resolves it with " +
        "@scp/cosign's resolveSkopeo(); an unresolvable skopeo is reported, never worked around"
    );
  }
  const host = ociRegistryHostOfCoordinate(coordinate);
  if (host === null) {
    return unavailable(
      "unknown_coordinate",
      `'${coordinate}' names no registry host. An implicit Docker Hub coordinate cannot be checked ` +
        `against SCP_ARTIFACT_OCI_REGISTRY_HOSTS, so it is refused rather than dialled — write the ` +
        `line's coordinate registry-qualified (docker.io/library/alpine)`
    );
  }
  const allowed = (config.allowedRegistryHosts ?? []).map((h) => h.trim().toLowerCase());
  if (!allowed.includes(host)) {
    return unavailable(
      "unreachable",
      `registry host '${host}' is not in SCP_ARTIFACT_OCI_REGISTRY_HOSTS (fail-closed, ADR-0019 §4 ` +
        `— the same allowlist the promotion-scan pull and the retrans relay dial through). On a ` +
        `Helm-deployed instance also check the chart's DEFAULT-DENY egress NetworkPolicy: ` +
        `networkPolicy.executorEgress is empty by default, so even an allowlisted registry is ` +
        `unreachable until an egress rule exists`
    );
  }
  const insecure = (config.insecureRegistryHosts ?? []).map((h) => h.trim().toLowerCase());
  return {
    bin: config.skopeoBinary,
    // Per-host, exactly as skopeo's own `--src-tls-verify` is applied per-reference — never a
    // deployment-wide "turn TLS off".
    flags: insecure.includes(host) ? ["--tls-verify=false"] : [],
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}

/** skopeo reports "manifest unknown"/"name unknown"/"not found" for a repository that is not there,
 *  and "authentication required"/"unauthorized" for one this deployment may not read. Both are
 *  ordinary answers about a coordinate, not outages, so they get their own reasons — an operator
 *  chasing "unreachable" for a repository that simply does not exist is chasing the network. */
function classifySkopeoFailure(
  err: unknown,
  what: string
): DependencyIndexResult & { status: "unavailable" } {
  const message = err instanceof Error ? err.message : String(err);
  if (/unauthorized|authentication required|denied/i.test(message)) {
    return unavailable("unauthorized", `${what}: ${message}`);
  }
  if (/manifest unknown|name unknown|not found|repository name not known/i.test(message)) {
    return unavailable("unknown_coordinate", `${what}: ${message}`);
  }
  return unavailable("unreachable", `${what}: ${message}`);
}

export function createOciIndexPlugin(): DependencyIndexPlugin {
  return {
    describeIndex(): DependencyIndexCapabilities {
      return { ecosystem: "oci", reportsDigest: true };
    },

    /** `skopeo list-tags docker://<repo>`. See docs/plugins.md §38. */
    async listVersions(
      ctx: PluginContext,
      query: DependencyIndexQuery
    ): Promise<DependencyIndexResult> {
      const ready = prepare(ctx, query.coordinate);
      if ("status" in ready) return ready;
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          ready.bin,
          ["list-tags", ...ready.flags, `docker://${query.coordinate}`],
          { timeout: ready.timeoutMs, maxBuffer: 16 * 1024 * 1024 }
        ));
      } catch (err) {
        return classifySkopeoFailure(err, `skopeo list-tags docker://${query.coordinate}`);
      }
      let doc: { Tags?: unknown };
      try {
        doc = JSON.parse(stdout) as { Tags?: unknown };
      } catch {
        return unavailable(
          "malformed_response",
          `skopeo list-tags docker://${query.coordinate} did not return JSON`
        );
      }
      if (!Array.isArray(doc.Tags)) {
        return unavailable(
          "malformed_response",
          `skopeo list-tags docker://${query.coordinate} returned no 'Tags' array`
        );
      }
      const seen = new Set<string>();
      const versions: DependencyIndexVersion[] = [];
      for (const raw of doc.Tags) {
        if (typeof raw !== "string") continue;
        const tag = raw.trim();
        if (tag.length === 0 || seen.has(tag)) continue;
        seen.add(tag);
        versions.push({ version: tag });
      }
      return { status: "available", versions };
    },

    /** `skopeo inspect docker://<repo>:<tag>`. See docs/plugins.md §39. */
    async resolveDigest(
      ctx: PluginContext,
      ref: { coordinate: string; version: string }
    ): Promise<DependencyIndexDigestResult> {
      const ready = prepare(ctx, ref.coordinate);
      if ("status" in ready) return ready;
      const target = `docker://${ref.coordinate}:${ref.version}`;
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(ready.bin, ["inspect", ...ready.flags, target], {
          timeout: ready.timeoutMs,
          maxBuffer: 16 * 1024 * 1024
        }));
      } catch (err) {
        return classifySkopeoFailure(err, `skopeo inspect ${target}`);
      }
      let doc: { Digest?: unknown };
      try {
        doc = JSON.parse(stdout) as { Digest?: unknown };
      } catch {
        return unavailable("malformed_response", `skopeo inspect ${target} did not return JSON`);
      }
      const digest = typeof doc.Digest === "string" ? doc.Digest.trim().toLowerCase() : "";
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
        return unavailable(
          "malformed_response",
          `skopeo inspect ${target} reported no well-formed sha256 digest — refusing to record a ` +
            `tag with an identity that cannot be checked`
        );
      }
      return { status: "available", digest };
    }
  };
}

/** `additionalProperties: false` with NO server-governed key listed, exactly as `managed-scan`'s
 *  manifest omits `runnerImage`/`networkMode`: a binding that tries to set `skopeoBinary` or
 *  `allowedRegistryHosts` is refused at the write door (`plugin-manifests.ts`'s
 *  `validatePluginConfig`), and the server spreads those in when it provisions the instance. */
export const ociIndexManifest: PluginManifest = {
  id: "dependency-index-oci",
  kind: "dependency-index",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: { timeoutMs: { type: "number" } }
  }
};
