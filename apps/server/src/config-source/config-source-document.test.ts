import { describe, expect, it } from "vitest";
import {
  CONFIG_SOURCE_TYPE_ID,
  delegatedTeamRefs,
  parseConfigSourceDocument
} from "./config-source-document.js";

/** The pure half of the config-source authoring door. See docs/config-source.md §6. */
describe("config-source document", () => {
  /** Assert on `detail`, since the title matches any 400. See docs/config-source.md §7. */
  function refusalDetail(fn: () => unknown): string {
    try {
      fn();
    } catch (error) {
      const detail = (error as { detail?: string }).detail;
      if (typeof detail === "string") return detail;
      throw error;
    }
    throw new Error("expected a refusal, got a value");
  }

  const valid = {
    repoPattern: "git.corp.example/payments/*",
    ref: "main",
    paths: ["scp/manifest.json", "**/scp/manifest.json"],
    team: "urn:scp:team:payments",
    stackTeams: { "payments-api": "urn:scp:team:payments-api" }
  };

  it("parses a well-formed registration, trimming what it stores", () => {
    const doc = parseConfigSourceDocument(
      { ...valid, ref: "  main  ", team: "  urn:scp:team:payments  " },
      "config-source 'x'"
    );
    expect(doc).toEqual({
      repoPattern: "git.corp.example/payments/*",
      ref: "main",
      paths: ["scp/manifest.json", "**/scp/manifest.json"],
      team: "urn:scp:team:payments",
      stackTeams: { "payments-api": "urn:scp:team:payments-api" }
    });
  });

  it("defaults `stackTeams` to empty — a registration may bind no stack yet", () => {
    const { stackTeams } = parseConfigSourceDocument(
      { ...valid, stackTeams: undefined },
      "config-source 'x'"
    );
    expect(stackTeams).toEqual({});
  });

  // EXACTLY ONE ADDRESSING FORM — the rule migration 0100 refuses to put on the wire

  it("refuses NEITHER `repo` nor `repoPattern` — it would match no repository and never sync", () => {
    expect(
      refusalDetail(() =>
        parseConfigSourceDocument(
          { ...valid, repo: undefined, repoPattern: undefined },
          "config-source 'x'"
        )
      )
    ).toMatch(/exactly one of 'repo'.*never sync/s);
  });

  it("refuses BOTH — which one decides must not be an implementation detail", () => {
    expect(
      refusalDetail(() =>
        parseConfigSourceDocument(
          { ...valid, repo: "git.corp.example/payments/api" },
          "config-source 'x'"
        )
      )
    ).toMatch(/exactly one of 'repo'/);
  });

  it("treats an empty-string `repo` as absent, not as a second declared form", () => {
    // Otherwise `{repo: "", repoPattern: "…"}` — what a template or a form POST produces — reads as
    // "both declared" and is refused for a reason its author cannot see in what they wrote.
    const doc = parseConfigSourceDocument({ ...valid, repo: "" }, "config-source 'x'");
    expect(doc.repo).toBeUndefined();
    expect(doc.repoPattern).toBe("git.corp.example/payments/*");
  });

  it("refuses an empty `paths` — it selects no manifest and looks exactly like a quiet repo", () => {
    expect(
      refusalDetail(() => parseConfigSourceDocument({ ...valid, paths: [] }, "config-source 'x'"))
    ).toMatch(/'paths' must be a non-empty array/);
  });

  it("refuses a missing `ref` and a missing `team`", () => {
    expect(
      refusalDetail(() =>
        parseConfigSourceDocument({ ...valid, ref: undefined }, "config-source 'x'")
      )
    ).toMatch(/'ref' must be a non-empty string/);
    expect(
      refusalDetail(() => parseConfigSourceDocument({ ...valid, team: "   " }, "config-source 'x'"))
    ).toMatch(/'team' must be a non-empty string/);
  });

  it("refuses a `stackTeams` entry whose value is not a team reference", () => {
    expect(
      refusalDetail(() =>
        parseConfigSourceDocument({ ...valid, stackTeams: { api: 7 } }, "config-source 'x'")
      )
    ).toMatch(/stackTeams\["api"\]/);
  });

  it("names the caller's subject in every refusal, so one rule reads the same at every door", () => {
    expect(
      refusalDetail(() => parseConfigSourceDocument({}, "config-source 'payments-fleet'"))
    ).toMatch(/config-source 'payments-fleet'/);
  });

  // THE DELEGATION SURFACE — what the authority check must cover

  it("delegatedTeamRefs covers the default team AND every stackTeams value, deduped and sorted", () => {
    const doc = parseConfigSourceDocument(
      {
        ...valid,
        team: "urn:scp:team:b",
        stackTeams: { one: "urn:scp:team:a", two: "urn:scp:team:b", three: "urn:scp:team:c" }
      },
      "config-source 'x'"
    );
    // `urn:scp:team:b` appears as BOTH the default and a per-stack value and must appear once: the
    // door authorizes per ref, and a duplicate would only ever cost a second identical query.
    expect(delegatedTeamRefs(doc)).toEqual(["urn:scp:team:a", "urn:scp:team:b", "urn:scp:team:c"]);
  });

  it("delegatedTeamRefs reads the document, never the raw properties", () => {
    // The guard computes the delegation surface from the PARSED document precisely so a field
    // added to `ConfigSourceDocument` later cannot reach a door that never learned to look at it —
    // a raw-properties scan would silently keep passing while covering less.
    const doc = parseConfigSourceDocument(valid, "config-source 'x'");
    expect(delegatedTeamRefs(doc)).toEqual(["urn:scp:team:payments", "urn:scp:team:payments-api"]);
  });

  it("exports the one type id, so no consumer spells it a second time", () => {
    expect(CONFIG_SOURCE_TYPE_ID).toBe("config-source");
  });
});
