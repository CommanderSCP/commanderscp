/** Shared machinery for reading this repo's own source. See docs/source-census.md §13. */

export {
  exportedDeclarations,
  matchingParen,
  productionSourceFiles,
  readStripped,
  stripComments,
  type ExportedDeclaration
} from "./ts.js";

export { atLineStart, readHashStripped, stripHashComments } from "./hash.js";

export { trackedFiles } from "./tracked.js";

/** Proving a census's blind spot, not just reading source. See docs/source-census.md §14. */
export {
  SPAWN_OBSERVER_PRELOAD,
  observeNodeSpawns,
  type ObserveOptions,
  type ObservedRun,
  type ObservedSpawn
} from "./spawn-observer.js";
