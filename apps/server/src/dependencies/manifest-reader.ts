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

/**
 * M21.4 — THE SERVER-SIDE ROUTE FROM "a component's git binding" TO `readFileAtRef` (ADR-0032 §7a).
 *
 * ============================================================================================
 * WHAT WAS MISSING, AND WHY IT MADE M21.2 DEAD CODE
 * ============================================================================================
 * ADR-0032 §7a resolves the released version of an `npm`/`python`/`maven` line by reading the
 * PRODUCING COMPONENT'S OWN MANIFEST at the released commit — "the same 'formulated via the users'
 * code' ingress the inventory itself is built from". M21.2 built the primitive for that as
 * `GitProviderAdapter.readFileAtRef`, and §7a then recorded, honestly, that **no server-side route
 * to it existed**: it is deliberately not an `ExecutorPlugin` verb (§9), and the subprocess plugin
 * host exposed no file-read client. Three of the five ecosystems therefore recorded nothing, every
 * time, under `manifest_reader_unavailable`.
 *
 * The plugin-host half of that route now exists (`plugin-host/contract.ts`'s
 * `GitFileReadPluginClient`, `host.ts`'s `gitFileRead()`, `subprocess-entry.ts`'s `readFileAtRef`
 * dispatch). THIS file is the other half: which INSTANCE to ask.
 *
 * ============================================================================================
 * THE BINDING IS CHOSEN BY THE REPO, DECLARED, NEVER GUESSED
 * ============================================================================================
 * A read is addressed to a repo — `changes.source_ref.repo`, the repo the release actually came
 * from — and the instance that may read it is the git-provider binding CONFIGURED FOR THAT REPO.
 * Nothing here picks "the org's first github binding", and that restraint is the whole point: those
 * bindings hold credentials, and one binding's installation token is not authority over another
 * team's repository. A repo no binding names yields a legible failure, never a read attempted with
 * somebody else's credential.
 *
 * The identity a binding names is the provider's own: `projectPath` when it has one (GitLab groups
 * nest), else `owner/repo` (GitHub and Gitea address a repo as exactly two segments). Matching is
 * case-insensitive because all three providers treat repository paths that way, and it is exact —
 * never a prefix, or `acme/widgets` would match `acme/widgets-fork`.
 *
 * ============================================================================================
 * IT READS. THAT IS ALL IT CAN DO.
 * ============================================================================================
 * The client this reaches has exactly one method and it is a GET (charter principle 1, ADR-0032
 * §9). There is no branch, commit or PR behind this seam, and the bump actuator ADR-0032 §8
 * describes is explicitly NOT reached this way — it is a managed executor class contingent on a
 * charter amendment.
 */

/** The three modules that carry a `readFileAtRef` hook (M21.2). A module absent from this list has
 *  no adapter hook and the subprocess refuses the call by naming that — see `subprocess-entry.ts`. */
export const GIT_PROVIDER_MODULES = ["github", "gitea", "gitlab"] as const;

export type GitProviderModule = (typeof GIT_PROVIDER_MODULES)[number];

export function isGitProviderModule(module: string): module is GitProviderModule {
  return (GIT_PROVIDER_MODULES as readonly string[]).includes(module);
}

/**
 * The repository a git-provider binding is configured for, as the provider spells it — or `null`
 * when the config names none.
 *
 * Read from the SAME fields the adapters themselves read (`GithubConfig`/`GiteaConfig` require
 * `owner` + `repo`; `GitlabConfig` prefers `projectPath` and falls back to `owner/repo`, exactly as
 * its own `projectPathOf` does). Reading a different field here than the adapter uses would make
 * this match a binding that then addresses somewhere else.
 */
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

/**
 * The same identity, VERBATIM — the form a request is ADDRESSED to rather than compared with.
 *
 * {@link bindingRepoIdentity} case-folds, which is right for deciding "is this the binding for that
 * repo?" and wrong for everything else: `owner/Repo` and `owner/repo` are the same repository to all
 * three providers, but a branch created under the folded spelling is a different string in every
 * audit record and in the pull request's own URL. M21.5's bump dispatcher authors INTO the repo, so
 * it needs what the operator actually configured.
 *
 * Two functions rather than one with a flag, because the two answers are used for different things
 * and a caller that picked the wrong one would still work — until the first binding configured with
 * a capital letter.
 */
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

/**
 * A {@link ManifestReader} that resolves the right git-provider instance PER CALL and asks it.
 *
 * Resolution is cached per repo for the life of the reader (one detection run = one change = one
 * repo, so this is normally one resolution serving several manifest paths). The cache is per
 * READER, never module-level: it holds a resolved instance config carrying decrypted secret
 * material, and a process-lifetime cache of that is a different object with different rules.
 *
 * FAILURES THROW, and that is the port's contract rather than a shortcut: `resolveReleasedVersion`
 * catches a reader throw PER MANIFEST and records `manifest_unreadable` with the message, which is
 * already where an auth failure, a 5xx and an egress refusal land. "No binding names this repo"
 * joins them as one more thing that stopped the file being read, with the cause in the detail — it
 * is not silently treated as "the file is not there", which would be a claim about the repo.
 */
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

  // Several bindings legitimately name one repo (a monorepo with a binding per component, or a
  // build and a deploy pipeline on the same repo). They share a repo AND a provider, so any of them
  // reads the same bytes; sorted by binding id so the choice is deterministic across runs rather
  // than whatever order the query happened to return — a reader that resolved differently between
  // two runs of the same change would make the Decision's detail unstable.
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
  // NOT `stopInstances`d afterwards, and that is consistent with M21.4's lifecycle rule rather than
  // an omission of it. That rule distinguishes instances derived from a WORK-LIST (the version
  // poll's per-ecosystem indexes — unbounded in tenancy, started on demand, stopped when the sweep
  // ends) from instances derived from operator CONFIGURATION. This is the latter: it is an ordinary
  // executor binding's instance, the same one `reconcile.ts` and `observe.ts` start and leave
  // running, addressed by the same id — so stopping it here would tear down a subprocess those
  // loops are using and force a respawn on their next tick.
  await deps.host.start([resolved.instanceConfig]);
  return resolved.instanceConfig.id;
}
