import { createHash } from "node:crypto";
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
 * THE CONTROLLER'S MEMORY, kept in the CONTROLLER'S OWN namespace (M29.4, ADR-0058).
 *
 * Why there (review S1): its first home was each backend's namespace, where several backend
 * ServiceAccounts can write Secrets — so a backend could have rewritten the "last good" set the
 * controller falls back to, or the inventory it prunes from. The controller's namespace holds
 * nothing but the controller, and no other identity the chart creates has rights in it.
 * Belt and braces on top: the sha256 of both is reported to scpd, and a mismatch on read-back is
 * refused rather than applied or pruned from (reconcile.ts).
 *
 * - `scp-stackd-<backend>-state` — the inventory, the retained (data) refs, the last good set's
 *   identity, the last failed attempt and the last purge generation acted on.
 * - `scp-stackd-<backend>-lastgood-<n>` — the last good rendered set, gzipped and split: Argo
 *   Workflows' render is ~11 MB (~0.9 MB gzipped) and one Secret is capped at 1 MiB.
 */

export interface LastGood {
  release: string;
  fingerprint: string;
  /** The `upgradeGeneration` in force when this set became good. */
  upgradeGeneration: number;
  appliedAt: string;
  chunks: number;
  /** sha256 of the stored (gzipped) bytes. */
  sha256: string;
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
  /** Data kept when the backend was disabled (volumes, generate-once secrets), until a purge. */
  retained: ObjectRef[];
  lastGood: LastGood | null;
  failed: FailedAttempt | null;
  purgedGeneration: number;
}

export const EMPTY_STATE: BackendState = {
  inventory: [],
  retained: [],
  lastGood: null,
  failed: null,
  purgedGeneration: 0
};

const CHUNK_BYTES = 512 * 1024;

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

export class StateStore {
  constructor(
    private readonly kube: KubeClient,
    /** The controller's own namespace. */
    private readonly namespace: string
  ) {}

  private ref(name: string): ObjectRef {
    return { apiVersion: "v1", kind: "Secret", name, namespace: this.namespace };
  }

  private secret(name: string, backend: StackBackend, data: Record<string, string>): KubeObject {
    return {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name,
        namespace: this.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [BACKEND_LABEL]: backend,
          "stack.commanderscp.io/role": "state"
        }
      },
      data
    };
  }

  async load(backend: StackBackend): Promise<BackendState> {
    const live = await this.kube.get(this.ref(`scp-stackd-${backend}-state`));
    const raw = (live?.["data"] as Record<string, string> | undefined)?.["state.json"];
    if (!raw) return structuredClone(EMPTY_STATE);
    const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Partial<BackendState>;
    return {
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : [],
      retained: Array.isArray(parsed.retained) ? parsed.retained : [],
      lastGood: parsed.lastGood ?? null,
      failed: parsed.failed ?? null,
      purgedGeneration: typeof parsed.purgedGeneration === "number" ? parsed.purgedGeneration : 0
    };
  }

  async save(backend: StackBackend, state: BackendState): Promise<void> {
    await this.kube.apply(
      this.secret(`scp-stackd-${backend}-state`, backend, {
        "state.json": Buffer.from(JSON.stringify(state)).toString("base64")
      })
    );
  }

  /** Stores a set as the last good one; returns its chunk count and the sha256 of the bytes. */
  async saveLastGood(
    backend: StackBackend,
    objs: KubeObject[],
    previousChunks: number
  ): Promise<{ chunks: number; sha256: string }> {
    const gz = gzipSync(Buffer.from(JSON.stringify(objs)));
    const count = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));
    for (let i = 0; i < count; i++) {
      const part = gz.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      await this.kube.apply(
        this.secret(`scp-stackd-${backend}-lastgood-${i}`, backend, {
          part: part.toString("base64")
        })
      );
    }
    for (let i = count; i < previousChunks; i++) {
      await this.kube.delete(this.ref(`scp-stackd-${backend}-lastgood-${i}`));
    }
    return { chunks: count, sha256: sha256(gz) };
  }

  /** Reads the last good set back, with the sha256 of the bytes as read. */
  async loadLastGood(
    backend: StackBackend,
    chunks: number
  ): Promise<{ objects: KubeObject[]; sha256: string }> {
    const parts: Buffer[] = [];
    for (let i = 0; i < chunks; i++) {
      const live = await this.kube.get(this.ref(`scp-stackd-${backend}-lastgood-${i}`));
      const raw = (live?.["data"] as Record<string, string> | undefined)?.["part"];
      if (!raw) {
        throw new Error(
          `the last good set for ${backend} is incomplete: chunk ${i} of ${chunks} is missing`
        );
      }
      parts.push(Buffer.from(raw, "base64"));
    }
    const gz = Buffer.concat(parts);
    return {
      objects: JSON.parse(gunzipSync(gz).toString("utf8")) as KubeObject[],
      sha256: sha256(gz)
    };
  }

  /** Deletes the stored last good set (a removed backend has nothing to fall back to). */
  async dropLastGood(backend: StackBackend, chunks: number): Promise<void> {
    for (let i = 0; i < chunks; i++) {
      await this.kube.delete(this.ref(`scp-stackd-${backend}-lastgood-${i}`));
    }
  }
}

/** What scpd keeps of a backend's state (the status row), and what a report hands it. */
export interface StateDigests {
  lastGoodSha256: string | null;
  inventorySha256: string;
}

/** The inventory AND the retained refs, full apiVersion included, order-independent. */
export function inventoryDigest(state: Pick<BackendState, "inventory" | "retained">): string {
  const line = (r: ObjectRef) => `${r.apiVersion}|${r.kind}|${r.namespace ?? ""}|${r.name}`;
  return sha256(
    JSON.stringify({
      inventory: state.inventory.map(line).sort(),
      retained: state.retained.map(line).sort()
    })
  );
}

export function stateDigests(state: BackendState): StateDigests {
  return {
    lastGoodSha256: state.lastGood?.sha256 ?? null,
    inventorySha256: inventoryDigest(state)
  };
}
