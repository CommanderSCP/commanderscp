import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempTrackedForFileSync } from "@scp/test-tmpdir";

/**
 * Vitest `setupFiles` entry: gives THIS TEST FILE its own plugin-state root, instead of letting it
 * share one fixed machine-global directory with every other file, every other worker, and every
 * other checkout on the machine.
 *
 * WHAT IT FIXES. `coordination/executor-bindings-repo.ts`'s `pluginStateDir()` is
 * `process.env.SCP_PLUGIN_STATE_DIR ?? join(tmpdir(), "scp-plugin-state")`, and every resolved
 * executor instance gets `statePath: join(pluginStateDir(), `${sanitizeInstanceId(id)}.json`)`.
 * With the variable unset — which is what every test run did until 2026-08-23 — that resolves to a
 * FIXED `/tmp/scp-plugin-state` for the whole machine. The tmpdir-leak gate caught it as a leak
 * (nothing ever removed it), but a leak is the mildest of its three consequences:
 *
 *  1. It is never cleaned, so it accumulates one file per plugin instance id, forever.
 *  2. `vitest.integration.config.ts` runs `pool: "forks"` with `maxForks` up to 4 and `isolate`
 *     on, i.e. FOUR CONCURRENT test files. Each has its own cloned database and therefore its own
 *     orgs — but `pluginInstanceId` is chosen by the caller and is only unique PER ORG
 *     (`primaryKey([orgId, pluginInstanceId])`, db/schema.ts), so two files that both create a
 *     binding named e.g. "argocd" resolved to the SAME `/tmp/scp-plugin-state/argocd.json`. The
 *     per-worker database isolation that makes parallel execution safe does not extend to disk.
 *  3. That file is an executor's durable idempotency/dedup cache. Two files sharing one means a
 *     `trigger()` in file B can be answered from file A's dedup entry — a test that passes for the
 *     wrong reason, and the least visible failure available.
 *
 * WHY THE PRODUCT DEFAULT IS NOT THE THING BEING CHANGED. A stable path is the POINT in production:
 * the cache has to survive a plugin subprocess restart (MAJOR #4), and randomising the default per
 * boot would silently downgrade every deployment to in-memory-only — the exact behaviour the
 * setting exists to prevent. The default is right for a server; it is wrong to INHERIT it in a test
 * process, which is what this file corrects, at the same layer `per-worker-db.ts` corrects the
 * database URL.
 *
 * `mkdtempTrackedForFileSync` (FILE lifetime, swept in `afterAll`) rather than the per-test pair:
 * plugin instances outlive individual `it()`s here, and a per-test sweep would delete a running
 * executor's state file mid-file — measured, and the reason `@scp/test-tmpdir` now refuses the
 * per-test pair outside a test at all.
 */
process.env.SCP_PLUGIN_STATE_DIR = mkdtempTrackedForFileSync(join(tmpdir(), "scp-plugin-state-"));
