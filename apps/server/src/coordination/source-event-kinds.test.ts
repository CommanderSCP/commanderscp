import { describe, expect, it } from "vitest";
import { classifySourceEvent } from "./source-event-kinds.js";

/**
 * The allowlist, one row per census site in docs/proposals/run-events-are-not-releases.md §4, plus
 * every designated source kind. Each row carries the exact stored shape: webhook rows carry the
 * provider's event header, and observed rows carry `observe.ts#ingestObservedEvents`' payload with
 * `headers: {}`. The integration suite (`run-events-are-not-releases.integration.test.ts`) proves the
 * gate is wired into the processor. This table proves every site is classified.
 */
const observed = (kind: string) => ({ _observed: true, kind, repo: "acme/api", raw: {} });

describe("classifySourceEvent — non-source events never propose (the 11 census sites)", () => {
  it.each([
    ["1 github pollRuns", "github", {}, observed("workflow_run")],
    ["2 github webhook workflow_run", "github", { "x-github-event": "workflow_run" }, { workflow_run: { id: 1 } }],
    ["3 gitea pollRuns", "gitea", {}, observed("workflow_run")],
    ["4 gitlab pollRuns", "gitlab", {}, observed("workflow_run")],
    ["5 gitlab Pipeline Hook", "gitlab", { "x-gitlab-event": "Pipeline Hook" }, { object_attributes: { id: 1 } }],
    ["6 argo-workflows observe", "argo-workflows", {}, observed("workflow_run")],
    ["7 argocd observe sync", "argocd", {}, observed("sync")],
    ["8 github webhook deployment", "github", { "x-github-event": "deployment" }, { deployment: { id: 1 } }],
    ["9 github pull_request", "github", { "x-github-event": "pull_request" }, { pull_request: { number: 1 } }],
    ["10 gitea pull_request", "gitea", { "x-gitea-event": "pull_request" }, { pull_request: { number: 1 } }],
    ["11 gitlab Merge Request Hook", "gitlab", { "x-gitlab-event": "Merge Request Hook" }, { object_attributes: { iid: 1 } }],
    ["an unrecognised github event (fail closed)", "github", { "x-github-event": "check_run" }, { repo: "acme/api" }],
    ["an unrecognised harbor type (fail closed)", "harbor", {}, { type: "SCANNING_COMPLETED" }],
    ["an observed event with no kind (fail closed)", "github", {}, { _observed: true, repo: "acme/api" }]
  ])("%s", (_label, sourceKind, headers, payload) => {
    expect(classifySourceEvent(sourceKind, headers, payload).proposesChange).toBe(false);
  });
});

describe("classifySourceEvent — source events still propose", () => {
  it.each([
    ["github push webhook", "github", { "x-github-event": "push" }, { ref: "refs/heads/main" }],
    ["github release webhook", "github", { "x-github-event": "release" }, { release: {} }],
    ["gitea push webhook", "gitea", { "x-gitea-event": "push" }, {}],
    ["gitea release webhook", "gitea", { "x-gitea-event": "release" }, {}],
    ["gitea package webhook", "gitea", { "x-gitea-event": "package" }, {}],
    ["gitlab Push Hook", "gitlab", { "x-gitlab-event": "Push Hook" }, {}],
    ["gitlab Tag Push Hook", "gitlab", { "x-gitlab-event": "Tag Push Hook" }, {}],
    ["harbor PUSH_ARTIFACT", "harbor", {}, { type: "PUSH_ARTIFACT" }],
    ["github pollCommits", "github", {}, observed("push")],
    ["gitea pollPackages (filed as custom)", "gitea", {}, observed("custom")],
    ["first-party report (no header, not observed)", "github", {}, { repo: "acme/api", commit: "abc" }],
    ["first-party report for a source kind with no adapter", "terraform", {}, { repo: "acme/infra" }]
  ])("%s", (_label, sourceKind, headers, payload) => {
    expect(classifySourceEvent(sourceKind, headers, payload).proposesChange).toBe(true);
  });
});
