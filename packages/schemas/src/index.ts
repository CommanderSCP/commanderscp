/**
 * @scp/schemas — the single contract source (DESIGN.md §6, §15). Zod schemas flow untranslated
 * from the server (route validation + OpenAPI emission) to the generated SDK and, later, IaC.
 */
export * from "./common.js";
export * from "./domain-ids.js";
export * from "./objects.js";
export * from "./auth.js";
export * from "./graph.js";
export * from "./audit.js";
export * from "./registries.js";
export * from "./iac.js";
export * from "./changes.js";
export * from "./governance.js";
export * from "./supply-chain.js";
export * from "./scan-db.js";
export * from "./services.js";
export * from "./components.js";
export * from "./campaigns.js";
export * from "./federation.js";
export * from "./executors.js";
export * from "./health.js";
export * from "./events.js";
export * from "./doctor.js";
export * from "./dependencies.js";
