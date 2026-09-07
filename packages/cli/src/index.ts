/** @scp/cli — `scp`: commander over @scp/sdk only (DESIGN.md §15). */
export { buildProgram, runCli } from "./cli.js";

/** The estate reader, exported so the server test can drive it. See docs/cli.md §125. */
export { readServiceExportSpec, type ExportEstateOptions } from "./iac-estate-reader.js";
