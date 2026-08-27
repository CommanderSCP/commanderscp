import { describe, expect, it } from "vitest";
import { ARTIFACT_INFRA_COMPATIBILITY, type ExecutorType, type InfraKind } from "@scp/schemas";
import { DesiredStateManifestSchema } from "@scp/schemas";
import { Bucket, Cluster, Database, InstanceGroup, PLACEMENT_MATRIX, Queue } from "./infra.js";
import { ConfigurationPipeline, InfrastructurePipeline } from "./pipeline.js";
import { DeploymentTarget, Service, Stack } from "./construct.js";

/**
 * D24's compile-rung derivation has two layers (see `infra.ts`'s module doc for the full reasoning):
 * a TYPE-level `PLACEMENT_MATRIX` (checked by the compile-fail cases in
 * `pipeline.placeAt.typecheck.test.ts`) and this VALUE-level parity check, which is what actually
 * proves the two matrices cannot drift — `@scp/schemas`'s own export is the authority, and this test
 * is deliberately the kind of guard that goes RED the instant `infra.ts`'s copy disagrees with it.
 */
describe("@scp/iac: PLACEMENT_MATRIX parity with @scp/schemas's ARTIFACT_INFRA_COMPATIBILITY", () => {
  it("is byte-for-byte the same rows, for every ExecutorType", () => {
    const schemaEntries = Object.entries(ARTIFACT_INFRA_COMPATIBILITY) as [
      ExecutorType,
      readonly InfraKind[]
    ][];
    for (const [type, kinds] of schemaEntries) {
      expect(PLACEMENT_MATRIX[type]).toEqual(kinds);
    }
    // And the reverse direction — infra.ts declares no row @scp/schemas does not also have.
    expect(Object.keys(PLACEMENT_MATRIX).sort()).toEqual(
      Object.keys(ARTIFACT_INFRA_COMPATIBILITY).sort()
    );
  });

  // Mutation-proved by hand during authoring (restored before commit): editing one row of
  // PLACEMENT_MATRIX in infra.ts (e.g. adding "instanceGroup" to "image") makes this test fail —
  // confirming the parity check is live, not vacuous.
});

describe("@scp/iac: infra product constructs are `deployment-target` objects (D19/D24)", () => {
  it("Cluster/InstanceGroup/Database/Bucket/Queue synth with typeId `deployment-target`, kind + within recorded as properties", () => {
    const stack = new Stack("payments-infra");
    const payments = new Service(stack, "payments", { name: "Payments" });
    const prodAmer = new DeploymentTarget(stack, "commercial-amer-production", {
      name: "commercial-amer-production",
      properties: { environment: "production", region: "amer" }
    });
    const infra = new InfrastructurePipeline(payments, {
      repo: "payments/payments-infra",
      waves: [[prodAmer]]
    });

    const payBlue = new Cluster(infra, "pay-blue", { name: "pay-blue", within: prodAmer });
    const payIg = new InstanceGroup(infra, "pay-ig", { name: "pay-ig", within: prodAmer });
    const paymentsDb = new Database(infra, "payments-db", {
      name: "payments-db",
      within: prodAmer
    });
    const paymentsBucket = new Bucket(infra, "payments-bucket", {
      name: "payments-bucket",
      within: prodAmer
    });
    const paymentsQueue = new Queue(infra, "payments-queue", {
      name: "payments-queue",
      within: prodAmer
    });

    const manifest = stack.synth();
    // EVERY infra product below is `typeId: "deployment-target"` — D19/D24's premise correction:
    // a `Cluster` etc. is a SUBTYPE of `deployment-target` (GLOSSARY), not a parallel manifest type.
    // Distinguished from `prodAmer` (the broader stage, also a `deployment-target`) only by name/urn
    // and by carrying `properties.kind`.
    const infraObjects = manifest.objects.filter(
      (o) => o.typeId === "deployment-target" && o.urn !== prodAmer.urn
    );
    // `Stack.synth()` sorts objects by URN (round A's determinism rule); every infra product's URN
    // segment is now uniformly `deployment-target`, so order here is purely by construct id.
    // Sorted by full URN string (round A's determinism rule) — asserted via a sort-by-urn on the
    // EXPECTED side too, so this test documents the rule instead of a hand-computed guess at it.
    const expected = [
      {
        urn: payBlue.urn,
        typeId: "deployment-target",
        name: "pay-blue",
        properties: { kind: "cluster", within: prodAmer.urn },
        labels: {}
      },
      {
        urn: payIg.urn,
        typeId: "deployment-target",
        name: "pay-ig",
        properties: { kind: "instanceGroup", within: prodAmer.urn },
        labels: {}
      },
      {
        urn: paymentsBucket.urn,
        typeId: "deployment-target",
        name: "payments-bucket",
        properties: { kind: "bucket", within: prodAmer.urn },
        labels: {}
      },
      {
        urn: paymentsDb.urn,
        typeId: "deployment-target",
        name: "payments-db",
        properties: { kind: "database", within: prodAmer.urn },
        labels: {}
      },
      {
        urn: paymentsQueue.urn,
        typeId: "deployment-target",
        name: "payments-queue",
        properties: { kind: "queue", within: prodAmer.urn },
        labels: {}
      }
    ].sort((a, b) => a.urn.localeCompare(b.urn));
    expect(infraObjects).toEqual(expected);
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("Cluster.fromName()/.fromUrn() are reference-only, in the SAME namespace a plain DeploymentTarget reference uses (it IS one) — never create a manifest object", () => {
    const ref = Cluster.fromName("pay-blue");
    expect(ref).toEqual({
      urn: "urn:scp:named-ref:deployment-target:pay-blue",
      typeId: "deployment-target",
      kind: "cluster"
    });
    const urnRef = Cluster.fromUrn("urn:scp:other-infra:deployment-target:pay-blue");
    expect(urnRef).toEqual({
      urn: "urn:scp:other-infra:deployment-target:pay-blue",
      typeId: "deployment-target",
      kind: "cluster"
    });
  });

  it("a ConfigurationPipeline may also parent infra products (D19's 'or Configuration pipeline')", () => {
    const stack = new Stack("fleet");
    const payments = new Service(stack, "payments", { name: "Payments" });
    const prodAmer = new DeploymentTarget(stack, "commercial-amer-production", {
      name: "commercial-amer-production"
    });
    const config = new ConfigurationPipeline(payments, {
      repo: "payments/payments-fleet",
      waves: [[prodAmer]]
    });
    const ig = new InstanceGroup(config, "pay-prod-ig", { name: "pay-prod-ig", within: prodAmer });
    const manifest = stack.synth();
    const igObject = manifest.objects.find((o) => o.urn === ig.urn);
    expect(igObject?.typeId).toBe("deployment-target");
    expect(igObject?.properties).toMatchObject({ kind: "instanceGroup" });
  });
});
