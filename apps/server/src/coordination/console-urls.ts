/**
 * CONSOLE URLs — where a HUMAN goes to look at the thing a pipeline node names.
 *
 * ============================================================================================
 * WHY THIS IS NOT `resolveProviderBaseUrl`
 * ============================================================================================
 * `git-provider-core`'s `resolveProviderBaseUrl` resolves the REST base URL an adapter CALLS —
 * `https://api.github.com`. That is precisely the URL a person must not be sent to. The web console
 * and the API endpoint are different addresses for the same system, and conflating them produces a
 * link that returns JSON to a browser. This module owns only the human-facing address; nothing here
 * is ever used to make a request.
 *
 * ============================================================================================
 * THE RULE: A LINK IS RETURNED ONLY WHEN IT IS KNOWN, NEVER GUESSED
 * ============================================================================================
 * Every function here returns `null` rather than a plausible-looking URL it cannot justify, and the
 * client renders an un-clickable node in that case. A dead link in an operator console is worse than
 * plain text: it is a claim that something is over there.
 *
 * Two cases where that bites, both real on the live estate:
 *
 *   - A `source_mappings.repo_pattern` is a PATTERN. `AgentKitProject/agentkit` is a literal repo
 *     and links fine; anything containing a glob names a set of repos, and there is no single page
 *     to open. Globbed patterns therefore return null.
 *   - An execution-system's `serverUrl` is the address SCP COORDINATES through, which for an
 *     in-cluster Argo CD is `http://argocd-server.argocd.svc.cluster.local` — correct for the server
 *     and useless in a browser. Operators can set `properties.webUrl` to the browsable address;
 *     `execution-system`'s registered property schema is open (`{"type":"object"}`, migration 0019),
 *     so that needs no migration. `webUrl` wins where set, and `serverUrl` is the fallback because
 *     for most deployments the two ARE the same host.
 */

/** A pattern that names a SET of repos has no single page to open. */
function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * A console link is rendered as a raw `href` in the SPA, so a `webUrl`/`serverUrl` of
 * `javascript:…` (or `data:`/`vbscript:`) would execute in the operator's browser when clicked —
 * stored XSS, since execution-system `properties` are operator-supplied and its property schema is
 * open (`{"type":"object"}`, migration 0019). Only `http(s)` addresses are browsable links; every
 * other scheme is dropped to null (an un-clickable node) at this single server choke point, which
 * every render site reaches via `executorConsoleUrl`. Returns the trimmed URL or null.
 */
function httpConsoleUrlOrNull(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimSlash(candidate);
}

/**
 * The web page for a source repo, or null when it cannot be known.
 *
 * Only `github` resolves today, and deliberately to `github.com` rather than to any configured host:
 * a `source_mappings` row carries no execution-system reference, so there is nothing to read a
 * GitHub Enterprise host from. `gitlab` and `gitea` are self-hosted-by-default and therefore return
 * null until a mapping can name its host — guessing `gitlab.com` would send an operator to a
 * stranger's repo, which is worse than not linking.
 */
export function repoConsoleUrl(sourceKind: string, repoPattern: string | null): string | null {
  if (!repoPattern || isGlob(repoPattern)) return null;
  const repo = repoPattern.replace(/^\/+|\/+$/g, "");
  if (!repo) return null;
  if (sourceKind === "github") return `https://github.com/${repo}`;
  return null;
}

/** The browsable base for an execution system: its `webUrl` if an operator set one, else the
 *  coordination `serverUrl`. See the module header on why those are not always the same. */
export function executionSystemConsoleBase(
  properties: Record<string, unknown> | null | undefined
): string | null {
  const webUrl = properties?.["webUrl"];
  if (typeof webUrl === "string" && webUrl.length > 0) {
    const safe = httpConsoleUrlOrNull(webUrl);
    if (safe) return safe;
    // A non-http(s) webUrl is not a browsable link — fall through to serverUrl rather than
    // returning a scheme that would execute in the browser.
  }
  const serverUrl = properties?.["serverUrl"];
  if (typeof serverUrl === "string" && serverUrl.length > 0) return httpConsoleUrlOrNull(serverUrl);
  return null;
}

/**
 * The page for ONE bound thing inside an execution system — the Argo CD application, the GitHub
 * Actions workflow list — or null.
 *
 * `kind` is the execution-system's own `properties.kind` (`argocd`, `github`, …), NOT the binding's
 * routing Type: two bindings of the same Type can live in different systems, and it is the system
 * that decides the URL shape.
 */
export function executorConsoleUrl(input: {
  kind: string | null;
  base: string | null;
  externalRef: string | null;
}): string | null {
  const ref = input.externalRef?.trim();
  switch (input.kind) {
    case "argocd":
      // Argo CD's own UI route. Without a ref there is no application to open — the system's root
      // is still useful, so it is returned rather than nothing.
      if (!input.base) return null;
      return ref ? `${input.base}/applications/${encodeURIComponent(ref)}` : input.base;
    case "github":
      // A GitHub binding's `externalRef` is the `owner/repo` whose Actions run the pipeline. The
      // base is ignored on purpose: it is an API host (`api.github.com`) for this provider.
      if (!ref || isGlob(ref) || !ref.includes("/")) return null;
      return `https://github.com/${ref}/actions`;
    default:
      // An unknown system still has a home page worth opening, but nothing can be said about where
      // one binding lives inside it.
      return input.base;
  }
}
