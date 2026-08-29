/** @scp/cli — `scp`: commander over @scp/sdk only (DESIGN.md §15). */
export { buildProgram, runCli } from "./cli.js";

/**
 * The estate READER behind `scp iac export`, exported so the server's estate-migration test can
 * drive the real journey — export a live estate, synthesize, apply, assert adoption — rather than
 * re-implementing the read and proving only that its copy works.
 *
 * A test that reimplements the thing it is testing proves the reimplementation. This is the same
 * reader the CLI verb calls.
 */
export { readServiceExportSpec, type ExportEstateOptions } from "./iac-estate-reader.js";
