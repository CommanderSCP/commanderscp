import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "@scp/git-provider-core";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  listExecutorBindings,
  resolveExecutorPluginInstance,
  type ExecutorBindingRow
} from "../coordination/executor-bindings-repo.js";
import type { ManifestReader } from "./internal-release-version.js";

/** The server-side route from a git binding to a read. See docs/dependencies.md §342. */

/** The three modules that carry a `readFileAtRef` hook (M21.2). A module absent from this list has
 *  no adapter hook and the subprocess refuses the call by naming that — see `subprocess-entry.ts`. */
export const GIT_PROVIDER_MODULES = ["github", "gitea", "gitlab"] as const;

export type GitProviderModule = (typeof GIT_PROVIDER_MODULES)[number];

export function isGitProviderModule(module: string): module is GitProviderModule {
  return (GIT_PROVIDER_MODULES as readonly string[]).includes(module);
}

/** The repository a git binding is configured for. See docs/dependencies.md §343. */
export function bindingRepoIdentity(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const c = config as { projectPath?: unknown; owner?: unknown; repo?: unknown };
  if (typeof c.projectPath === "string" && c.projectPath.trim() !== "") {
    return normalizeRepoIdentity(c.projectPath);
  }
  if (
    typeof c.owner === "string" &&
    c.owner.trim() !== "" &&
    typeof c.repo === "string" &&
    c.repo.trim() !== ""
  ) {
    return normalizeRepoIdentity(`${c.owner.trim()}/${c.repo.trim()}`);
  }
  return null;
}

/** The same identity, VERBATIM. See docs/dependencies.md §344. */
export function bindingRepoPath(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const c = config as { projectPath?: unknown; owner?: unknown; repo?: unknown };
  if (typeof c.projectPath === "string" && c.projectPath.trim() !== "") {
    return c.projectPath.trim().replace(/^\/+|\/+$/g, "");
  }
  if (
    typeof c.owner === "string" &&
    c.owner.trim() !== "" &&
    typeof c.repo === "string" &&
    c.repo.trim() !== ""
  ) {
    return `${c.owner.trim()}/${c.repo.trim()}`;
  }
  return null;
}

/** Trimmed, stripped of surrounding slashes and case-folded — the comparison form only. The binding
 *  and the request are both put through this, never one of them. */
export function normalizeRepoIdentity(repo: string): string {
  return repo
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

export interface GitManifestReaderDeps {
  db: Db;
  host: PluginHost;
  orgId: string;
  masterKey: Buffer;
}

/** A reader that resolves the right provider per call. See docs/dependencies.md §345. */
export function createGitProviderManifestReader(deps: GitManifestReaderDeps): ManifestReader {
  const resolvedByRepo = new Map<string, string>();

  return async (request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult> => {
    if (request.repo === undefined || request.repo.trim() === "") {
      // The adapter would fall back to "the repo this binding is configured for", which is a
      // different repo per binding — so with no repo named there is no way to know WHICH instance
      // is the right one to ask. Refused rather than resolved to an arbitrary binding.
      throw new Error(
        "dependency manifest read: no repo was named (changes.source_ref carries none), so no " +
          "git-provider binding can be shown to be the right one to ask"
      );
    }
    const wanted = normalizeRepoIdentity(request.repo);
    let instanceId = resolvedByRepo.get(wanted);
    if (instanceId === undefined) {
      instanceId = await startInstanceForRepo(deps, wanted);
      resolvedByRepo.set(wanted, instanceId);
    }
    return deps.host.gitFileRead(instanceId).readFileAtRef(request);
  };
}

/** Resolve the binding that names `wanted`, start its instance, and return the instance id. */
async function startInstanceForRepo(deps: GitManifestReaderDeps, wanted: string): Promise<string> {
  const candidates = await withTenantTx(deps.db, deps.orgId, async (tx) => {
    const bindings = await listExecutorBindings(tx, deps.orgId);
    return bindings.filter(
      (b) => isGitProviderModule(b.pluginModule) && bindingRepoIdentity(b.config) === wanted
    );
  });

  if (candidates.length === 0) {
    throw new Error(
      `dependency manifest read: no github/gitea/gitlab executor binding in this org is ` +
        `configured for repo '${wanted}', so there is no instance whose credentials may read it. ` +
        `Bind the repo (or correct changes.source_ref.repo) — SCP will not read one repo with ` +
        `another binding's credential`
    );
  }

  // Several bindings legitimately name one repo. See docs/dependencies.md §346.
  const binding = [...candidates].sort((a, b) => (a.id < b.id ? -1 : 1))[0] as ExecutorBindingRow;

  const resolved = await withTenantTx(deps.db, deps.orgId, (tx) =>
    // Resolved by the binding's OWN routing Type, the same way `observe.ts` does: a target holding
    // several pipelines would otherwise resolve the default 'configuration' binding, which may be a
    // different instance than the one this repo's binding names.
    resolveExecutorPluginInstance(tx, {
      orgId: deps.orgId,
      targetObjectId: binding.targetObjectId,
      masterKey: deps.masterKey,
      type: binding.type
    })
  );
  if (!resolved) {
    throw new Error(
      `dependency manifest read: executor binding ${binding.id} names repo '${wanted}' but its ` +
        `plugin instance could not be resolved`
    );
  }
  // Not stopped afterwards, per the lifecycle rule. See docs/dependencies.md §347.
  await deps.host.start([resolved.instanceConfig]);
  return resolved.instanceConfig.id;
}
