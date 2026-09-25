/** Resolve an image reference's digest through the repo's pinned skopeo, the same way the server's
 *  own OCI dependency index does (`packages/plugins/dependency-index-oci`,
 *  `apps/server/src/dependencies/version-index.ts`) — `skopeo inspect docker://<ref>`, read `.Digest`.
 *  This is the real, network-reaching implementation; every test injects a fake `run` instead. */
import { resolveSkopeo, run, type RunResult } from "@scp/cosign";
import type { ResolveImageDigest } from "./types.js";

export class SkopeoUnavailableError extends Error {}

/** Build a real {@link ResolveImageDigest} against the pinned skopeo `resolveSkopeo()` finds.
 *  `runFn` is injectable ONLY for tests — real callers always take the default, which shells out. */
export function createSkopeoDigestResolver(
  runFn: (bin: string, args: string[]) => RunResult = (bin, args) => run(bin, args, { log: false })
): ResolveImageDigest {
  return async (ref: string): Promise<string> => {
    const skopeo = resolveSkopeo();
    if (skopeo.source === "missing") {
      throw new SkopeoUnavailableError(
        "vendor-refresh: no skopeo is available (checked SCP_SKOPEO_BIN, the vendored runtime path, " +
          "and PATH) — refusing to guess a digest. Install the pinned skopeo (tools/skopeo/README.md) " +
          "or set SCP_SKOPEO_BIN."
      );
    }
    let stdout: string;
    try {
      ({ stdout } = runFn(skopeo.bin, ["inspect", `docker://${ref}`]));
    } catch (err) {
      throw new Error(
        `vendor-refresh: skopeo inspect docker://${ref} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`vendor-refresh: skopeo inspect docker://${ref} did not return JSON`);
    }
    const digest = (parsed as { Digest?: unknown }).Digest;
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `vendor-refresh: skopeo inspect docker://${ref} reported no well-formed sha256 digest`
      );
    }
    return digest;
  };
}
