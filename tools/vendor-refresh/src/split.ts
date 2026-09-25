/** Split a big vendored manifest into <5MB parts, exactly the way `argo-workflows` was split by hand
 *  (2026-08, `0546d466`): cut only at `\n---\n` document boundaries, so concatenating the parts back
 *  together with `\n---\n` reproduces the original file byte-for-byte. See
 *  `deploy/helm-bundled/templates/argo-workflows.yaml`, which reassembles the parts the same way. */

/** Helm's per-file soft limit that made the original split necessary (see the M11.3 commit message
 *  and `deploy/helm-bundled/README.md`). Kept comfortably under it, matching the measured shape of
 *  the four parts already in the tree (2.4-3.3 MB each against an 11 MB whole). */
export const MAX_PART_BYTES = 4 * 1000 * 1000;

/** `1..N` zero-padded to two digits, matching `install-part-01.yaml` .. `install-part-04.yaml`.
 *  Padding to two digits is a DECLARED LIMIT, not decoration: a tenth part would collide
 *  (`install-part-010.yaml` sorts and globs differently from `install-part-10.yaml`), so a split that
 *  would need one is refused rather than silently mis-named. */
export function partFileName(index: number, total: number): string {
  if (total > 99) {
    throw new Error(
      `splitAtDocumentBoundaries: ${total} parts would need 3+ digit part numbers, and the existing ` +
        "naming scheme (install-part-NN.yaml) is only unambiguous up to 99 — this manifest has grown " +
        "enough to need a naming-scheme decision, not a silent renumbering"
    );
  }
  return `install-part-${String(index).padStart(2, "0")}.yaml`;
}

/** Split `raw` into the fewest ordered parts such that no part exceeds {@link MAX_PART_BYTES} and
 *  `parts.join("\n---\n") === raw` exactly. Splits ONLY at a `\n---\n` document separator — never
 *  inside a document — so each part, read on its own, is still a valid YAML document stream (the
 *  first document in a stream needs no leading `---`, and neither of the two doc-tags is inserted or
 *  removed here).
 *
 *  Greedy bin-packing: accumulate whole documents into the current part until the NEXT one would
 *  overflow it, then cut. Deterministic for a fixed input and a fixed {@link MAX_PART_BYTES}, which is
 *  what the determinism test (`plan.test.ts`) rests on — the same manifest at the same tag always
 *  splits identically.
 *
 *  A single document larger than {@link MAX_PART_BYTES} (upstream ships one; Argo CD's ApplicationSet
 *  CRD alone is multiple MB) is never split mid-document — it becomes its own, oversized part. Vendor
 *  files already in the tree carry exactly this shape (`argo-workflows-networkpolicy.yaml`'s own
 *  comment describes grepping across all four parts for a single CRD), so refusing to split inside a
 *  document is a compatibility requirement, not a convenience.
 */
export function splitAtDocumentBoundaries(raw: string): string[] {
  const docs = raw.split("\n---\n");
  if (docs.length === 0) return [""];

  const parts: string[] = [];
  let current = docs[0]!;
  for (let i = 1; i < docs.length; i++) {
    const doc = docs[i]!;
    const candidate = `${current}\n---\n${doc}`;
    if (Buffer.byteLength(candidate, "utf8") > MAX_PART_BYTES && current.length > 0) {
      parts.push(current);
      current = doc;
    } else {
      current = candidate;
    }
  }
  parts.push(current);
  return parts;
}

/** {@link splitAtDocumentBoundaries} plus the file names it lands under, and a re-join assertion so a
 *  caller can never write a split that would not reassemble — the property the whole scheme exists
 *  for. Throws (never silently truncates) if the parts do not reassemble to `raw` exactly. */
export function splitIntoNamedParts(raw: string): Array<{ name: string; content: string }> {
  const parts = splitAtDocumentBoundaries(raw);
  const rejoined = parts.join("\n---\n");
  if (rejoined !== raw) {
    throw new Error(
      "splitIntoNamedParts: the split parts do not reassemble to the original manifest byte-for-byte " +
        "— refusing to write parts that would silently corrupt the vendored manifest on read"
    );
  }
  return parts.map((content, i) => ({ name: partFileName(i + 1, parts.length), content }));
}
