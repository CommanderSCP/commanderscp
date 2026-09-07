import { describe, expect, it } from "vitest";
import {
  GIT_PROVIDER_MODULES,
  bindingRepoIdentity,
  isGitProviderModule,
  normalizeRepoIdentity
} from "./manifest-reader.js";

/** M21.4 — WHICH BINDING MAY READ WHICH REPO. See docs/dependencies.md §341. */

describe("bindingRepoIdentity", () => {
  it("reads github/gitea's owner + repo, the same fields their adapters require", () => {
    expect(bindingRepoIdentity({ owner: "acme", repo: "widgets" })).toBe("acme/widgets");
  });

  it("prefers gitlab's projectPath, which legitimately nests", () => {
    expect(bindingRepoIdentity({ projectPath: "acme/platform/widgets" })).toBe(
      "acme/platform/widgets"
    );
    // `projectPathOf` in the gitlab adapter takes projectPath over owner/repo; reading a DIFFERENT
    // field here than the adapter uses would match a binding that then addresses somewhere else.
    expect(
      bindingRepoIdentity({ projectPath: "acme/platform/widgets", owner: "acme", repo: "other" })
    ).toBe("acme/platform/widgets");
  });

  it("is null for a config that names no repo — such a binding matches nothing rather than everything", () => {
    expect(bindingRepoIdentity({})).toBeNull();
    expect(bindingRepoIdentity({ owner: "acme" })).toBeNull();
    expect(bindingRepoIdentity({ repo: "widgets" })).toBeNull();
    expect(bindingRepoIdentity(null)).toBeNull();
    expect(bindingRepoIdentity("acme/widgets")).toBeNull();
    expect(bindingRepoIdentity({ owner: "  ", repo: "widgets" })).toBeNull();
  });
});

describe("normalizeRepoIdentity", () => {
  it("case-folds and trims, because all three providers treat repo paths that way", () => {
    expect(normalizeRepoIdentity("  ACME/Widgets ")).toBe("acme/widgets");
    expect(normalizeRepoIdentity("/acme/widgets/")).toBe("acme/widgets");
  });

  it("NEGATIVE CONTROL — it does not collapse two different repos into one", () => {
    expect(normalizeRepoIdentity("acme/widgets")).not.toBe(normalizeRepoIdentity("acme/widgets-2"));
    // A prefix must never match: the comparison is on this whole string, so `acme/widgets` and
    // `acme/widgets-fork` stay distinct values.
    expect(normalizeRepoIdentity("acme/widgets-fork")).not.toBe("acme/widgets");
  });
});

describe("isGitProviderModule", () => {
  it("is exactly the three modules that carry a readFileAtRef hook", () => {
    expect([...GIT_PROVIDER_MODULES]).toEqual(["github", "gitea", "gitlab"]);
    for (const module of GIT_PROVIDER_MODULES) expect(isGitProviderModule(module)).toBe(true);
  });

  it("is false for an executor with no adapter hook — asking one would be refused by the subprocess", () => {
    for (const module of ["argocd", "terraform", "managed-iac", "fake-executor"]) {
      expect(isGitProviderModule(module)).toBe(false);
    }
  });
});
