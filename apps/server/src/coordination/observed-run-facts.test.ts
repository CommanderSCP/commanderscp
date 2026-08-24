import { describe, expect, it } from "vitest";
import { runIdentityOfSourceRef } from "./observed-run-facts.js";

/**
 * `runIdentityOfSourceRef` — the predicate + read beneath `observedRun`
 * (component-journey-view.md §3 Segment 2). One case per writer shape traced in the module doc:
 * github flat-nested-under-`raw` (observed) and nested-under-`workflow_run` (webhook), gitea
 * (observed only — its webhook adapter maps no run-completion event), gitlab pipeline (observed) and
 * `object_attributes` (webhook) — plus absence and malformed input for each.
 */
describe("runIdentityOfSourceRef", () => {
  describe("github — OBSERVED (poll) shape: the run object nested under sourceRef.raw", () => {
    const observedSourceRef = {
      repo: "acme/api",
      correlationKey: "run-30858160395",
      kind: "workflow_run",
      _observed: true,
      raw: {
        id: 30858160395,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/api/actions/runs/30858160395",
        head_sha: "a".repeat(40),
        workflow_id: 12345,
        name: "CI",
        path: ".github/workflows/ci.yml",
        repository: { full_name: "acme/api" }
      }
    };

    it("reads id/url/name/path", () => {
      expect(runIdentityOfSourceRef("github", observedSourceRef)).toEqual({
        repo: "acme/api",
        runId: "30858160395",
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        url: "https://github.com/acme/api/actions/runs/30858160395"
      });
    });

    it("absent when kind is not workflow_run (a polled push must never be misread as a run)", () => {
      expect(runIdentityOfSourceRef("github", { ...observedSourceRef, kind: "push" })).toBeNull();
    });

    it("absent when _observed is not true", () => {
      const { _observed: _dropped, ...rest } = observedSourceRef;
      expect(runIdentityOfSourceRef("github", rest)).toBeNull();
    });

    it("workflowName/workflowPath null when the run object omits them (malformed/older payload), run identity still reads", () => {
      const { name: _n, path: _p, ...runWithoutNameOrPath } = observedSourceRef.raw;
      expect(
        runIdentityOfSourceRef("github", { ...observedSourceRef, raw: runWithoutNameOrPath })
      ).toEqual({
        repo: "acme/api",
        runId: "30858160395",
        workflowName: null,
        workflowPath: null,
        url: "https://github.com/acme/api/actions/runs/30858160395"
      });
    });

    it("absent when raw.id is missing (malformed run object) even though url/repo are present", () => {
      const { id: _id, ...runWithoutId } = observedSourceRef.raw;
      expect(
        runIdentityOfSourceRef("github", { ...observedSourceRef, raw: runWithoutId })
      ).toBeNull();
    });

    it("absent when neither url nor repo is present (a bare run id names nothing actionable)", () => {
      const { html_url: _u, ...runWithoutUrl } = observedSourceRef.raw;
      expect(
        runIdentityOfSourceRef("github", {
          repo: undefined,
          kind: "workflow_run",
          _observed: true,
          raw: runWithoutUrl
        })
      ).toBeNull();
    });
  });

  describe("github — WEBHOOK shape: the run object nested under sourceRef.workflow_run", () => {
    const webhookSourceRef = {
      action: "completed",
      repo: "acme/api",
      ref: "refs/heads/main",
      commit: "b".repeat(40),
      workflow_run: {
        id: 30858160500,
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/acme/api/actions/runs/30858160500",
        head_sha: "b".repeat(40),
        name: "CI",
        path: ".github/workflows/ci.yml"
      },
      repository: { full_name: "acme/api" }
    };

    it("reads id/url/name/path from the nested workflow_run object, preferring it over any raw shape", () => {
      expect(runIdentityOfSourceRef("github", webhookSourceRef)).toEqual({
        repo: "acme/api",
        runId: "30858160500",
        workflowName: "CI",
        workflowPath: ".github/workflows/ci.yml",
        url: "https://github.com/acme/api/actions/runs/30858160500"
      });
    });

    it("absent when workflow_run is not an object (a push/pull_request webhook's sourceRef)", () => {
      expect(
        runIdentityOfSourceRef("github", { repo: "acme/api", ref: "refs/heads/main" })
      ).toBeNull();
    });

    it("absent when workflow_run is malformed (not a record)", () => {
      expect(
        runIdentityOfSourceRef("github", { ...webhookSourceRef, workflow_run: "not-an-object" })
      ).toBeNull();
    });
  });

  describe("gitea — OBSERVED (poll) shape only; its webhook adapter maps no run-completion event", () => {
    const observedSourceRef = {
      repo: "acme/api",
      kind: "workflow_run",
      _observed: true,
      raw: {
        id: 42,
        status: "success",
        head_sha: "c".repeat(40),
        html_url: "https://gitea.example.com/acme/api/actions/runs/42",
        created_at: "2026-08-20T00:00:00.000Z"
      }
    };

    it("reads id/url; workflowName/workflowPath stay null (never cited for gitea)", () => {
      expect(runIdentityOfSourceRef("gitea", observedSourceRef)).toEqual({
        repo: "acme/api",
        runId: "42",
        workflowName: null,
        workflowPath: null,
        url: "https://gitea.example.com/acme/api/actions/runs/42"
      });
    });

    it("a name/path present on a future gitea payload is still NOT read (uncited key discipline)", () => {
      expect(
        runIdentityOfSourceRef("gitea", {
          ...observedSourceRef,
          raw: { ...observedSourceRef.raw, name: "CI", path: ".gitea/workflows/ci.yml" }
        })
      ).toEqual({
        repo: "acme/api",
        runId: "42",
        workflowName: null,
        workflowPath: null,
        url: "https://gitea.example.com/acme/api/actions/runs/42"
      });
    });

    it("absent for a gitea webhook-shaped sourceRef (no workflow_run key, no _observed marker)", () => {
      expect(
        runIdentityOfSourceRef("gitea", {
          repo: "acme/api",
          ref: "refs/heads/main",
          commit: "c".repeat(40)
        })
      ).toBeNull();
    });

    it("absent when malformed (raw is not a record)", () => {
      expect(runIdentityOfSourceRef("gitea", { ...observedSourceRef, raw: null })).toBeNull();
    });
  });

  describe("gitlab — OBSERVED (poll) shape: GitlabPipeline nested under sourceRef.raw", () => {
    const observedSourceRef = {
      repo: "acme/api",
      kind: "workflow_run",
      _observed: true,
      raw: {
        id: 987654,
        status: "success",
        sha: "d".repeat(40),
        ref: "main",
        web_url: "https://gitlab.example.com/acme/api/-/pipelines/987654"
      }
    };

    it("reads id/web_url; a pipeline has no workflow name/path", () => {
      expect(runIdentityOfSourceRef("gitlab", observedSourceRef)).toEqual({
        repo: "acme/api",
        runId: "987654",
        workflowName: null,
        workflowPath: null,
        url: "https://gitlab.example.com/acme/api/-/pipelines/987654"
      });
    });
  });

  describe("gitlab — WEBHOOK 'Pipeline Hook' shape: id/sha/ref under sourceRef.object_attributes", () => {
    const pipelineHookSourceRef = {
      repo: "acme/api",
      commit: "e".repeat(40),
      object_attributes: {
        id: 555111,
        sha: "e".repeat(40),
        ref: "main",
        status: "success"
      }
    };

    it("reads the pipeline id; no url is cited by the adapter for this shape, so url is null", () => {
      expect(runIdentityOfSourceRef("gitlab", pipelineHookSourceRef)).toEqual({
        repo: "acme/api",
        runId: "555111",
        workflowName: null,
        workflowPath: null,
        url: null
      });
    });

    it("absent for a 'Merge Request Hook' shape — object_attributes.id present but no sibling sha/ref (the collision this guards against)", () => {
      const mergeRequestHookSourceRef = {
        repo: "acme/api",
        object_attributes: {
          id: 555111, // a REAL GitLab field on an MR object_attributes — not a pipeline id
          iid: 7,
          last_commit: { id: "f".repeat(40) }
        }
      };
      expect(runIdentityOfSourceRef("gitlab", mergeRequestHookSourceRef)).toBeNull();
    });

    it("absent when object_attributes carries id+sha but no ref (partial/malformed)", () => {
      expect(
        runIdentityOfSourceRef("gitlab", {
          repo: "acme/api",
          object_attributes: { id: 1, sha: "e".repeat(40) }
        })
      ).toBeNull();
    });
  });

  describe("absence and malformed input, generically", () => {
    it("absent when sourceRef is not a record", () => {
      expect(runIdentityOfSourceRef("github", null)).toBeNull();
      expect(runIdentityOfSourceRef("github", "a string")).toBeNull();
      expect(runIdentityOfSourceRef("github", ["array"])).toBeNull();
      expect(runIdentityOfSourceRef("github", undefined)).toBeNull();
    });

    it("absent for an unrecognized sourceKind, even with a github-shaped payload", () => {
      expect(
        runIdentityOfSourceRef("harbor", {
          repo: "acme/api",
          kind: "workflow_run",
          _observed: true,
          raw: { id: 1, html_url: "https://example.com/run/1" }
        })
      ).toBeNull();
    });

    it("absent for a null/undefined sourceKind", () => {
      expect(
        runIdentityOfSourceRef(null, {
          kind: "workflow_run",
          _observed: true,
          raw: { id: 1, html_url: "https://example.com/run/1" }
        })
      ).toBeNull();
      expect(
        runIdentityOfSourceRef(undefined, {
          kind: "workflow_run",
          _observed: true,
          raw: { id: 1, html_url: "https://example.com/run/1" }
        })
      ).toBeNull();
    });

    it("a GitHub commit's own html_url does not false-positive as a run — no id field on a commit object at all, and the kind guard rejects it anyway", () => {
      // The shape `pollCommits` actually persists: kind "push", raw = the GitHub commit object,
      // which carries `html_url` (a real GitHub commit field) but no `id`.
      expect(
        runIdentityOfSourceRef("github", {
          repo: "acme/api",
          kind: "push",
          _observed: true,
          raw: {
            sha: "1a".repeat(20),
            html_url: "https://github.com/acme/api/commit/" + "1a".repeat(20),
            commit: { author: { date: "2026-08-20T00:00:00.000Z" } }
          }
        })
      ).toBeNull();
    });

    it("a GitLab commit's own `id` (its sha) does not false-positive as a pipeline id — the kind guard rejects a push event", () => {
      // GitLab spells a commit's sha `id`, which WOULD collide with `gitlabPipelineFields` reading
      // `raw.id` if the kind discriminator were dropped.
      expect(
        runIdentityOfSourceRef("gitlab", {
          repo: "acme/api",
          kind: "push",
          _observed: true,
          raw: {
            id: "d".repeat(40),
            created_at: "2026-08-20T00:00:00.000Z"
          }
        })
      ).toBeNull();
    });
  });
});
