import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** THE ADR STATUS-COHERENCE GATE.
 *
 *  Three stale decision records were found in one pass on 2026-09-20, and two of the three were
 *  actively misleading rather than untidy:
 *
 *  - ADR-0033 read `Proposed` while its mechanism was merged (M22, PR #262) — and ADR-0020's E6
 *    bullet was written *"SUPERSEDED **if and when** ADR-0033 is accepted (it is currently
 *    `Proposed`) … Until that ADR is Accepted, this bullet still governs."* So an **Accepted** ADR
 *    asserted the scan boundary could not be loosened while the shipped code loosened it.
 *  - `governance-label-namespace.md` read *"proposed, pending review … An ADR (0034) follows owner
 *    approval"* after the mechanism had shipped and been wired.
 *
 *  The common shape: a decision record is written at a point in time, the work that discharges it
 *  lands somewhere else, and nobody walks back to the record. None of these are detectable by
 *  reading one document — they are all DISAGREEMENTS BETWEEN two documents, which is exactly what
 *  a census can check and a reviewer reliably cannot. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ADR_DIR = resolve(REPO_ROOT, "docs/adr");
const PROPOSALS_DIR = resolve(REPO_ROOT, "docs/proposals");

type Verdict = "accepted" | "proposed" | "superseded" | "rejected" | "deprecated";

const VERDICTS: Verdict[] = ["accepted", "proposed", "superseded", "rejected", "deprecated"];

/** Both header shapes in use. `0001` established a `| **Status** | … |` table row and `0003`
 *  onward use a `**Status:** …` line; a parser that knew only one would silently skip five ADRs,
 *  and a census that silently skips is the failure it exists to catch. A third shape must fail
 *  loudly here rather than drop its file. */
const STATUS_LINE = /^\s*(?:\|\s*)?\*\*Status:?\*\*:?\s*\|?\s*(.+?)\s*\|?\s*$/m;

interface Adr {
  number: string;
  file: string;
  statusText: string;
  verdict: Verdict;
  body: string;
}

function verdictOf(statusText: string): Verdict | undefined {
  const head = statusText.toLowerCase();
  // FIRST verdict word wins: "Accepted … supersedes ADR-0020" is Accepted, and an ADR that says
  // "Accepted for the tier itself" (0040/0041) is Accepted too.
  let best: { verdict: Verdict; at: number } | undefined;
  for (const v of VERDICTS) {
    const at = head.indexOf(v);
    if (at === -1) continue;
    if (!best || at < best.at) best = { verdict: v, at };
  }
  return best?.verdict;
}

function loadAdrs(): Adr[] {
  return readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((file) => {
      const body = readFileSync(resolve(ADR_DIR, file), "utf8");
      const match = STATUS_LINE.exec(body);
      const statusText = match?.[1] ?? "";
      const verdict = verdictOf(statusText);
      if (!verdict) {
        throw new Error(
          `${file} has no parseable Status. Both known header shapes are supported ` +
            `(\`**Status:** …\` and a \`| **Status** | … |\` table row); a THIRD shape must teach ` +
            `this gate rather than be skipped by it, because a skipped file is a file this census ` +
            `silently stops protecting. Found: ${JSON.stringify(statusText.slice(0, 80))}`
        );
      }
      return { number: file.slice(0, 4), file, statusText, verdict, body };
    });
}

/** A claim one document makes about ANOTHER ADR's status, e.g. "(it is currently `Proposed`)". */
const STATUS_CLAIM =
  /ADR-(\d{4})[\s\S]{0,200}?currently\s+[`*]*(Proposed|Accepted|Superseded|Rejected)[`*]*/gi;

/** A supersession written as conditional on another ADR's acceptance. */
const CONDITIONAL_SUPERSESSION = /if and when[\s\S]{0,120}?ADR-(\d{4})[\s\S]{0,80}?is accepted/gi;

/** A proposal promising an ADR by number, once that ADR exists. */
const PROMISED_ADR = /An ADR \(?(\d{4})\)?\s+follows owner approval/i;

function docsUnder(dir: string): { file: string; body: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => ({ file, body: readFileSync(resolve(dir, file), "utf8") }));
}

describe("the ADR status-coherence gate", () => {
  const adrs = loadAdrs();
  const byNumber = new Map(adrs.map((a) => [a.number, a]));

  it("finds ADRs to police at all, and every one has a parseable Status (not vacuous)", () => {
    // `loadAdrs` throws on an unparseable Status, so reaching here proves every file parsed.
    expect(adrs.length).toBeGreaterThan(40);
    expect(adrs.filter((a) => a.verdict === "accepted").length).toBeGreaterThan(30);
  });

  it("finds BOTH header shapes, so neither parser branch has quietly died", () => {
    // 0001 established the table row; the `**Status:**` line came later. If either count hits zero
    // the regex has drifted and half the corpus is being read by accident.
    const tableRow = adrs.filter((a) => /\|\s*\*\*Status\*\*\s*\|/.test(a.body));
    const plainLine = adrs.filter((a) => /^\*\*Status:\*\*/m.test(a.body));
    expect(tableRow.length).toBeGreaterThan(0);
    expect(plainLine.length).toBeGreaterThan(20);
  });

  it("no document asserts an ADR's status that disagrees with that ADR", () => {
    const stale: string[] = [];
    for (const dir of [ADR_DIR, PROPOSALS_DIR]) {
      for (const { file, body } of docsUnder(dir)) {
        for (const m of body.matchAll(STATUS_CLAIM)) {
          const [, number, claimedRaw] = m;
          if (!number || !claimedRaw) continue;
          const target = byNumber.get(number);
          if (!target) continue;
          const claimed = claimedRaw.toLowerCase() as Verdict;
          if (claimed !== target.verdict) {
            stale.push(
              `${file}: claims ADR-${number} is currently '${claimed}', but ADR-${number} reads '${target.verdict}'`
            );
          }
        }
      }
    }
    expect(
      stale,
      "a document states another ADR's status inline and that ADR has since moved. This is how " +
        "ADR-0020 came to assert an invariant the shipped code had already broken: its E6 bullet " +
        "carried '(it is currently `Proposed`)' about ADR-0033 and nobody walked back to it when " +
        "ADR-0033 was accepted. Update the claim, or stop restating a status that lives elsewhere."
    ).toEqual([]);
  });

  it("no supersession is still written as conditional on an ADR that has since been accepted", () => {
    const dangling: string[] = [];
    for (const { file, body } of docsUnder(ADR_DIR)) {
      for (const m of body.matchAll(CONDITIONAL_SUPERSESSION)) {
        const number = m[1];
        if (!number) continue;
        const target = byNumber.get(number);
        if (target?.verdict === "accepted") {
          dangling.push(
            `${file}: supersession conditional on ADR-${number}, which is now Accepted`
          );
        }
      }
    }
    expect(
      dangling,
      "a clause reads 'superseded IF AND WHEN ADR-NNNN is accepted' and ADR-NNNN is now Accepted, " +
        "so the condition is discharged and the text still reads as though it were not. Until it " +
        "is rewritten, a reader is entitled to treat the superseded clause as governing — which " +
        "is precisely the two-accepted-documents-disagreeing failure ADR-0033 §9 exists to avoid."
    ).toEqual([]);
  });

  it("no proposal still says an ADR 'follows owner approval' once that ADR exists", () => {
    const stale: string[] = [];
    for (const { file, body } of docsUnder(PROPOSALS_DIR)) {
      const promised = PROMISED_ADR.exec(body);
      const promisedNumber = promised?.[1];
      if (!promisedNumber) continue;
      if (!byNumber.has(promisedNumber)) continue;
      const status = STATUS_LINE.exec(body)?.[1] ?? "";
      if (/pending review|^v?\d*\s*draft|proposed/i.test(status)) {
        stale.push(
          `${file}: promises ADR-${promisedNumber}, which now exists, but still reads '${status.slice(0, 60)}'`
        );
      }
    }
    expect(
      stale,
      "a proposal promises an ADR by number, that ADR now exists, and the proposal still reads as " +
        "an unreviewed draft. `governance-label-namespace.md` sat in exactly that state while the " +
        "mechanism it describes was merged and wired at the graph write doors."
    ).toEqual([]);
  });

  it("the matchers would still catch all three historical shapes (not merely re-passing)", () => {
    // ANTI-REGRESSION FOR THE CENSUS ITSELF. With every instance now fixed, the three assertions
    // above pass over an empty set — which they would also do if the regexes matched nothing at
    // all. These are the exact strings that were live in the repository on 2026-09-20.
    const adr0020 =
      "> **AMENDED 2026-08-17 — the second sentence is SUPERSEDED *if and when* [ADR-0033](0033-scan-exclusions-and-overrides.md) is accepted (it is currently `Proposed`).**";
    expect([...adr0020.matchAll(STATUS_CLAIM)].length, "the inline status claim must match").toBe(
      1
    );
    expect(
      [...adr0020.matchAll(CONDITIONAL_SUPERSESSION)].length,
      "the conditional supersession must match"
    ).toBe(1);
    expect([...adr0020.matchAll(STATUS_CLAIM)][0]?.[2]?.toLowerCase()).toBe("proposed");

    const proposal =
      "**Status:** v0.2 Draft — **proposed, pending review.** An ADR (0034) follows owner approval.";
    expect(PROMISED_ADR.exec(proposal)?.[1], "the promised-ADR number must be read").toBe("0034");
    expect(/pending review/i.test(STATUS_LINE.exec(proposal)?.[1] ?? "")).toBe(true);

    // ...and the CURRENT text of each must NOT be flagged, or the fix would not have cleared it.
    const fixed0020 =
      "> **AMENDED 2026-08-17; the supersession took effect 2026-09-20 when [ADR-0033](0033-scan-exclusions-and-overrides.md) was Accepted — the second sentence above no longer governs.**";
    expect([...fixed0020.matchAll(STATUS_CLAIM)].length).toBe(0);
    expect([...fixed0020.matchAll(CONDITIONAL_SUPERSESSION)].length).toBe(0);
  });
});
