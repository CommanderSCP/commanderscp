import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempTrackedForFileSync } from "@scp/test-tmpdir";

/** Vitest `setupFiles` entry. See docs/test-support.md §36. */
process.env.SCP_PLUGIN_STATE_DIR = mkdtempTrackedForFileSync(join(tmpdir(), "scp-plugin-state-"));
