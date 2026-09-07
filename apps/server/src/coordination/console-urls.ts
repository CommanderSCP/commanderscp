/** Console URLs: where a human goes to look at the thing. See docs/coordination.md §323. */

/** A pattern that names a SET of repos has no single page to open. */
function isGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A console link is a raw href, so the scheme is checked. See docs/coordination.md §324. */
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

/** The web page for a source repo, or null when unknown. See docs/coordination.md §325. */
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

/** The page for ONE bound thing inside an execution system. See docs/coordination.md §326. */
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
