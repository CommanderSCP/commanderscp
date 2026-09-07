import type {
  ComponentDependencyBump,
  ComponentDependencyInventoryResponse,
  ComponentDependencyInventoryRow,
  DependencyLineProducerVerbResponse,
  DependencyLineProducerView,
  DependencyProducerLineImpact,
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

// ---- Producer declarations (dependency-subscription-ui.md §12) --------------------------------

export const DECLARER = {
  id: "019f0000-0000-7000-8000-00000000ad31",
  name: "admin"
};

/** One row of `GET /dependencies/producers` — the WIRE VIEW (names enriched server-side, §12.6 Q1). */
export function producerFixture(
  over: Partial<DependencyLineProducerView> = {}
): DependencyLineProducerView {
  return {
    orgId: "019f0000-0000-7000-8000-00000000009f",
    ecosystem: "npm",
    coordinate: "@acme/lib",
    producerObjectId: COMPONENT.id,
    declaredAt: "2026-08-15T00:00:00.000Z",
    declaredByObjectId: DECLARER.id,
    producer: { objectId: COMPONENT.id, name: COMPONENT.name },
    declaredBy: { objectId: DECLARER.id, name: DECLARER.name },
    ...over
  };
}

export function lineImpactFixture(
  over: Partial<DependencyProducerLineImpact> = {}
): DependencyProducerLineImpact {
  return {
    lineId: "019f0000-0000-7000-8000-00000000aaa1",
    major: "1",
    tagPattern: null,
    headBefore: {
      latestVersion: "1.4.2",
      latestDigest: null,
      latestObservedAt: "2026-08-14T00:00:00.000Z"
    },
    headCleared: true,
    subscribedComponentObjectIds: ["019f0000-0000-7000-8000-00000000c0d1"],
    subscribedComponents: [
      { objectId: "019f0000-0000-7000-8000-00000000c0d1", name: "ledger-api" }
    ],
    ...over
  };
}

/** A declare / retract verb response. `dryRun` responses carry `decisionId: null` and
 *  `declaration: null`, as the server does. */
export function verbResponseFixture(
  over: Partial<DependencyLineProducerVerbResponse> = {}
): DependencyLineProducerVerbResponse {
  return {
    ecosystem: "npm",
    coordinate: "@acme/lib",
    action: "declare",
    dryRun: false,
    declaration: producerFixture(),
    lines: [lineImpactFixture()],
    openBumpAuthorships: [],
    decisionId: "019f0000-0000-7000-8000-00000000d3c1",
    dependencyManagement: { managedHere: true, reason: "commander" },
    ...over
  };
}
