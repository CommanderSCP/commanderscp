/**
 * What the four LANGUAGE index plugins in this package share: one config shape, one HTTP call, and
 * — the part that carries the weight — one classifier turning a `ScopedHttpClient` failure into an
 * operator-legible {@link DependencyIndexUnavailableReason}.
 *
 * The classifier exists because of two hazards MEASURED IN THIS REPO, each of which otherwise
 * surfaces as an indistinguishable "the fetch blew up":
 *
 *  1. REDIRECTS ARE HARD-DISABLED on the plugin HTTP client. `plugin-host/subprocess-entry.ts`
 *     passes `redirect: "error"` on the one fetch every plugin request goes through, with the
 *     reason stated inline: "a 3xx could re-point the request at an internal host AFTER the
 *     pre-flight egress check". Public package registries redirect
 *     ROUTINELY — `registry.npmjs.org` and `pypi.org` both serve some paths through a CDN 301, and
 *     `repo1.maven.org` redirects bare-directory paths. So a perfectly reachable index fails, and
 *     it must not be reported as "unreachable": the remedy is "configure the FINAL url", which is
 *     an entirely different action from "open the firewall". Hence its own reason,
 *     {@link DependencyIndexUnavailableReason} `redirected`.
 *  2. THE HELM CHART'S EGRESS IS DEFAULT-DENY. `deploy/helm/templates/networkpolicy.yaml` installs
 *     a `policyTypes: [Ingress, Egress]` policy with no egress list (the default-deny base) and
 *     `values.yaml`'s `networkPolicy.executorEgress` is `[]` by default, so a chart-deployed
 *     instance reaches NOTHING but DNS and Postgres. A registry poll from such a pod fails at
 *     connect time — i.e. it arrives here as a PLUGIN HTTP ERROR, not as a configuration error,
 *     and an operator reading the Decision would otherwise conclude the registry is down. The
 *     `unreachable` detail below names the NetworkPolicy explicitly, because that is where the
 *     operator has to go.
 *
 * Everything here is pure except {@link fetchIndexDocument}, and that one takes its transport from
 * `ctx.http` — so the whole module is testable with `nock` fixtures over a real `node:https`-backed
 * `ScopedHttpClient` (nock@13 does NOT intercept `fetch`; see this package's tests).
 */
import type {
  DependencyIndexResult,
  DependencyIndexUnavailableReason,
  PluginContext
} from "@scp/plugin-api";

/**
 * Every language index plugin's config. `baseUrl` is OPERATOR-supplied, never tenant-supplied: the
 * server resolves it from its own env (`apps/server/src/dependencies/version-index.ts`) and passes
 * it as the plugin instance's config, alongside an `allowedHosts` entry derived from that same URL.
 *
 * THERE IS NO DEFAULT URL, ON PURPOSE. An unset `baseUrl` makes this ecosystem report
 * `not_configured`, which is the AIR-GAP DEFAULT (charter principle 5: "no runtime network calls to
 * the outside world" — a shipped default of `proxy.golang.org` would make every fresh install phone
 * home on its first daily tick). An operator opts a public index in explicitly.
 */
export interface DependencyIndexHttpConfig {
  baseUrl?: string;
  /** Extra request headers (a mirror's auth token, a corporate proxy's header). */
  headers?: Record<string, string>;
  /** Wall-clock budget for one index request. Default 15s — enforced here rather than left to the
   *  host's RPC timeout, so a hanging registry becomes an `unreachable` VERDICT (which is legible in
   *  a Decision) instead of a killed subprocess (which is not). */
  timeoutMs?: number;
}

export const DEFAULT_INDEX_TIMEOUT_MS = 15_000;

/** The `configSchema` body every plugin in this package publishes. `additionalProperties: false`
 *  for the same reason `managed-scan`'s is: a config key nobody reads is a key a later reader
 *  mistakes for behaviour, and `plugin-manifests.ts`'s `validatePluginConfig` is the write-door gate
 *  that turns this into a 400 rather than a surprise. */
export function indexConfigSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      baseUrl: { type: "string" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      timeoutMs: { type: "number" }
    }
  };
}

export function unavailable(
  reason: DependencyIndexUnavailableReason,
  detail: string
): DependencyIndexResult & { status: "unavailable" } {
  return { status: "unavailable", reason, detail };
}

/**
 * Does this thrown value — or anything in its `cause` chain — say "redirect"?
 *
 * The chain walk is the whole point. Node's `fetch` with `redirect: "error"` rejects with a bland
 * `TypeError: fetch failed` and puts the real diagnosis (`unexpected redirect`) in `err.cause`;
 * undici's own `fetch` nests it one deeper again. Matching only `err.message` therefore classifies
 * every redirect as `unreachable` and hands the operator the wrong remedy — which is precisely the
 * silent failure hazard 1 above describes.
 */
export function isRedirectError(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
    const message = cursor instanceof Error ? cursor.message : String(cursor);
    if (/redirect/i.test(message)) return true;
    cursor = cursor instanceof Error ? (cursor.cause as unknown) : undefined;
  }
  return false;
}

/** Does the chain name the plugin host's own egress refusal? Reported as `unreachable` (the request
 *  genuinely never left) but with a detail that names the ALLOWLIST rather than the network, since
 *  that is the knob. `egress-guard.ts` phrases its refusals with "not allowed"/"blocked". */
function isEgressRefusal(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
    const message = cursor instanceof Error ? cursor.message : String(cursor);
    if (/egress|allowlist|not allowed|blocked/i.test(message)) return true;
    cursor = cursor instanceof Error ? (cursor.cause as unknown) : undefined;
  }
  return false;
}

/** The one place a transport throw becomes a reason. Exported for its own unit test: a classifier
 *  that silently collapses to `unreachable` reproduces exactly the "one indistinguishable failure"
 *  this module exists to prevent, and would still pass every happy-path fixture. */
export function classifyTransportError(
  err: unknown,
  url: string
): DependencyIndexResult & { status: "unavailable" } {
  const message = err instanceof Error ? err.message : String(err);
  if (isRedirectError(err)) {
    return unavailable(
      "redirected",
      `${url} answered a redirect. The plugin HTTP client refuses to follow redirects by design ` +
        `(plugin-host/subprocess-entry.ts: a 3xx can re-point a request at an internal host AFTER ` +
        `the pre-flight egress check), and public registries redirect routinely. Configure this ` +
        `ecosystem's index at its FINAL url — this is not a connectivity problem: ${message}`
    );
  }
  if (isEgressRefusal(err)) {
    return unavailable(
      "unreachable",
      `${url} was refused by the plugin egress guard before the request was dispatched — the host ` +
        `is not on this plugin instance's allowedHosts, or resolves to a blocked internal range: ${message}`
    );
  }
  return unavailable(
    "unreachable",
    `${url} could not be reached: ${message}. On a Helm-deployed instance this is the FIRST thing ` +
      `to check and it is a CONFIGURATION problem, not an outage: the chart's NetworkPolicy is ` +
      `DEFAULT-DENY egress (deploy/helm/templates/networkpolicy.yaml) with ` +
      `networkPolicy.executorEgress empty by default, so nothing but DNS and Postgres is reachable ` +
      `until an operator adds an egress rule for this index`
  );
}

/** A successful index read, or the reason it was not one. `body` is whatever `ScopedHttpResponse`
 *  carried: a parsed object for a JSON index, a raw string for a text/XML one. */
export type IndexDocument =
  { status: "ok"; body: unknown } | (DependencyIndexResult & { status: "unavailable" });

/**
 * One GET through the host-mediated, egress-guarded `ctx.http`, with every failure mode mapped.
 *
 * A 3xx STATUS IS CHECKED EXPLICITLY as well as caught. `redirect: "error"` turns a redirect WITH a
 * `Location` into a throw, but a 3xx without one (a bare 304, a 300 with no Location) is delivered
 * as an ordinary response — and treating that as a document would hand a parser an empty body and
 * report `malformed_response`, sending the operator to the wrong place. Both routes converge on
 * `redirected`.
 */
export async function fetchIndexDocument(
  ctx: PluginContext,
  url: string,
  config: DependencyIndexHttpConfig
): Promise<IndexDocument> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS;
  let response;
  // The timer is CLEARED once the race settles, whichever side won. Losing the race does not
  // cancel a `setTimeout`: every call that answered in time used to leave a live timer behind,
  // holding its closure until the deadline passed, on a path polled per ecosystem per tick.
  // (`unref` keeps it from blocking process exit; it does not make it free.)
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      ctx.http.request({ method: "GET", url, headers: config.headers ?? {} }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`index request exceeded ${timeoutMs}ms`)),
          timeoutMs
        );
        timer.unref?.();
      })
    ]);
  } catch (err) {
    return classifyTransportError(err, url);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    return unavailable(
      "redirected",
      `${url} answered ${response.status}. Redirects are not followed by design ` +
        `(plugin-host/subprocess-entry.ts) — configure this ecosystem's index at its final url`
    );
  }
  if (response.status === 401 || response.status === 403) {
    return unavailable(
      "unauthorized",
      `${url} answered ${response.status} — this index requires a credential this plugin instance ` +
        `was not given`
    );
  }
  if (response.status === 404 || response.status === 410) {
    return unavailable("unknown_coordinate", `${url} answered ${response.status}`);
  }
  if (response.status < 200 || response.status >= 300) {
    return unavailable("unreachable", `${url} answered ${response.status}`);
  }
  return { status: "ok", body: response.body };
}

/** `baseUrl` with any trailing slash removed, so joins below are unambiguous. */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** The `not_configured` answer, spelled once. This is the AIR-GAP DEFAULT and the reason the whole
 *  `unavailable` channel exists (ADR-0032 §7): reporting it as "no new version" would be
 *  indistinguishable from "up to date" and would silently stop every subscription. */
export function notConfigured(ecosystem: string, envHint: string): DependencyIndexResult {
  return unavailable(
    "not_configured",
    `no ${ecosystem} index is configured on this deployment (set ${envHint}). This is the ` +
      `air-gap default and it is NOT "no new version": nothing was asked, so nothing is known`
  );
}

/** The digest answer every LANGUAGE index gives. Content digests are an OCI notion; a language
 *  registry publishes hashes per ARTIFACT FILE, not one identity per version, so reporting one here
 *  would be an invention. `@scp/plugin-dependency-index-oci` is the only plugin that answers. */
export function noDigest(ecosystem: string): {
  status: "unavailable";
  reason: DependencyIndexUnavailableReason;
  detail: string;
} {
  return {
    status: "unavailable",
    reason: "no_digest",
    detail: `the ${ecosystem} index reports no content digest for a version — only OCI does`
  };
}
