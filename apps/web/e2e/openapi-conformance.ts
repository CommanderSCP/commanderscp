import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M16.2 phase B (B4) — THE NO-BYPASS MATCHER.
 *
 * Charter principle 3: "The UI and CLI consume only the generated SDK; nothing may bypass the public
 * API." Reading the source catches a hand-written `fetch("/api/v1/…")` only if a reviewer notices
 * it. `outposts-no-bypass.spec.ts` checks it from the OUTSIDE instead — it captures every request
 * the browser makes while walking the Outposts UI and asks, of each one, whether the EMITTED
 * OpenAPI document declares that method+path.
 *
 * This module is the "whether" half, kept separate from the spec on purpose: the spec is main-only
 * (every E2E job in `.github/workflows/ci.yml` is gated on `push` to `main`), and a matcher that
 * silently accepted everything would turn that whole check into a no-op with nothing failing.
 * `openapi-conformance.test.ts` runs it under Vitest on every PR, including the cases that must be
 * REJECTED.
 *
 * No Playwright import here — that is what makes it unit-testable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The OpenAPI document's declared server prefix (`servers: [{ url: "/api/v1" }]`). */
export const API_PREFIX = "/api/v1";

export interface OpenApiDocument {
  paths: Record<string, Record<string, unknown>>;
}

export interface Operation {
  method: string;
  template: string;
  pattern: RegExp;
}

export interface ApiCall {
  method: string;
  path: string;
}

/** The emitted contract, read from the repo — deliberately the FILE the SDK is generated from and
 *  the oasdiff gate runs against, never a list re-typed here: a test that carries its own copy of
 *  the truth can agree with a browser that is wrong. */
export function loadOpenApiDocument(
  file = path.resolve(__dirname, "../../../tools/openapi/openapi.v1.json")
): OpenApiDocument {
  return JSON.parse(readFileSync(file, "utf8")) as OpenApiDocument;
}

const HTTP_METHODS = ["get", "put", "post", "patch", "delete", "head", "options"];

/**
 * `/federation/outposts/{peerDomainId}` → an anchored regex matching one concrete path SEGMENT per
 * template parameter.
 *
 * `[^/]+` rather than `.+` is the load-bearing part: with `.+`, the template
 * `/federation/outposts/{peerDomainId}` would also match
 * `/federation/outposts/anything/at/all/undeclared`, and the whole sweep would accept paths the
 * contract does not declare.
 */
export function templateToRegExp(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^/]+?\\\}/g, "[^/]+")}$`);
}

export function operationsOf(doc: OpenApiDocument): Operation[] {
  const out: Operation[] = [];
  for (const [template, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.includes(method.toLowerCase())) continue;
      out.push({ method: method.toUpperCase(), template, pattern: templateToRegExp(template) });
    }
  }
  return out;
}

export function isDeclaredOperation(operations: Operation[], call: ApiCall): boolean {
  return operations.some((op) => op.method === call.method && op.pattern.test(call.path));
}

/** Every captured call the contract does NOT declare. */
export function undeclaredCalls(operations: Operation[], captured: ApiCall[]): ApiCall[] {
  return captured.filter((call) => !isDeclaredOperation(operations, call));
}

/**
 * THE ONE KNOWN, PRE-EXISTING GAP — named here rather than papered over, because a sweep that
 * silently tolerated it would tolerate the next one too.
 *
 * `GET /api/v1/events/stream` is the SSE live-update channel (`apps/server/src/routes/events.ts`,
 * DESIGN §6/§8, M2). It is registered as a raw `app.get`, NOT through the `typed.route` wrapper the
 * OpenAPI emitter reads, so it is absent from `tools/openapi/openapi.v1.json` — and
 * `apps/web/src/lib/use-event-stream.ts` opens it with a hand-built URL and a raw `EventSource`,
 * from `RootLayout`, i.e. on EVERY page including this one.
 *
 * That is a genuine charter-principle-3 gap and it PREDATES this milestone by many increments (M2).
 * Fixing it means either declaring the operation in the contract or routing SSE through the SDK —
 * both server/SDK changes, and out of scope for a UI phase. What this milestone can honestly do is
 * make the exemption EXPLICIT, EXACT and TESTED: it is one method+path, it is asserted to be exactly
 * one entry, and `undeclaredCalls` (above) still flags it — so the exemption is visible as an
 * exemption rather than as an absence of evidence.
 */
export const UNDECLARED_BY_DESIGN: readonly ApiCall[] = [{ method: "GET", path: "/events/stream" }];

function isExempt(call: ApiCall): boolean {
  return UNDECLARED_BY_DESIGN.some(
    (known) => known.method === call.method && known.path === call.path
  );
}

/** The sweep's actual pass condition: every captured call is either a declared operation or the one
 *  named, pre-existing exemption above. Empty is the pass. */
export function unexpectedCalls(operations: Operation[], captured: ApiCall[]): ApiCall[] {
  return undeclaredCalls(operations, captured).filter((call) => !isExempt(call));
}

/** The API path a request URL addressed, or `null` when it is not an API call at all (the SPA's own
 *  HTML/JS/CSS). Query strings are dropped: a path is what an OpenAPI `paths` key names. */
export function apiPathOf(url: string): string | null {
  const { pathname } = new URL(url, "http://placeholder.invalid");
  if (!pathname.startsWith(`${API_PREFIX}/`)) return null;
  return pathname.slice(API_PREFIX.length);
}
