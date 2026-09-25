import { gunzipSync, gzipSync } from "node:zlib";
import type { StackBackend } from "@scp/schemas";
import type { KubeClient } from "./kube.js";
import {
  BACKEND_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  type KubeObject,
  type ObjectRef
} from "./manifests.js";

/**
 * THE CONTROLLER'S MEMORY, kept in the BACKEND's own namespace (M29.4, ADR-0058).
 *
 * Why there: the controller's namespaced rights exist only in the backend namespaces, so it holds
 * nothing in SCP's namespace, where scpd's database credentials live. Why Secrets: the last good
 * rendered set is what falls back after a failed upgrade, and it contains the backend's own
 * generated credentials (Gitea's admin password), so it is stored the way the backend stores them.
 *
 * - `scp-stackd-state` — the inventory (every object the controller has applied and not yet
 *   pruned), the last good set's identity, and the last failed attempt.
 * - `scp-stackd-lastgood-<n>` — the last good rendered set, gzipped and split: Argo Workflows'
 *   render is ~11 MB (~0.9 MB gzipped) and one Secret is capped at 1 MiB.
 *
 * Nothing is stored as a Helm release, so Helm's 1 MB release limit never applies (E3).
 */

export interface LastGood {
  release: string;
  fingerprint: string;
  /** The `upgradeGeneration` in force when this set became good. */
  upgradeGeneration: number;
  appliedAt: string;
  chunks: number;
}

export interface FailedAttempt {
  fingerprint: string;
  release: string;
  upgradeGeneration: number;
  error: string;
  at: string;
}

export interface BackendState {
  inventory: ObjectRef[];
  lastGood: LastGood | null;
  failed: FailedAttempt | null;
}

export const EMPTY_STATE: BackendState = { inventory: [], lastGood: null, failed: null };

const STATE_SECRET = "scp-stackd-state";
const CHUNK_PREFIX = "scp-stackd-lastgood-";
/** Raw bytes per chunk; base64 makes it ~683 KiB, under the 1 MiB object cap with room. */
const CHUNK_BYTES = 512 * 1024;

const secretRef = (namespace: string, name: string): ObjectRef => ({
  apiVersion: "v1",
  kind: "Secret",
  name,
  namespace
});

function secret(
  namespace: string,
  name: string,
  backend: StackBackend,
  data: Record<string, string>
): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name,
      namespace,
      labels: {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [BACKEND_LABEL]: backend,
        "stack.commanderscp.io/role": "state"
      }
    },
    data
  };
}

export class StateStore {
  constructor(
    private readonly kube: KubeClient,
    private readonly namespaceOf: (b: StackBackend) => string
  ) {}

  async load(backend: StackBackend): Promise<BackendState> {
    const live = await this.kube.get(secretRef(this.namespaceOf(backend), STATE_SECRET));
    const raw = (live?.["data"] as Record<string, string> | undefined)?.["state.json"];
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Partial<BackendState>;
    return {
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : [],
      lastGood: parsed.lastGood ?? null,
      failed: parsed.failed ?? null
    };
  }

  async save(backend: StackBackend, state: BackendState): Promise<void> {
    const ns = this.namespaceOf(backend);
    await this.kube.apply(
      secret(ns, STATE_SECRET, backend, {
        "state.json": Buffer.from(JSON.stringify(state)).toString("base64")
      })
    );
  }

  /** Stores a set as the last good one; returns its chunk count for `LastGood.chunks`. Chunks
   *  beyond the new count are deleted so a shrinking set leaves nothing stale behind. */
  async saveLastGood(
    backend: StackBackend,
    objs: KubeObject[],
    previousChunks: number
  ): Promise<number> {
    const ns = this.namespaceOf(backend);
    const gz = gzipSync(Buffer.from(JSON.stringify(objs)));
    const count = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));
    for (let i = 0; i < count; i++) {
      const part = gz.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      await this.kube.apply(
        secret(ns, `${CHUNK_PREFIX}${i}`, backend, { part: part.toString("base64") })
      );
    }
    for (let i = count; i < previousChunks; i++)
      await this.kube.delete(secretRef(ns, `${CHUNK_PREFIX}${i}`));
    return count;
  }

  async loadLastGood(backend: StackBackend, chunks: number): Promise<KubeObject[]> {
    const ns = this.namespaceOf(backend);
    const parts: Buffer[] = [];
    for (let i = 0; i < chunks; i++) {
      const live = await this.kube.get(secretRef(ns, `${CHUNK_PREFIX}${i}`));
      const raw = (live?.["data"] as Record<string, string> | undefined)?.["part"];
      if (!raw)
        throw new Error(
          `the last good set for ${backend} is incomplete: chunk ${i} of ${chunks} is missing`
        );
      parts.push(Buffer.from(raw, "base64"));
    }
    return JSON.parse(gunzipSync(Buffer.concat(parts)).toString("utf8")) as KubeObject[];
  }

  async clear(backend: StackBackend, chunks: number): Promise<void> {
    const ns = this.namespaceOf(backend);
    for (let i = 0; i < chunks; i++) await this.kube.delete(secretRef(ns, `${CHUNK_PREFIX}${i}`));
    await this.kube.delete(secretRef(ns, STATE_SECRET));
  }
}
