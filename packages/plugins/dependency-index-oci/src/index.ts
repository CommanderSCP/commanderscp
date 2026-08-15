/**
 * `@scp/plugin-dependency-index-oci` — the CONTAINER-IMAGE version index (ADR-0032 §7).
 *
 * THE ONE ECOSYSTEM WITH NO AIR-GAP GAP, and the reason it is built differently from its four
 * siblings: "in an air-gapped domain the org's OWN registry is the index" (ADR-0032 §7,
 * Consequences). There is no upstream feed to load, no public index to allowlist, and nothing to
 * degrade — the registry the org already runs answers `list-tags` for the images the org already
 * deploys. A disconnected commander therefore has FULL image detection while `go`/`npm`/`python`/
 * `maven` report `not_configured`, which is exactly the asymmetry `dependency-index-airgap.test.ts`
 * pins.
 *
 * REACH: THE EXISTING VENDORED-SKOPEO CHANNEL, NOT A SECOND MECHANISM. This repo already talks to
 * registries in exactly one way — the pinned, vendored `skopeo` resolved by `@scp/cosign`'s
 * `resolveSkopeo()` and guarded by the `SCP_ARTIFACT_OCI_REGISTRY_HOSTS` allowlist (ADR-0019 §4).
 * That is what `governance/scan-db.ts`'s connected refresh uses (`skopeo copy`), what
 * `federation/promotion-scan-step.ts` pulls artifact bytes with, and what
 * `federation/retrans-relay.ts` relays through. Adding a registry-v2 HTTP client here would create a
 * SECOND registry reach with its own auth handling, its own TLS trust decisions and its own
 * allowlist — one more place for a boundary to be enforced differently. So this plugin shells the
 * same binary, and the binary path plus the host allowlist are SERVER-INJECTED, never tenant config
 * — the same split `@scp/plugin-managed-scan` uses for `dockerBinary`/`runnerImage`/`networkMode`
 * (its "adversarial-review CRITICAL #1" shape).
 *
 * A MUTABLE TAG IS NOT AN IDENTITY (ADR-0032 §7). `listVersions` reports tags — labels a publisher
 * can repoint at any time — so `resolveDigest` exists and is implemented here alone among the five
 * indexes: what a subscription records for an image line is the DIGEST the tag resolved to, with the
 * tag beside it as a label.
 *
 * IT STILL DOES NOT RANK. Image tags are conspicuously not semver — `latest`, `1.2`, `1.2.3-alpine`
 * and date stamps coexist in one repository — and that is precisely why the ordering rule lives in
 * one server-side place over `@scp/dependency-manifests`'s `parseImageTagVersion`, which refuses a
 * single-component tag by default so a date stamp can never be compared against a major line. This
 * plugin returns the registry's tag list verbatim, `latest` included; nothing here decides.
 */
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

/**
 * The `host[:port]` an OCI repository coordinate names, or `null` when it names none.
 *
 * Identical rule to `governance/scan-db.ts`'s `ociHostOf`: the first path segment is a registry host
 * only if it is `localhost` or contains a `.` or a `:`. `alpine` and `library/alpine` name Docker
 * Hub IMPLICITLY, and this returns `null` for them — which fails closed, because an implicit host
 * cannot be checked against an allowlist. A coordinate must be registry-qualified
 * (`docker.io/library/alpine`), which is exactly how `DependencyCoordinateSchema` documents the
 * `oci` spelling.
 */
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

    /**
     * `skopeo list-tags docker://<repo>` — the real document is exactly:
     *
     *     { "Repository": "docker.io/library/alpine",
     *       "Tags": ["3.18", "3.18.4", "3.19", "3.19-alpine", "latest", "20240115"] }
     *
     * Returned VERBATIM, `latest` and date stamps included. Filtering here would move the
     * skip-never-guess rule (ADR-0032 §7) out of the single server-side ranking place and into a
     * plugin, where the next ecosystem would need its own copy of it.
     */
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

    /**
     * `skopeo inspect docker://<repo>:<tag>` — the real document carries `Digest` at top level:
     *
     *     { "Name": "docker.io/library/alpine", "Digest": "sha256:beef...", "Tag": "3.19", ... }
     *
     * A digest that is not a well-formed `sha256:<64 hex>` is REFUSED as `malformed_response` rather
     * than stored: `latest_digest` is what makes "the line is on 3.19" a statement about bytes, and
     * a malformed one would make it a statement about nothing while still looking answered.
     */
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
