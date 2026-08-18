import type {
  ComponentDependencyBump,
  ComponentDependencyInventoryResponse,
  ComponentDependencyInventoryRow,
  DependencySubscriptionContribution,
  DependencySubscriptionUnlock
} from "@scp/schemas";

/** Shared fixtures for the Dependencies tab tests — wire-shaped, every field the schema requires. */

export const COMPONENT = {
  id: "019f0000-0000-7000-8000-00000000c0de",
  name: "checkout-api",
  domainId: "019f0000-0000-7000-8000-0000000d0000"
};

export const UNLOCK_CONTRIBUTION: DependencySubscriptionContribution = {
  tier: "instance",
  source: "instance:dependency_subscription_unlock",
  contributed: "unlock"
};

export const ENABLE_CONTRIBUTION: DependencySubscriptionContribution = {
  tier: "component",
  source: `policy:dependency subscription: checkout-api@${COMPONENT.id}`,
  objectTypeId: "component",
  contributed: "enable",
  selector: {},
  granularity: "minor_and_patch",
  delivery: "pull_request"
};

export function unlockFixture(
  over: Partial<DependencySubscriptionUnlock> = {}
): DependencySubscriptionUnlock {
  return {
    unlocked: true,
    note: null,
    updatedAt: "2026-08-10T12:00:00.000Z",
    source: "instance:dependency_subscription_unlock",
    ...over
  };
}

export function rowFixture(
  over: Partial<ComponentDependencyInventoryRow> = {}
): ComponentDependencyInventoryRow {
  return {
    line: {
      id: "019f0000-0000-7000-8000-00000000aaa1",
      ecosystem: "npm",
      coordinate: "@acme/lib",
      major: "1",
      tagPattern: null
    },
    manifestPath: "package.json",
    declaredVersion: "^1.2.3",
    resolvedVersion: "1.2.3",
    resolvedDigest: null,
    observedRepo: "acme/checkout",
    observedRef: "refs/heads/main",
    observedAt: "2026-08-15T00:00:00.000Z",
    head: { latestVersion: null, latestDigest: null, latestObservedAt: null },
    producer: null,
    subscription: {
      enabled: true,
      reason: "enabled",
      granularity: "minor_and_patch",
      delivery: "pull_request",
      contributions: [UNLOCK_CONTRIBUTION, ENABLE_CONTRIBUTION]
    },
    ...over
  };
}

export function inventoryFixture(
  over: Partial<ComponentDependencyInventoryResponse> = {}
): ComponentDependencyInventoryResponse {
  return {
    component: COMPONENT,
    dependencyManagement: { managedHere: true, reason: "commander" },
    ingestion: null,
    lastIngestionDecision: null,
    componentGate: {
      enabled: true,
      reason: "enabled",
      contributions: [UNLOCK_CONTRIBUTION, ENABLE_CONTRIBUTION]
    },
    rows: [],
    nextCursor: null,
    ...over
  };
}

export function bumpFixture(over: Partial<ComponentDependencyBump> = {}): ComponentDependencyBump {
  return {
    changeId: "019f0000-0000-7000-8000-00000000c4a1",
    changeName: "bump @acme/lib 1.2.3 → 1.2.4",
    line: {
      id: "019f0000-0000-7000-8000-00000000aaa1",
      ecosystem: "npm",
      coordinate: "@acme/lib",
      major: "1"
    },
    manifestPath: "package.json",
    fromVersion: "1.2.3",
    toVersion: "1.2.4",
    repo: "acme/checkout",
    baseBranch: "main",
    authoredRef: "refs/heads/scp/dep-bump/019f0000-0000-7000-8000-00000000c4a1",
    pullRequestNumber: 42,
    pullRequestUrl: null,
    headCommit: null,
    dispatchedAt: "2026-08-15T01:00:00.000Z",
    mergedAt: null,
    delivery: "pull_request",
    deliveryReason: "first look is always a pull request",
    merge: null,
    ...over
  };
}
