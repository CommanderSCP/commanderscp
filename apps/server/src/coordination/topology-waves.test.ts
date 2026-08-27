import { describe, expect, it } from "vitest";
import { parseTopologyWaves } from "./topology-waves.js";

/**
 * Unit tests for `parseTopologyWaves`'s `gates` handling (§14 resolution 5). The rest of the
 * parser's loud-refusal behaviour (malformed `waves`, bad `mode`, missing `targets`, ...) is
 * pinned by `stage-compilation.integration.test.ts`'s mutation log; these tests are scoped to what
 * changed here: the `gates` key itself, and the fact that adding it must not weaken every OTHER
 * unknown-key refusal.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | drop `"gates"` from `KNOWN_WAVE_KEYS` | "a valid gates entry parses" fails |
 * | drop the `WaveGateSchema` validation (accept any `gates` array) | "a malformed gates entry is refused" fails |
 * | normalize absent `gates` to `[]` (`w.gates ?? []`), or empty `[]` to `undefined` | "absent gates and an empty gates array parse to DISTINGUISHABLE" fails |
 */
describe("coordination/topology-waves — parseTopologyWaves gates", () => {
  const wave = (extra: Record<string, unknown> = {}) => ({
    name: "gamma",
    mode: "parallel" as const,
    targets: ["t1"],
    ...extra
  });

  it("a valid gates entry parses", () => {
    const result = parseTopologyWaves({
      waves: [wave({ gates: [{ kind: "postDeployTest" }, { kind: "bakeAlarms", hookId: "h1" }] })]
    });
    expect(result).toEqual([
      {
        name: "gamma",
        mode: "parallel",
        targets: ["t1"],
        gates: [{ kind: "postDeployTest" }, { kind: "bakeAlarms", hookId: "h1" }]
      }
    ]);
  });

  it("a malformed gates entry is refused", () => {
    expect(() =>
      parseTopologyWaves({ waves: [wave({ gates: [{ kind: "notARealGateKind" }] })] })
    ).toThrow();
  });

  it("a non-array gates value is refused", () => {
    expect(() => parseTopologyWaves({ waves: [wave({ gates: "not-an-array" })] })).toThrow();
  });

  it("an unrelated unknown key is STILL refused — adding `gates` must not weaken this", () => {
    expect(() =>
      parseTopologyWaves({
        waves: [wave({ gates: [{ kind: "postDeployTest" }], totallyMadeUp: true })]
      })
    ).toThrow();
    // And on its own, with no `gates` in sight at all — the pre-existing behaviour this change
    // must not touch.
    expect(() => parseTopologyWaves({ waves: [wave({ totallyMadeUp: true })] })).toThrow();
  });

  it("a wave with no gates key is unchanged", () => {
    const result = parseTopologyWaves({ waves: [wave()] });
    expect(result).toEqual([{ name: "gamma", mode: "parallel", targets: ["t1"] }]);
    expect(result![0]).not.toHaveProperty("gates");
  });

  it("absent gates and an empty gates array parse to DISTINGUISHABLE results — 'empty' means 'adds none', not 'has none'", () => {
    const result = parseTopologyWaves({
      waves: [
        wave({ name: "no-gates-key", targets: ["t1"] }),
        wave({ name: "empty-gates", targets: ["t2"], gates: [] })
      ]
    })!;

    const [absent, empty] = result;

    // The key itself must be genuinely ABSENT for the silent wave, not present-with-undefined —
    // otherwise a `hasOwnProperty`/`"gates" in wave` check downstream (the honest way to read this
    // distinction) would see it as "present" and misread silence as an explicit empty statement.
    expect(absent).not.toHaveProperty("gates");
    expect(absent!.gates).toBeUndefined();

    // The empty-statement wave keeps a present, empty array — not collapsed to undefined.
    expect(empty).toHaveProperty("gates");
    expect(empty!.gates).toEqual([]);

    // And the two must not read as the same value by any reasonable equality.
    expect(absent!.gates).not.toEqual(empty!.gates);
  });
});
