import { describe, expect, it } from "vitest";
import type { ExecutorEvent } from "@scp/plugin-api";
import { observedEventIdentity } from "./observe.js";

/**
 * The observe dedupe identity.
 *
 * THE BUG THIS PINS. The identity was `correlationKey ?? commitSha ?? artifactDigest ?? …`, which
 * reads as a sensible fallback chain and is not one: `correlationKey` is a GROUPING key, deliberately
 * STABLE across events for several providers, and because it was checked first the discriminating
 * fields were never reached. Every event sharing a group collapsed onto one dedupe key, so exactly
 * ONE row per (instance, group) was ever ingested — permanently, not per poll window.
 *
 * Measured on the homelab: 4 push events ingested in total against 402 workflow runs (which escaped
 * only because `run-${id}` is incidentally unique), and 62 argocd events for 61 bound applications
 * with the newest a week stale.
 *
 * These cases are written per PROVIDER SHAPE rather than per plugin, because the defect was a
 * property of the identity function and not of any one adapter — three plugins emit the constant
 * `"refs/heads/*"`, and argocd emits a constant app name.
 */
describe("observedEventIdentity: the grouping key alone is not an identity", () => {
  const ev = (correlation: ExecutorEvent["correlation"], over: Partial<ExecutorEvent> = {}) =>
    ({
      kind: "push",
      occurredAt: "2026-08-02T00:00:00Z",
      correlation,
      raw: {},
      ...over
    }) as ExecutorEvent;

  it("two commits under the CONSTANT push grouping key get different identities", () => {
    // `pollCommits` in github, gitea AND gitlab all set the literal "refs/heads/*". Before the fix
    // both of these produced `refs/heads/*`, so the second commit was rejected as a duplicate of the
    // first — which is why the homelab ingested 4 push events across its entire history.
    const first = observedEventIdentity(
      ev({ repo: "acme/app", correlationKey: "refs/heads/*", commitSha: "a".repeat(40) })
    );
    const second = observedEventIdentity(
      ev({ repo: "acme/app", correlationKey: "refs/heads/*", commitSha: "b".repeat(40) })
    );

    expect(first).not.toBe(second);
  });

  it("two argocd reconciles at the SAME revision collapse onto one identity", () => {
    // The firehose control. Argo CD advances `reconciledAt` every ~3 minutes per app whether or not
    // anything changed, so keying on the timestamp made every idle reconcile a new row — ~26k rows
    // and ~150 MB a day on a 61-app instance. With the app's synced revision as the discriminator,
    // an unchanged app produces ONE row no matter how often it reconciles.
    const first = observedEventIdentity(
      ev(
        { correlationKey: "agentkit-keycloak", commitSha: "ff3fd8a3" },
        { kind: "sync", occurredAt: "2026-08-02T11:32:05Z" }
      )
    );
    const second = observedEventIdentity(
      ev(
        { correlationKey: "agentkit-keycloak", commitSha: "ff3fd8a3" },
        { kind: "sync", occurredAt: "2026-08-02T11:35:11Z" }
      )
    );

    expect(first).toBe(second);
  });

  it("an argocd redeploy to a NEW revision is still a distinct event", () => {
    // The other half — collapsing must not swallow a real deployment.
    const before = observedEventIdentity(
      ev({ correlationKey: "agentkit-keycloak", commitSha: "ff3fd8a3" }, { kind: "sync" })
    );
    const after = observedEventIdentity(
      ev({ correlationKey: "agentkit-keycloak", commitSha: "a1b2c3d4" }, { kind: "sync" })
    );

    expect(before).not.toBe(after);
  });

  it("two argocd syncs of an app with NO revision still separate by timestamp", () => {
    // An app that has never synced reports no revision, so the identity falls back to the provider
    // timestamp — the pre-existing behaviour, kept as the honest degradation.
    const first = observedEventIdentity(
      ev(
        { correlationKey: "agentkit-keycloak" },
        { kind: "sync", occurredAt: "2026-08-01T10:00:00Z" }
      )
    );
    const second = observedEventIdentity(
      ev(
        { correlationKey: "agentkit-keycloak" },
        { kind: "sync", occurredAt: "2026-08-02T10:00:00Z" }
      )
    );

    expect(first).not.toBe(second);
  });

  it("re-polling the SAME event yields the SAME identity — dedupe still works", () => {
    // The other half of the contract, and the reason the discriminator is the PROVIDER's timestamp
    // rather than `now()`: an unchanged event re-observed on the next tick must still collapse, or
    // every poll would propose a duplicate change.
    const correlation = { correlationKey: "agentkit-keycloak" };
    expect(
      observedEventIdentity(ev(correlation, { kind: "sync", occurredAt: "2026-08-01T10:00:00Z" }))
    ).toBe(
      observedEventIdentity(ev(correlation, { kind: "sync", occurredAt: "2026-08-01T10:00:00Z" }))
    );

    const push = { repo: "acme/app", correlationKey: "refs/heads/*", commitSha: "c".repeat(40) };
    expect(observedEventIdentity(ev(push))).toBe(observedEventIdentity(ev(push)));
  });

  it("two workflow runs on the SAME commit stay distinct", () => {
    // The regression this fix must not cause. `run-${id}` is unique but `commitSha` is not — two
    // runs of one commit share it — so an identity built from the commit ALONE would collapse them.
    // Keeping the grouping key in the identity is what prevents that.
    const first = observedEventIdentity(
      ev({ repo: "acme/app", correlationKey: "run-1", commitSha: "d".repeat(40) })
    );
    const second = observedEventIdentity(
      ev({ repo: "acme/app", correlationKey: "run-2", commitSha: "d".repeat(40) })
    );

    expect(first).not.toBe(second);
  });

  it("two different apps do not collide just because they reconciled at the same instant", () => {
    // The grouping key must stay IN the identity: a fleet-wide argocd reconcile gives many apps the
    // same timestamp, and keying on the timestamp alone would ingest exactly one of them.
    const a = observedEventIdentity(ev({ correlationKey: "app-a" }, { kind: "sync" }));
    const b = observedEventIdentity(ev({ correlationKey: "app-b" }, { kind: "sync" }));

    expect(a).not.toBe(b);
  });

  it("an artifact digest discriminates within a repository grouping key", () => {
    // harbor/gitea package pushes carry a digest instead of a commit sha.
    const first = observedEventIdentity(
      ev({ repo: "acme/img", correlationKey: "acme/img", artifactDigest: "sha256:aaa" })
    );
    const second = observedEventIdentity(
      ev({ repo: "acme/img", correlationKey: "acme/img", artifactDigest: "sha256:bbb" })
    );

    expect(first).not.toBe(second);
  });
});
