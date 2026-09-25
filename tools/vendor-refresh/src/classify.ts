/** The semantic diff classifier (ADR-0059). Given the OLD and NEW text of a vendored manifest, and
 *  the set of image coordinates this backend tracks, decides whether every difference is confined to
 *  a tracked image's tag/digest text (`image-only`) or whether something with real authority changed
 *  (`requires-review`, naming every offending object). Pure — no IO, no network — so it can run
 *  inside the credential-free sandbox alongside the rest of the transform. */
import { parseAllDocuments, type Document } from "yaml";

export type DiffClass = "image-only" | "requires-review";

export interface DiffClassification {
  class: DiffClass;
  /** Populated only when `class === "requires-review"` — one entry per offending object, human
   *  readable (`kind namespace/name: reason`), so the PR body can name exactly what changed. */
  reasons: readonly string[];
}

/** The kinds whose ANY field change forces review — rules, subjects, webhooks, CRDs (their
 *  conversion webhook included — the CRD's `spec.conversion` IS a webhook admission point),
 *  Namespaces and ServiceAccounts. Listed by property (see docs/dependency-manifests.md's own
 *  "traps" convention): "this kind carries cluster authority or admission control," not by having
 *  been the specific kind a past incident involved. */
const AUTHORITY_KINDS: ReadonlySet<string> = new Set([
  "Role",
  "ClusterRole",
  "RoleBinding",
  "ClusterRoleBinding",
  "ValidatingWebhookConfiguration",
  "MutatingWebhookConfiguration",
  "CustomResourceDefinition",
  "Namespace",
  "ServiceAccount",
  "Secret"
]);

interface ParsedObject {
  kind: string;
  namespace: string;
  name: string;
  /** The raw parsed JS value (from `yaml`'s `toJS`), used for structural comparison. */
  value: unknown;
  /** Every image coordinate this object's containers/initContainers declare (bare coordinate, no
   *  tag/digest) — used to detect "a new, untracked image appeared". */
  imageCoordinates: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every `image:` scalar coordinate under a pod spec's containers/initContainers, bare (no tag). A
 *  DELIBERATELY narrow walk (containers/initContainers only) — this classifier's job is "did a new
 *  image appear", not a general-purpose reader; `@scp/dependency-manifests`'s `parseKubernetesImages`
 *  is that reader, and reusing it here would make this "independent" question depend on the exact
 *  parser whose OWN completeness is a separate, already-covered concern
 *  (`packages/source-census/src/vendored-image-inventory-census.test.ts`). */
function imageCoordinatesOf(value: unknown): string[] {
  const out: string[] = [];
  const podSpec = isRecord(value)
    ? (value["spec"] as Record<string, unknown> | undefined)
    : undefined;
  const template = isRecord(podSpec)
    ? (podSpec["template"] as Record<string, unknown> | undefined)
    : undefined;
  const templateSpec = isRecord(template)
    ? (template["spec"] as Record<string, unknown> | undefined)
    : undefined;
  // Covers both a bare Pod (`spec.containers`) and a Deployment/StatefulSet/DaemonSet
  // (`spec.template.spec.containers`) with one walk.
  for (const spec of [podSpec, templateSpec]) {
    if (!isRecord(spec)) continue;
    for (const field of ["containers", "initContainers"]) {
      const containers = spec[field];
      if (!Array.isArray(containers)) continue;
      for (const c of containers) {
        const image = isRecord(c) ? c["image"] : undefined;
        if (typeof image !== "string") continue;
        const at = image.lastIndexOf("@");
        const colon = image.lastIndexOf(":");
        const cut = at > 0 ? at : colon > image.indexOf("/") ? colon : image.length;
        out.push(image.slice(0, cut));
      }
    }
  }
  return out;
}

function objectKey(kind: string, namespace: string, name: string): string {
  return `${kind}\u0000${namespace}\u0000${name}`;
}

/** What {@link parseObjects} found, PLUS every reason it could not trust what it found — a parser
 *  differential (this classifier's `yaml` library rejects a document Helm's own, far more
 *  permissive, parser accepts) or two documents claiming the same object identity are both real
 *  signals a manifest is trying to say something to one reader that it hides from another, and
 *  neither may be silently dropped. */
interface ParseOutcome {
  objects: Map<string, ParsedObject>;
  /** Non-empty means this manifest cannot be fully trusted — the caller forces `requires-review`. */
  problems: readonly string[];
}

function parseObjects(manifestText: string): ParseOutcome {
  const objects = new Map<string, ParsedObject>();
  const problems: string[] = [];
  const docs: Document.Parsed[] = parseAllDocuments(manifestText);
  docs.forEach((doc, index) => {
    if (doc.errors.length > 0) {
      // ANY parse error forces review — never a silent skip. A duplicate mapping key is reported
      // exactly this way by the `yaml` library's default `uniqueKeys: true` (measured: `{a: 1, a:
      // 2}` lands in `doc.errors`, not `doc.warnings`), and PROBE P3 (2026-09-25 re-review) is a
      // ClusterRoleBinding granting cluster-admin with a duplicate `name:` key — this classifier
      // used to skip it as unparseable and classify the run `image-only`, while Helm's OWN (far more
      // permissive) YAML parser accepts the document and applies it for real. "This classifier could
      // not read it" is not evidence nothing is there; it is at least as suspicious as "it parsed to
      // something with authority."
      problems.push(
        `document ${index + 1}: FAILED TO PARSE (${doc.errors.map((e) => e.message.split("\n")[0]!).join("; ")}) — a parser differential is treated as requires-review, never silently skipped`
      );
      return;
    }
    const value = doc.toJS() as unknown;
    if (!isRecord(value)) return;
    const kind = typeof value["kind"] === "string" ? value["kind"] : "";
    if (kind === "") return;
    const metadata = isRecord(value["metadata"]) ? value["metadata"] : {};
    const namespace = typeof metadata["namespace"] === "string" ? metadata["namespace"] : "";
    const name = typeof metadata["name"] === "string" ? metadata["name"] : "";
    const key = objectKey(kind, namespace, name);
    if (objects.has(key)) {
      // TWO documents in the SAME manifest claim the same kind/namespace/name. PROBE P3's second
      // half: a wildcard ClusterRole placed BEFORE a benign same-named copy — a `Map` can only ever
      // keep one of them, and silently keeping the LATER (benign-looking) one while the EARLIER
      // (malicious) bytes still ship in the pushed manifest is exactly the gap that let it merge.
      // Never pick a side: forcing review is the only answer that does not depend on guessing which
      // one a downstream Kubernetes apply would actually honour.
      problems.push(
        `document ${index + 1}: DUPLICATE OBJECT IDENTITY — ${kind} ${namespace || "(cluster-scoped)"}/${name} already appeared earlier in this manifest`
      );
      return;
    }
    objects.set(key, {
      kind,
      namespace,
      name,
      value,
      imageCoordinates: imageCoordinatesOf(value)
    });
  });
  return { objects, problems };
}

/** Strip every TRACKED image's tag/digest text from an object's value before a structural compare,
 *  so a tracked image's own version bump is never itself reported as "something changed". Leaves
 *  everything else (including an UNTRACKED image's full ref) untouched. */
function withTrackedImagesBlanked(
  value: unknown,
  trackedCoordinates: ReadonlySet<string>
): unknown {
  if (Array.isArray(value))
    return value.map((v) => withTrackedImagesBlanked(v, trackedCoordinates));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "image" && typeof v === "string") {
      const at = v.lastIndexOf("@");
      const colon = v.lastIndexOf(":");
      const cut = at > 0 ? at : colon > v.indexOf("/") ? colon : v.length;
      const coordinate = v.slice(0, cut);
      out[k] = trackedCoordinates.has(coordinate) ? coordinate : v;
      continue;
    }
    out[k] = withTrackedImagesBlanked(v, trackedCoordinates);
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Classify the diff between an OLD and NEW manifest text for one backend. `trackedCoordinates` is
 *  the set of bare image coordinates (no tag) this backend is expected to bump. */
export function classifyRevendorDiff(
  oldManifestText: string,
  newManifestText: string,
  trackedCoordinates: readonly string[]
): DiffClassification {
  const tracked = new Set(trackedCoordinates);
  const oldParsed = parseObjects(oldManifestText);
  const newParsed = parseObjects(newManifestText);
  const oldObjects = oldParsed.objects;
  const newObjects = newParsed.objects;
  // A parser differential or a duplicate object identity, on EITHER side, is reason enough on its
  // own — pushed ahead of the per-object comparison below so it can never be masked by an otherwise
  // clean diff.
  const reasons: string[] = [
    ...oldParsed.problems.map((p) => `old manifest, ${p}`),
    ...newParsed.problems.map((p) => `new manifest, ${p}`)
  ];

  const allKeys = new Set([...oldObjects.keys(), ...newObjects.keys()]);
  for (const key of allKeys) {
    const before = oldObjects.get(key);
    const after = newObjects.get(key);
    const label = (o: ParsedObject | undefined, fallback: string) =>
      o ? `${o.kind} ${o.namespace || "(cluster-scoped)"}/${o.name}` : fallback;

    if (before === undefined) {
      reasons.push(`${label(after, "?")}: a NEW object appeared that was not in the old manifest`);
      continue;
    }
    if (after === undefined) {
      reasons.push(`${label(before, "?")}: an object was REMOVED from the manifest`);
      continue;
    }

    // A new, UNTRACKED image is always review-worthy, regardless of kind.
    const newUntracked = after.imageCoordinates.filter(
      (c) => !tracked.has(c) && !before.imageCoordinates.includes(c)
    );
    if (newUntracked.length > 0) {
      reasons.push(`${label(after, "?")}: new untracked image(s) ${newUntracked.join(", ")}`);
    }

    if (AUTHORITY_KINDS.has(before.kind)) {
      if (!deepEqual(before.value, after.value)) {
        reasons.push(
          `${label(after, "?")}: ${before.kind} content changed — requires human review`
        );
      }
      continue;
    }

    // Every other kind: OK as long as the only difference is confined to a TRACKED image's own
    // tag/digest. The security-posture check runs REGARDLESS of the outcome above (never behind a
    // `continue`) so a manifest that changes BOTH a tracked image AND, say, flips `hostNetwork` gets
    // the SPECIFIC security reason named, not just the generic "changed outside a tracked image"
    // one — a reviewer reading the PR body should see "hostNetwork changed", not have to re-diff the
    // manifest themselves to find out why.
    const beforeBlanked = withTrackedImagesBlanked(before.value, tracked);
    const afterBlanked = withTrackedImagesBlanked(after.value, tracked);
    const securityChanged = securityPostureChanged(before.value, after.value);
    if (securityChanged) {
      reasons.push(`${label(after, "?")}: ${securityChanged}`);
    } else if (!deepEqual(beforeBlanked, afterBlanked)) {
      reasons.push(`${label(after, "?")}: changed outside a tracked image's tag/digest`);
    }
  }

  return reasons.length === 0
    ? { class: "image-only", reasons: [] }
    : { class: "requires-review", reasons };
}

/** `privileged`/`hostPath`/`hostNetwork` — checked on the RAW (not tracked-image-blanked) values,
 *  since these fields never depend on which image a container runs. */
function securityPostureChanged(before: unknown, after: unknown): string | undefined {
  const beforeFlags = collectSecurityFlags(before);
  const afterFlags = collectSecurityFlags(after);
  if (beforeFlags.hostNetwork !== afterFlags.hostNetwork) return "hostNetwork changed";
  if (beforeFlags.hostPathCount !== afterFlags.hostPathCount)
    return "hostPath volume count changed";
  if (beforeFlags.privilegedCount !== afterFlags.privilegedCount)
    return "privileged container count changed";
  return undefined;
}

interface SecurityFlags {
  hostNetwork: boolean;
  hostPathCount: number;
  privilegedCount: number;
}

function collectSecurityFlags(value: unknown): SecurityFlags {
  const flags: SecurityFlags = { hostNetwork: false, hostPathCount: 0, privilegedCount: 0 };
  const podSpec = isRecord(value)
    ? (value["spec"] as Record<string, unknown> | undefined)
    : undefined;
  const template = isRecord(podSpec)
    ? (podSpec["template"] as Record<string, unknown> | undefined)
    : undefined;
  const templateSpec = isRecord(template)
    ? (template["spec"] as Record<string, unknown> | undefined)
    : undefined;
  for (const spec of [podSpec, templateSpec]) {
    if (!isRecord(spec)) continue;
    if (spec["hostNetwork"] === true) flags.hostNetwork = true;
    const volumes = spec["volumes"];
    if (Array.isArray(volumes)) {
      for (const v of volumes) {
        if (isRecord(v) && isRecord(v["hostPath"])) flags.hostPathCount++;
      }
    }
    for (const field of ["containers", "initContainers"]) {
      const containers = spec[field];
      if (!Array.isArray(containers)) continue;
      for (const c of containers) {
        const sc = isRecord(c) ? c["securityContext"] : undefined;
        if (isRecord(sc) && sc["privileged"] === true) flags.privilegedCount++;
      }
    }
  }
  return flags;
}
