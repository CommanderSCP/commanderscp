import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** THE CHECKS RAIL'S HONESTY RULES, as rendered (docs/proposals/pipeline-mockup-data.md §3,
 *  design-system.md §1.6/§1.6a). The rule every test here defends: the SIX absences the wire
 *  distinguishes must stay six on screen. */

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { PipelineChecksRail } = await import("./PipelineChecksRail");
const { PipelineWaveCard } = await import("./PipelineWaveCard");

import type { PipelineHookStateLike, WaveTargetChecksLike } from "./PipelineChecksRail";
import type { PipelineWaveLike, PipelineWaveTargetLike } from "./PipelineWaveCard";

const SLOT_KINDS = ["postMerge", "postDeploy", "continuous", "bakeAlarms"] as const;

const GRAIN: Record<string, string> = {
  postMerge: "per_change",
  postDeploy: "per_wave",
  continuous: "per_target",
  bakeAlarms: "per_target"
};

/** A `resolved` rail with every slot empty (= nothing declared), except the ones named. */
function checksWith(
  declared: Partial<Record<(typeof SLOT_KINDS)[number], PipelineHookStateLike[]>>
): WaveTargetChecksLike {
  return {
    basis: "resolved",
    slots: SLOT_KINDS.map((kind) => ({
      kind,
      grain: GRAIN[kind]!,
      hooks: declared[kind] ?? []
    }))
  };
}

function renderRail(checks: WaveTargetChecksLike): string {
  return renderToStaticMarkup(<PipelineChecksRail checks={checks} testIdPrefix="pipeline-wave" />);
}

/** The chip element for one kind, as raw markup — enough to assert its tone and word together
 *  rather than asserting a word that might belong to another slot's chip. */
function chipOf(html: string, kind: string): string {
  const marker = `data-kind="${kind}" data-state=`;
  const start = html.lastIndexOf("<span", html.indexOf(marker));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</span></span>", start);
  return html.slice(start, end + "</span></span>".length);
}

describe("PipelineChecksRail: four fixed slots", () => {
  it("renders all four kinds, in pipeline order, even when NOTHING is declared", () => {
    const html = renderRail(checksWith({}));

    expect(html).toContain('data-testid="pipeline-wave-checks-rail"');
    const order = [
      ...html.matchAll(/data-testid="pipeline-wave-check-slot" data-kind="(\w+)"/g)
    ].map((m) => m[1]);
    expect(order).toEqual(["postMerge", "postDeploy", "continuous", "bakeAlarms"]);
    // Fixed position is the point: the third cell is ALWAYS the canary.
    expect(html.match(/data-declared="false"/g)).toHaveLength(4);
  });

  it("an unrecognised kind from a newer server keeps its own wire word rather than vanishing", () => {
    const html = renderRail({
      basis: "resolved",
      slots: [{ kind: "preflight", grain: "per_target", hooks: [] }]
    });
    expect(html).toContain('data-kind="preflight"');
    expect(html).toContain("preflight");
  });
});

describe("PipelineChecksRail: NOT BOUND vs BOUND-BUT-SILENT (the rule this rail exists for)", () => {
  it("a slot with NO declared hook is grey, dashed and an em-dash — never amber", () => {
    const html = renderRail(checksWith({}));
    const chip = chipOf(html, "continuous");

    expect(chip).toContain('data-state="not_declared"');
    expect(chip).toContain('data-tone="unbound"');
    expect(chip).toContain("—");
    expect(chip).toContain("No continuous probe is declared for this component");
    // THE WHOLE POINT. Amber says "someone promised this and it went quiet". Nobody promised this.
    expect(chip).not.toContain("amber");
    expect(chip).toContain("border-slate-200");
  });

  it("a DECLARED probe that has never reported is amber and says 'no evidence' — a different chip entirely", () => {
    const html = renderRail({
      basis: "resolved",
      slots: [
        {
          kind: "continuous",
          grain: "per_target",
          hooks: [{ state: "no_evidence", hookId: "smoke", maxAgeSeconds: 300 }]
        }
      ]
    });
    const chip = chipOf(html, "continuous");

    expect(chip).toContain('data-state="no_evidence"');
    expect(chip).toContain('data-tone="watch"');
    expect(chip).toContain("no evidence");
    expect(chip).toContain("amber");
    expect(chip).toContain("has NEVER reported");
    expect(chip).toContain("check the prober");
    // MUTATION-PROOF PAIR: the em-dash and the unbound tone belong to the OTHER case. If the
    // component ever collapsed "not declared" into "no evidence" (or the reverse), exactly one of
    // this pair of tests goes red, because neither assertion set is satisfiable by the other state.
    expect(chip).not.toContain('data-tone="unbound"');
    expect(chip).not.toContain("is declared for this component");
  });

  it("'not run' and 'not declared' share a grey but never a word", () => {
    const html = renderRail(checksWith({ postDeploy: [{ state: "not_run", hookId: "e2e" }] }));
    const notRun = chipOf(html, "postDeploy");
    const notDeclared = chipOf(html, "postMerge");

    expect(notRun).toContain("not run");
    expect(notRun).toContain('data-tone="waiting"');
    expect(notRun).toContain("something promised it");
    expect(notDeclared).toContain("—");
    expect(notDeclared).toContain('data-tone="unbound"');
    // One is waiting; the other will never happen.
    expect(notDeclared).not.toContain("not run");
    expect(notRun).not.toContain('data-state="not_declared"');
  });
});

describe("PipelineChecksRail: the continuous verdicts", () => {
  it("STALE is its own word and its own sentence — never folded into 'no evidence', never a pass", () => {
    const newest = new Date(Date.now() - 42 * 60_000).toISOString();
    const html = renderRail({
      basis: "resolved",
      slots: [
        {
          kind: "continuous",
          grain: "per_target",
          hooks: [
            {
              state: "stale",
              hookId: "smoke",
              maxAgeSeconds: 300,
              newestEvidenceAt: newest,
              staleAfter: new Date(Date.parse(newest) + 300_000).toISOString()
            }
          ]
        }
      ]
    });
    const chip = chipOf(html, "continuous");

    expect(chip).toContain('data-state="stale"');
    expect(chip).toContain('data-tone="watch"');
    expect(chip).toContain("stale · 42 min");
    expect(chip).toContain("ABSENT, not a pass and not a fail");
    // The two amber absences must not swap words: `stale` reported once, `no_evidence` never did.
    expect(chip).not.toContain("no evidence");
    expect(chip).not.toContain("NEVER reported");
    // And it is emphatically not a pass.
    expect(chip).not.toContain('data-tone="pass"');
  });

  it("a fresh pass carries BOTH the word and the evidence age (colour is never the only signal)", () => {
    const html = renderRail({
      basis: "resolved",
      slots: [
        {
          kind: "continuous",
          grain: "per_target",
          hooks: [
            {
              state: "passed",
              hookId: "smoke",
              concludedAt: new Date(Date.now() - 40_000).toISOString(),
              externalUrl: null
            }
          ]
        }
      ]
    });
    const chip = chipOf(html, "continuous");

    expect(chip).toContain('data-tone="pass"');
    expect(chip).toMatch(/pass · (39|40|41) s/);
  });

  it("a FAILED probe says the target is sick, not that the prober is quiet", () => {
    const html = renderRail({
      basis: "resolved",
      slots: [
        {
          kind: "continuous",
          grain: "per_target",
          hooks: [
            {
              state: "failed",
              hookId: "smoke",
              concludedAt: "2026-09-19T10:00:00.000Z",
              runStatus: null,
              externalUrl: null
            }
          ]
        }
      ]
    });
    const chip = chipOf(html, "continuous");

    expect(chip).toContain('data-tone="fail"');
    expect(chip).toContain("failed");
    expect(chip).toContain("a claim about the target, not about the prober");
  });
});

describe("PipelineChecksRail: the run-backed kinds", () => {
  it("an ABORTED run keeps its own word beside the failing colour", () => {
    const html = renderRail(
      checksWith({
        postMerge: [
          {
            state: "failed",
            hookId: "unit",
            concludedAt: "2026-09-19T10:00:00.000Z",
            runStatus: "aborted",
            externalUrl: "https://ci.example/run/1"
          }
        ]
      })
    );
    const chip = chipOf(html, "postMerge");

    expect(chip).toContain('data-tone="fail"');
    expect(chip).toContain("aborted");
    expect(chip).toContain("recorded status &#x27;aborted&#x27;");
  });

  it("'pending' renders as DISPATCHED and 'running' as RUNNING — one state, two recorded words", () => {
    const dispatched = chipOf(
      renderRail(
        checksWith({
          postMerge: [
            {
              state: "running",
              hookId: "unit",
              startedAt: "2026-09-19T10:00:00.000Z",
              runStatus: "pending",
              externalUrl: null
            }
          ]
        })
      ),
      "postMerge"
    );
    const running = chipOf(
      renderRail(
        checksWith({
          postMerge: [
            {
              state: "running",
              hookId: "unit",
              startedAt: "2026-09-19T10:00:00.000Z",
              runStatus: "running",
              externalUrl: null
            }
          ]
        })
      ),
      "postMerge"
    );

    expect(dispatched).toContain("dispatched");
    expect(running).toContain(">running<");
    expect(dispatched).toContain('data-tone="run"');
  });

  it("GRAIN IS STATED: a post-merge chip says the record is the CHANGE's, a post-deploy chip the WAVE's", () => {
    const html = renderRail(
      checksWith({
        postMerge: [{ state: "not_run", hookId: "unit" }],
        postDeploy: [{ state: "not_run", hookId: "e2e" }],
        continuous: [{ state: "no_evidence", hookId: "smoke", maxAgeSeconds: 300 }]
      })
    );

    // §3.4: `pipeline_hook_runs` is keyed (change, hookId, waveIndex), never by target, so the rail
    // must not read as "this target's post-deploy test".
    expect(chipOf(html, "postMerge")).toContain("This is the CHANGE&#x27;s post-merge run");
    expect(chipOf(html, "postDeploy")).toContain("This is the WAVE&#x27;s post-deploy run");
    // The canary really IS per (component, target) — it must NOT carry the disclaimer.
    expect(chipOf(html, "continuous")).not.toContain("every target of this");
  });
});

describe("PipelineChecksRail: the bake states", () => {
  it("DECLARED BUT NOT STARTED is rendered, not omitted — and it is grey, not amber", () => {
    const html = renderRail(
      checksWith({
        bakeAlarms: [{ state: "bake_not_started", hookId: "sev1", quietWindowSeconds: 600 }]
      })
    );
    const chip = chipOf(html, "bakeAlarms");

    expect(chip).toContain('data-state="bake_not_started"');
    expect(chip).toContain("10 m — not started");
    // Waiting, not alarming: nobody has done anything wrong yet.
    expect(chip).toContain('data-tone="waiting"');
    expect(chip).toContain("its quiet window has not opened");
    // And it is NOT the undeclared slot's em-dash: something did promise this window.
    expect(chip).not.toContain('data-state="not_declared"');
  });

  it("a quiet window reads 'clear' and names what covered it; an open one reads 'baking'", () => {
    const quiet = chipOf(
      renderRail(
        checksWith({
          bakeAlarms: [
            {
              state: "quiet",
              hookId: "sev1",
              quietWindowSeconds: 600,
              windowEndsAt: "2026-09-19T10:10:00.000Z",
              coveredBy: ["pushed"]
            }
          ]
        })
      ),
      "bakeAlarms"
    );
    const baking = chipOf(
      renderRail(
        checksWith({
          bakeAlarms: [
            {
              state: "baking",
              hookId: "sev1",
              quietWindowSeconds: 600,
              windowEndsAt: "2026-09-19T10:10:00.000Z"
            }
          ]
        })
      ),
      "bakeAlarms"
    );

    expect(quiet).toContain("clear");
    expect(quiet).toContain('data-tone="pass"');
    expect(quiet).toContain("covered by: pushed");
    expect(baking).toContain("baking");
    expect(baking).toContain('data-tone="run"');
    // An open window has established NOTHING yet.
    expect(baking).toContain("Nothing is established until it closes");
    expect(baking).not.toContain('data-tone="pass"');
  });

  it("a firing alarm is red; an elapsed window with a gap and one with no source stay distinct and amber", () => {
    const firing = chipOf(
      renderRail(
        checksWith({
          bakeAlarms: [
            {
              state: "alarm_firing",
              hookId: "sev1",
              windowEndsAt: "2026-09-19T10:10:00.000Z",
              since: "2026-09-19T10:02:00.000Z"
            }
          ]
        })
      ),
      "bakeAlarms"
    );
    const gap = chipOf(
      renderRail(
        checksWith({
          bakeAlarms: [
            {
              state: "window_not_covered",
              hookId: "sev1",
              quietWindowSeconds: 600,
              windowEndsAt: "2026-09-19T10:10:00.000Z"
            }
          ]
        })
      ),
      "bakeAlarms"
    );
    const noSource = chipOf(
      renderRail(
        checksWith({
          bakeAlarms: [
            {
              state: "no_source",
              hookId: "sev1",
              quietWindowSeconds: 600,
              windowEndsAt: "2026-09-19T10:10:00.000Z"
            }
          ]
        })
      ),
      "bakeAlarms"
    );

    expect(firing).toContain('data-tone="fail"');
    expect(firing).toContain("alarm");
    expect(gap).toContain("window gap");
    expect(gap).toContain("leave a GAP");
    expect(noSource).toContain("no source");
    expect(noSource).toContain("NOTHING reported alarm state");
    // "reports exist and stopped" and "nothing ever reported" are different places to look.
    expect(gap).not.toContain("no source");
    expect(noSource).not.toContain("window gap");
  });
});

describe("PipelineChecksRail: states this bundle cannot interpret", () => {
  it("a state from a newer server renders as itself and is explicitly neither a pass nor a failure", () => {
    const html = renderRail(checksWith({ postDeploy: [{ state: "not_reported", hookId: "e2e" }] }));
    const chip = chipOf(html, "postDeploy");

    expect(chip).toContain('data-state="not_reported"');
    expect(chip).toContain("not_reported");
    expect(chip).toContain("does not know how to interpret");
    expect(chip).toContain("NOT a pass and NOT a failure");
    expect(chip).not.toContain('data-tone="pass"');
  });

  it("an UNRESOLVABLE rail states the absence instead of drawing four empty slots", () => {
    const html = renderRail({
      basis: "unresolvable",
      reason: "this wave target's object could not be resolved to a component"
    });

    expect(html).toContain('data-testid="pipeline-wave-checks-unresolvable"');
    expect(html).toContain("checks unknown");
    expect(html).toContain("NOT a statement that no check is declared");
    // FOUR EMPTY SLOTS WOULD BE A LIE here: they claim nothing is declared, which is precisely the
    // thing this instance could not determine.
    expect(html).not.toContain('data-testid="pipeline-wave-checks-rail"');
    expect(html).not.toContain('data-state="not_declared"');
  });
});

describe("PipelineWaveCard: the rail is wired to the target row", () => {
  const BASE_TARGET: PipelineWaveTargetLike = {
    id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
    targetObjectId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
    targetName: "agentkit-bootstrap @ gamma",
    status: "succeeded",
    category: "deploy",
    type: "configuration",
    attempt: 1
  };

  function waveWith(target: PipelineWaveTargetLike): PipelineWaveLike {
    return {
      id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      waveIndex: 0,
      name: "gamma",
      status: "succeeded",
      requiresFanIn: false,
      startedAt: "2026-08-10T10:01:00.000Z",
      completedAt: "2026-08-10T10:05:00.000Z",
      targets: [target]
    };
  }

  function renderCard(target: PipelineWaveTargetLike): string {
    return renderToStaticMarkup(<PipelineWaveCard wave={waveWith(target)} waveNumber={1} />);
  }

  it("renders the rail on the target row when the server sent `checks`", () => {
    const html = renderCard({ ...BASE_TARGET, checks: checksWith({}) });
    expect(html).toContain('data-testid="pipeline-wave-checks-rail"');
    expect(html).toContain('data-kind="bakeAlarms"');
  });

  it("renders NO rail at all when `checks` is absent — absence means this caller does not know", () => {
    // The negative half that makes the case above mean something: a payload predating the field (or
    // a campaign wave target, which has no pipeline hooks) must not thereby assert four undeclared
    // checks. Four grey em-dashes here would be a fabricated claim about the component.
    const html = renderCard(BASE_TARGET);
    expect(html).not.toContain("checks-rail");
    expect(html).not.toContain('data-state="not_declared"');
  });
});
