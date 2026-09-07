import { provisionWorkerDatabase } from "./db-clone.js";

/** The setup entry that runs inside each worker fork. See docs/test-support.md §35. */
await provisionWorkerDatabase();
