import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginStateDir } from "../coordination/executor-bindings-repo.js";

/**
 * THE INSTALLED-CHECK for `test-support/plugin-state-dir.ts` (see that file for the full finding).
 * A setup file that is written but not listed in `vitest.integration.config.ts`'s `setupFiles` is
 * inert while every other test stays green — so this asserts the PRODUCT function's answer, not the
 * setup file's own variable. Remove the `setupFiles` entry and this dies; that is the only check
 * that actually works.
 *
 * Deliberately an `*.integration.test.ts`: the unit config loads no setup files, so this property
 * is only true (and only needs to be true) where plugin subprocesses really run.
 */
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
