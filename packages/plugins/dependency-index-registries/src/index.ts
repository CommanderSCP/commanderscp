/**
 * `@scp/plugin-dependency-index-registries` — the FOUR LANGUAGE-ECOSYSTEM version indexes behind
 * ADR-0032 §7's third-party detection: the Go module proxy, the npm registry, PyPI, and a Maven
 * repository. The fifth ecosystem, container images, is `@scp/plugin-dependency-index-oci`: it
 * reaches a registry through the EXISTING vendored-skopeo channel rather than over `ctx.http`, so it
 * shares no transport with these and lives in its own package.
 *
 * FOUR PLUGINS, ONE PACKAGE — the `github`/`github-discovery` shape exactly. One subprocess-hosted
 * instance loads exactly one plugin, so each ecosystem gets its own `PluginModule` name
 * (`dependency-index-go`, `-npm`, `-pypi`, `-maven`) resolving to its own factory in this package.
 * The alternative — four packages differing only in a URL template and a body parser — would be
 * four copies of `common.ts`'s failure classifier, which is the one part that must not drift.
 *
 * WHAT THESE PLUGINS DO NOT DO, and it is the load-bearing half (ADR-0032 §7, "NEVER GUESS A
 * VERSION"): they do not rank, do not pick a "latest", do not filter to the major line, and do not
 * skip anything they do not understand. They return the index's own list, verbatim, in the index's
 * own spelling. Line membership and ordering are computed in ONE server-side place
 * (`apps/server/src/dependencies/version-index.ts`) over `@scp/dependency-manifests`'s single
 * `parseComparableVersion`/`compareVersions` pair. Four plugins each deciding what "newest" means
 * is four places for `"9" > "10"` to come back.
 *
 * AIR-GAP (charter principle 5): none of these has a default URL. Unconfigured, every one reports
 * `not_configured` — an explicit UNAVAILABLE, never an empty version list, because "nothing answered"
 * and "nothing newer exists" are opposite facts that produce identical bumps (none) and would make a
 * disconnected estate look permanently up to date.
 */
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

/**
 * The module proxy's CASE-ENCODING, which is not optional and not cosmetic.
 *
 * The proxy protocol requires every uppercase letter in a module path to be written as `!` followed
 * by its lowercase form, "to avoid ambiguity when serving from case-insensitive file systems".
 * `github.com/Masterminds/semver/v3` is fetched as `github.com/!masterminds/semver/v3`; sending the
 * raw path gets a 404 from `proxy.golang.org`, which this plugin would faithfully report as
 * `unknown_coordinate` — a correct-looking answer to a question we asked wrong, and one that would
 * silently exclude every capitalised module (a large share of real go.mod files) from detection.
 *
 * The coordinate itself is stored and compared VERBATIM everywhere else (ADR-0032 Context 2); this
 * encoding exists only inside the URL and never travels back out.
 */
export function escapeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (ch) => `!${ch.toLowerCase()}`);
}

/**
 * `GET {base}/{escaped-module}/@v/list` — the real response is `text/plain`, one version per line,
 * UNORDERED, and legitimately EMPTY for a module with no tagged releases:
 *
 *     v1.0.0
 *     v1.1.0
 *     v1.2.0
 *
 * An empty body is therefore `available` with zero versions, NOT `malformed_response`: the module
 * exists and has no tagged version, which is a true fact about the line.
 */
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
      // `ScopedHttpResponse.body` is JSON-parsed when it parses and is `undefined` for an EMPTY
      // body — and an empty body is exactly what the proxy returns for a module with no tagged
      // release, so it must reach the `available, zero versions` branch rather than being reported
      // as a broken index. (Caught by "an EMPTY list body is 'available with zero versions'"; the
      // first cut of this check treated it as `malformed_response`.)
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

/**
 * `GET {base}/{name}` with the ABBREVIATED packument `Accept`. The real full document embeds every
 * version's complete `package.json` and reaches tens of megabytes for a long-lived package;
 * `application/vnd.npm.install-v1+json` is the registry's own documented, much smaller projection
 * and carries the only field this needs:
 *
 *     { "name": "lodash",
 *       "dist-tags": { "latest": "4.17.21" },
 *       "versions": { "4.17.20": { "dist": {...} }, "4.17.21": { "dist": {...} } } }
 *
 * `dist-tags.latest` is deliberately IGNORED. It is a mutable pointer the publisher controls and it
 * is frequently NOT on the subscribed major line at all (a package on v5 publishes `latest: 5.x`
 * while a component subscribes to the v4 line); reading it would put an off-line version forward as
 * this line's head, which is exactly the wrong-version-is-worse-than-none failure of ADR-0032 §7.
 */
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

/**
 * `GET {base}/pypi/{name}/json` — the real shape:
 *
 *     { "info": { "name": "requests", "version": "2.31.0" },
 *       "releases": { "2.30.0": [ { "filename": "...", "yanked": false } ],
 *                     "2.31.0": [ { "filename": "...", "yanked": false } ],
 *                     "0.0.1":  [] } }
 *
 * TWO KINDS OF ENTRY ARE EXCLUDED, and both are exclusions the INDEX ITSELF states rather than
 * inferences this plugin draws:
 *
 *  - a release whose files are ALL `yanked: true` — PEP 592's own "this release must not be
 *    selected by a resolver". Reporting it would let a subscription bump onto a version the
 *    publisher formally withdrew.
 *  - a release with NO files at all (`[]`) — PyPI keeps these as registered-but-unpublished
 *    versions; there is nothing to install, so it is not a version anything can move to.
 *
 * `info.version` is ignored for the same reason npm's `dist-tags.latest` is: it is the publisher's
 * newest overall, not this line's head.
 */
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

/**
 * Pull `<version>` texts out of the `<versions>` block of a real `maven-metadata.xml`:
 *
 *     <metadata>
 *       <groupId>org.springframework</groupId>
 *       <artifactId>spring-core</artifactId>
 *       <versioning>
 *         <latest>6.1.4</latest>
 *         <release>6.1.4</release>
 *         <versions><version>5.3.31</version><version>6.1.4</version></versions>
 *         <lastUpdated>20240215120000</lastUpdated>
 *       </versioning>
 *     </metadata>
 *
 * SCOPED TO THE `<versions>` BLOCK, not the whole document — `<latest>`/`<release>` are siblings
 * carrying version text too, and a document-wide scan would fold the publisher's "newest overall"
 * into the line's candidate set (the same mistake npm's `dist-tags` invites).
 *
 * Hand-rolled rather than pulling an XML library, for the reason `@scp/dependency-manifests`'s
 * `pom-xml.ts` states for itself: charter principle 5 wants these paths dependency-free and offline,
 * and the document is a fixed, tiny, machine-generated shape. Returns `null` — not an empty list —
 * when there is no `<versions>` block at all, so "this is not maven-metadata.xml" stays
 * distinguishable from "this artifact has no versions".
 */
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
