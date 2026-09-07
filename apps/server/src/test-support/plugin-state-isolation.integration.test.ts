import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginStateDir } from "../coordination/executor-bindings-repo.js";

/** THE INSTALLED-CHECK for `test-support/plugin-state-dir.ts`. See docs/test-support.md §37. */
const SHARED_DEFAULT = join(tmpdir(), "scp-plugin-state");

describe("executor plugin state is isolated per test file", () => {
  it("does not resolve to the fixed machine-global default every worker would share", () => {
    expect(pluginStateDir()).not.toBe(SHARED_DEFAULT);
  });

  it("resolves under this file's own tracked temp directory, so it is swept with the file", () => {
    const dir = pluginStateDir();
    expect(dir).toBe(process.env.SCP_PLUGIN_STATE_DIR);
    expect(dir.startsWith(`${SHARED_DEFAULT}-`)).toBe(true);
  });
});
