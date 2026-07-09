/**
 * @scp/schemas — the single contract source (DESIGN.md §6, §15). Zod schemas flow untranslated
 * from the server (route validation + OpenAPI emission) to the generated SDK and, later, IaC.
 */
export * from "./common.js";
export * from "./objects.js";
export * from "./auth.js";
