import { describe, expect, it } from "vitest";
import { claimValuesFrom, externalIdentityOf } from "./identity-sync.js";

/**
 * The two PURE halves of IdP group sync. The reconciliation itself needs a database and lives in
 * `identity-sync.integration.test.ts`; these are the parts a unit test can pin, and one of them is
 * the most safety-critical line in the feature.
 */
describe("claimValuesFrom", () => {
  it("reads a multi-valued claim", () => {
    expect(claimValuesFrom({ roles: ["SCP.OrgAdmin", "SCP.Viewer"] }, "roles")).toEqual([
      "SCP.OrgAdmin",
      "SCP.Viewer"
    ]);
  });

  it("reads a SINGLE-valued claim, which providers send as a bare string", () => {
    // Entra sends one app role as a string, not a one-element array. Treating that as "no claim"
    // would silently strip the authority of every user with exactly one role assigned — the most
    // common case in a small deployment.
    expect(claimValuesFrom({ roles: "SCP.OrgAdmin" }, "roles")).toEqual(["SCP.OrgAdmin"]);
  });

  it("an absent claim is an empty set, not an error", () => {
    // A user with no app roles assigned is legitimate: they sign in and get the Viewer floor.
    expect(claimValuesFrom({ sub: "abc" }, "roles")).toEqual([]);
  });

  it("ignores non-string members rather than crashing on a malformed claim", () => {
    expect(claimValuesFrom({ roles: ["ok", 42, null, "", "fine"] }, "roles")).toEqual([
      "ok",
      "fine"
    ]);
  });

  it("REFUSES an overage token — the line that stops a silent privilege strip", () => {
    // Entra omits the claim past ~200 groups and substitutes these pointers at MS Graph. Resolving
    // them needs an outbound call the air-gap principle forbids, so SCP cannot see the groups at
    // all. Treating that as "no groups" would sign the user in AND make the reconciliation revoke
    // the memberships they legitimately had, presenting as permissions that used to work.
    let thrown: unknown;
    try {
      claimValuesFrom(
        {
          _claim_names: { groups: "src1" },
          _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/..." } }
        },
        "groups"
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    // Asserted on `detail`, NOT on `.message` — every refusal here is a `ProblemError` whose
    // message is the bare RFC 9457 title ("Unauthorized") and whose explanation lives in `detail`.
    // A `toThrow(/regex/)` matches the message and would have passed on ANY unauthorized error,
    // including one thrown for a completely different reason.
    const detail = (thrown as { detail?: string }).detail ?? "";
    expect(detail).toMatch(/_claim_names/);
    // Names the remedy, because the operator reading it is the one who can apply it.
    expect(detail).toMatch(/SCP_OIDC_ROLE_CLAIM/);
  });

  it("an overage pointer for a DIFFERENT claim does not block the configured one", () => {
    // Overage is per-claim. A `groups` overage must not refuse a login that reads `roles`, which is
    // precisely the configuration this feature recommends to avoid overage in the first place.
    expect(
      claimValuesFrom({ _claim_names: { groups: "src1" }, roles: ["SCP.OrgAdmin"] }, "roles")
    ).toEqual(["SCP.OrgAdmin"]);
  });
});

describe("externalIdentityOf", () => {
  it("reads a well-formed mapping", () => {
    expect(externalIdentityOf({ externalIdentity: { claimValue: "SCP.OrgAdmin" } })).toEqual({
      claimValue: "SCP.OrgAdmin"
    });
  });

  it("returns null for every malformed shape — an unmapped group must never look mapped", () => {
    // The reconciliation's DELETE arm is scoped to mapped groups. A false positive here would put
    // an ordinary hand-managed team under the directory's control and empty it at the next login.
    for (const properties of [
      undefined,
      null,
      {},
      { externalIdentity: null },
      { externalIdentity: "SCP.OrgAdmin" },
      { externalIdentity: {} },
      { externalIdentity: { claimValue: "" } },
      { externalIdentity: { claimValue: 42 } }
    ]) {
      expect(externalIdentityOf(properties), JSON.stringify(properties)).toBeNull();
    }
  });
});
