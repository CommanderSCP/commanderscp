/** The four language-ecosystem version indexes. See docs/plugins.md §47. */
import type {
  DependencyIndexCapabilities,
  DependencyIndexDigestResult,
  DependencyIndexPlugin,
  DependencyIndexQuery,
  DependencyIndexResult,
  DependencyIndexVersion,
  PluginContext,
  PluginManifest
} from "@scp/plugin-api";
import {
  fetchIndexDocument,
  indexConfigSchema,
  noDigest,
  notConfigured,
  trimBase,
  unavailable,
  type DependencyIndexHttpConfig
} from "./common.js";

export type { DependencyIndexHttpConfig } from "./common.js";
export { classifyTransportError, isRedirectError } from "./common.js";

function readConfig(ctx: PluginContext): DependencyIndexHttpConfig {
  return (ctx.config ?? {}) as DependencyIndexHttpConfig;
}

/** Duplicates are dropped and order is preserved as the index gave it. Order carries no meaning to
 *  the server (it ranks for itself), but preserving it keeps a fixture diff readable. */
function toVersions(raw: Iterable<string>): DependencyIndexVersion[] {
  const seen = new Set<string>();
  const out: DependencyIndexVersion[] = [];
  for (const value of raw) {
    const version = value.trim();
    if (version.length === 0 || seen.has(version)) continue;
    seen.add(version);
    out.push({ version });
  }
  return out;
}

/** The module proxy's case encoding, which is not optional. See docs/plugins.md §48. */
export function escapeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (ch) => `!${ch.toLowerCase()}`);
}

/** The list endpoint returns plain text, one version a line. See docs/plugins.md §49. */
export function createGoIndexPlugin(): DependencyIndexPlugin {
  return {
    describeIndex(): DependencyIndexCapabilities {
      return { ecosystem: "go", reportsDigest: false };
    },
    async resolveDigest(): Promise<DependencyIndexDigestResult> {
      return noDigest("go");
    },
    async listVersions(
      ctx: PluginContext,
      query: DependencyIndexQuery
    ): Promise<DependencyIndexResult> {
      const config = readConfig(ctx);
      if (!config.baseUrl) return notConfigured("go", "SCP_DEPENDENCY_INDEX_GO_URL");
      const url = `${trimBase(config.baseUrl)}/${escapeGoModulePath(query.coordinate)}/@v/list`;
      const doc = await fetchIndexDocument(ctx, url, config);
      if (doc.status !== "ok") return doc;
      // The body is undefined for an empty response, not null. See docs/plugins.md §50.
      const text = doc.body === undefined ? "" : doc.body;
      if (typeof text !== "string") {
        return unavailable(
          "malformed_response",
          `${url} did not return the text/plain version list the module proxy protocol defines`
        );
      }
      return { status: "available", versions: toVersions(text.split("\n")) };
    }
  };
}

export const goIndexManifest: PluginManifest = {
  id: "dependency-index-go",
  kind: "dependency-index",
  version: "0.1.0",
  configSchema: indexConfigSchema()
};

/** A scoped name's slash is percent-encoded (`@acme/lib` → `@acme%2flib`) and nothing else is:
 *  encoding the `@` too yields a 404 from the real registry. */
export function encodeNpmName(name: string): string {
  return name.replace("/", "%2f");
}

/** `GET {base}/{name}` with the ABBREVIATED packument `Accept`. See docs/plugins.md §51. */
export function createNpmIndexPlugin(): DependencyIndexPlugin {
  return {
    describeIndex(): DependencyIndexCapabilities {
      return { ecosystem: "npm", reportsDigest: false };
    },
    async resolveDigest(): Promise<DependencyIndexDigestResult> {
      return noDigest("npm");
    },
    async listVersions(
      ctx: PluginContext,
      query: DependencyIndexQuery
    ): Promise<DependencyIndexResult> {
      const config = readConfig(ctx);
      if (!config.baseUrl) return notConfigured("npm", "SCP_DEPENDENCY_INDEX_NPM_URL");
      const url = `${trimBase(config.baseUrl)}/${encodeNpmName(query.coordinate)}`;
      const doc = await fetchIndexDocument(ctx, url, {
        ...config,
        headers: { accept: "application/vnd.npm.install-v1+json", ...(config.headers ?? {}) }
      });
      if (doc.status !== "ok") return doc;
      const body = doc.body as { versions?: unknown } | null;
      const versions = body?.versions;
      if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
        return unavailable(
          "malformed_response",
          `${url} returned a document with no 'versions' object — not an npm packument`
        );
      }
      return { status: "available", versions: toVersions(Object.keys(versions)) };
    }
  };
}

export const npmIndexManifest: PluginManifest = {
  id: "dependency-index-npm",
  kind: "dependency-index",
  version: "0.1.0",
  configSchema: indexConfigSchema()
};

/** One PyPI release file, as `releases[version][]` really carries it. Only `yanked` is read. */
interface PypiReleaseFile {
  yanked?: unknown;
}

/** `GET {base}/pypi/{name}/json` — the real shape. See docs/plugins.md §52. */
export function createPypiIndexPlugin(): DependencyIndexPlugin {
  return {
    describeIndex(): DependencyIndexCapabilities {
      return { ecosystem: "python", reportsDigest: false };
    },
    async resolveDigest(): Promise<DependencyIndexDigestResult> {
      return noDigest("python");
    },
    async listVersions(
      ctx: PluginContext,
      query: DependencyIndexQuery
    ): Promise<DependencyIndexResult> {
      const config = readConfig(ctx);
      if (!config.baseUrl) return notConfigured("python", "SCP_DEPENDENCY_INDEX_PYTHON_URL");
      const url = `${trimBase(config.baseUrl)}/pypi/${encodeURIComponent(query.coordinate)}/json`;
      const doc = await fetchIndexDocument(ctx, url, config);
      if (doc.status !== "ok") return doc;
      const body = doc.body as { releases?: unknown } | null;
      const releases = body?.releases;
      if (!releases || typeof releases !== "object" || Array.isArray(releases)) {
        return unavailable(
          "malformed_response",
          `${url} returned a document with no 'releases' object — not the PyPI JSON API`
        );
      }
      const usable: string[] = [];
      for (const [version, files] of Object.entries(releases as Record<string, unknown>)) {
        if (!Array.isArray(files) || files.length === 0) continue;
        const allYanked = (files as PypiReleaseFile[]).every((file) => file?.yanked === true);
        if (allYanked) continue;
        usable.push(version);
      }
      return { status: "available", versions: toVersions(usable) };
    }
  };
}

export const pypiIndexManifest: PluginManifest = {
  id: "dependency-index-pypi",
  kind: "dependency-index",
  version: "0.1.0",
  configSchema: indexConfigSchema()
};

/** `com.acme:lib` → `com/acme/lib`. A coordinate with no `:` cannot address a Maven artifact at
 *  all, so it is refused rather than turned into a plausible-looking path. */
export function mavenMetadataPath(coordinate: string): string | null {
  const colon = coordinate.indexOf(":");
  if (colon <= 0 || colon === coordinate.length - 1) return null;
  const groupId = coordinate.slice(0, colon);
  const artifactId = coordinate.slice(colon + 1);
  if (artifactId.includes(":")) return null; // group:artifact:version is not a LINE coordinate.
  return `${groupId.split(".").join("/")}/${artifactId}/maven-metadata.xml`;
}

/** Pull the version texts out of a real Maven metadata file. See docs/plugins.md §53. */
export function parseMavenMetadataVersions(xml: string): string[] | null {
  // `<versions/>` and `<versions></versions>` both mean "this artifact publishes nothing", which is
  // a TRUE fact and must return `[]` — only the ABSENCE of the block returns `null`. The first cut
  // tested the captured group for truthiness, which made an empty block indistinguishable from a
  // document that is not maven-metadata.xml at all (caught by this file's negative control).
  if (/<versions\s*\/>/i.test(xml)) return [];
  const block = /<versions\b[^>]*>([\s\S]*?)<\/versions>/i.exec(xml);
  if (block === null || block[1] === undefined) return null;
  const out: string[] = [];
  const version = /<version\b[^>]*>([\s\S]*?)<\/version>/gi;
  let match = version.exec(block[1]);
  while (match !== null) {
    if (match[1] !== undefined) out.push(match[1].trim());
    match = version.exec(block[1]);
  }
  return out;
}

export function createMavenIndexPlugin(): DependencyIndexPlugin {
  return {
    describeIndex(): DependencyIndexCapabilities {
      return { ecosystem: "maven", reportsDigest: false };
    },
    async resolveDigest(): Promise<DependencyIndexDigestResult> {
      return noDigest("maven");
    },
    async listVersions(
      ctx: PluginContext,
      query: DependencyIndexQuery
    ): Promise<DependencyIndexResult> {
      const config = readConfig(ctx);
      if (!config.baseUrl) return notConfigured("maven", "SCP_DEPENDENCY_INDEX_MAVEN_URL");
      const path = mavenMetadataPath(query.coordinate);
      if (path === null) {
        return unavailable(
          "unknown_coordinate",
          `'${query.coordinate}' is not a Maven groupId:artifactId coordinate — refusing to guess a path`
        );
      }
      const url = `${trimBase(config.baseUrl)}/${path}`;
      const doc = await fetchIndexDocument(ctx, url, config);
      if (doc.status !== "ok") return doc;
      if (typeof doc.body !== "string") {
        return unavailable("malformed_response", `${url} did not return XML`);
      }
      const versions = parseMavenMetadataVersions(doc.body);
      if (versions === null) {
        return unavailable(
          "malformed_response",
          `${url} has no <versions> block — not a maven-metadata.xml document`
        );
      }
      return { status: "available", versions: toVersions(versions) };
    }
  };
}

export const mavenIndexManifest: PluginManifest = {
  id: "dependency-index-maven",
  kind: "dependency-index",
  version: "0.1.0",
  configSchema: indexConfigSchema()
};
