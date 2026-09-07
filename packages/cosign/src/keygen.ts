/** Non-interactive cosign keypair GENERATION. See docs/cosign.md §20. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPinnedCosignVersion, resolveCosign, type ResolvedCosign } from "./cosign-bin.js";
import { run } from "./exec.js";

/** Resolve cosign and assert the pinned provenance before any call — see cosign.ts's `cosign()`. */
function cosign(): ResolvedCosign {
  const resolved = resolveCosign();
  assertPinnedCosignVersion(resolved);
  return resolved;
}

export interface GeneratedKeyPair {
  /** cosign's empty-password encrypted PEM (the bytes of `cosign.key`). Never persist outside a
   *  dedicated, RLS-protected store; never return over any API. */
  privateKeyPem: string;
  /** the matching cosign public-key PEM (`cosign.pub`). Not a secret. */
  publicKeyPem: string;
}

/**
 * Generate a fresh cosign keypair offline and return both halves as PEM strings. Runs in a
 * throwaway temp dir that is always removed (even on failure), so no key file survives the call.
 */
export async function generateKeyPair(): Promise<GeneratedKeyPair> {
  const resolved = cosign();
  const dir = await mkdtemp(path.join(tmpdir(), "scp-cosign-keygen-"));
  try {
    // cosign writes `<prefix>.key` (encrypted PEM) and `<prefix>.pub` into the given dir. Empty
    // password: non-interactive, matches deploy/airgap/src/cosign.ts. No `--yes` needed here.
    const prefix = path.join(dir, "cosign");
    run(resolved.bin, ["generate-key-pair", "--output-key-prefix", prefix], {
      env: { COSIGN_PASSWORD: "" }
    });
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      readFile(`${prefix}.key`, "utf8"),
      readFile(`${prefix}.pub`, "utf8")
    ]);
    return { privateKeyPem, publicKeyPem };
  } finally {
    // Best-effort scrub of the temp dir (and the key files in it) regardless of outcome.
    await rm(dir, { recursive: true, force: true });
  }
}
