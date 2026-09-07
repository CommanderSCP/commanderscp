import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** M16.2 phase B (B4) — THE NO-BYPASS MATCHER. Charter principle 3. See docs/web.md §17. */

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

/** A path template becomes an anchored regex for one match. See docs/web.md §18. */
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

export function undeclaredCalls(operations: Operation[], captured: ApiCall[]): ApiCall[] {
  return captured.filter((call) => !isDeclaredOperation(operations, call));
}

/** The sweep's pass condition. See docs/web.md §19. */
export function unexpectedCalls(operations: Operation[], captured: ApiCall[]): ApiCall[] {
  return undeclaredCalls(operations, captured);
}

/** The API path a request URL addressed, or `null` when it is not an API call at all (the SPA's own
 *  HTML/JS/CSS). Query strings are dropped: a path is what an OpenAPI `paths` key names. */
export function apiPathOf(url: string): string | null {
  const { pathname } = new URL(url, "http://placeholder.invalid");
  if (!pathname.startsWith(`${API_PREFIX}/`)) return null;
  return pathname.slice(API_PREFIX.length);
}
