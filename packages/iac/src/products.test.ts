import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Component, DeploymentTarget, Service, Stack } from "./construct.js";
import { Bucket, Cluster, Database, InstanceGroup, Queue } from "./infra.js";
import { InfrastructurePipeline } from "./pipeline.js";
import {
  camelIdentifier,
  collectProducts,
  productsModuleSource,
  renderProductsModule,
  type ProductEntry
} from "./products.js";

/**
 * D20's products module — "the infra pipeline's synth emits a typed products module alongside its
 * manifest... a product the infra pipeline never declared fails at compile time; the wire still
 * carries only the name/URN ref." This file covers the VALUE side (what gets collected, what text
 * comes out, determinism); `products.placeAt.typecheck.test.ts` covers the COMPILE-TIME half — the
 * actual guarantee a consuming repo relies on.
 */

function buildInfra(stackName: string): {
  stack: Stack;
  infra: InstanceType<typeof InfrastructurePipeline>;
} {
  const stack = new Stack(stackName);
  const svc = new Service(stack, "payments", { name: "Payments" });
  const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });
  const infra = new InfrastructurePipeline(api, {
    repo: "payments/payments-infra",
    waves: [["some-stage"]]
  });
  return { stack, infra };
}

describe("@scp/iac: collectProducts (D20/D19)", () => {
  it("finds every infra product owned under the pipeline scope, sorted by URN", () => {
    const { infra } = buildInfra("payments-infra");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    // Declared out of alphabetical order on purpose — collectProducts must sort, not echo order.
    new InstanceGroup(infra, "pay-prod-ig", { name: "pay-prod-ig", within });
    new Cluster(infra, "pay-blue", { name: "pay-blue", within });
    new Database(infra, "payments-db", { name: "payments-db", within });

    const entries = collectProducts(infra);
    expect(entries.map((e) => e.identifier)).toEqual(["payBlue", "payProdIg", "paymentsDb"]);
    expect(entries).toEqual([...entries].sort((a, b) => a.urn.localeCompare(b.urn)));
  });

  it("ignores a plain DeploymentTarget declared in the same subtree — it is not a PRODUCT", () => {
    const { infra, stack } = buildInfra("payments-infra-mixed");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    new Cluster(infra, "pay-blue", { name: "pay-blue", within });
    // A bare stage declared elsewhere in the stack — not scoped to `infra`, and even if it were,
    // it carries no `.kind`, so `isInfraProductConstruct` must reject it either way.
    new DeploymentTarget(stack, "commercial-amer-staging", { name: "commercial-amer-staging" });

    const entries = collectProducts(infra);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.identifier).toBe("payBlue");
  });

  it("every InfraKind maps to its documented `I<Kind>` interface name (D24) — parity, not assumed", () => {
    const { infra } = buildInfra("payments-infra-kinds");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    new Cluster(infra, "a-cluster", { name: "a-cluster", within });
    new InstanceGroup(infra, "an-ig", { name: "an-ig", within });
    new Database(infra, "a-db", { name: "a-db", within });
    new Bucket(infra, "a-bucket", { name: "a-bucket", within });
    new Queue(infra, "a-queue", { name: "a-queue", within });

    const byKind = new Map(collectProducts(infra).map((e) => [e.kind, e.interfaceName]));
    expect(byKind.get("cluster")).toBe("ICluster");
    expect(byKind.get("instanceGroup")).toBe("IInstanceGroup");
    expect(byKind.get("database")).toBe("IDatabase");
    expect(byKind.get("bucket")).toBe("IBucket");
    expect(byKind.get("queue")).toBe("IQueue");
    // Mutation-proved by hand during authoring (restored before commit): swapping
    // INFRA_KIND_INTERFACE_NAME's "database" row to "ICluster" in products.ts makes the
    // `byKind.get("database")` assertion above fail — confirming this parity is live, not vacuous.
  });

  it("throws when two products camelCase to the same identifier, naming both URNs", () => {
    // `camelIdentifier` and `deriveConstructUrn`'s `slugify` (`urn.ts`) both normalize on the same
    // separator/case rules, so in practice a camelCase collision IS a same-URN collision — this is
    // that case, constructed the way it actually happens (a copy-pasted `new Cluster(...)` call
    // whose id was never changed). The guard still fires on the identifier, not the URN equality,
    // which is what makes it apply even if that coupling ever loosens.
    const { infra } = buildInfra("payments-infra-collide");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    new Cluster(infra, "pay-blue", { name: "pay-blue", within });
    new Cluster(infra, "pay-blue", { name: "pay-blue (duplicate id)", within });

    expect(() => collectProducts(infra)).toThrow(/map to the identifier "payBlue"/);
  });

  it("an infra pipeline that owns no products collects an empty list", () => {
    const { infra } = buildInfra("payments-infra-empty");
    expect(collectProducts(infra)).toEqual([]);
  });
});

describe("@scp/iac: camelIdentifier", () => {
  it.each([
    ["pay-blue", "payBlue"],
    ["pay_blue", "payBlue"],
    ["Pay Blue", "payBlue"],
    ["payProdIg", "payprodig"], // no existing separators to split on — camelCase does not re-split
    ["already-camel-Case", "alreadyCamelCase"],
    ["---", "product"],
    ["", "product"]
  ])("%s -> %s", (input, expected) => {
    expect(camelIdentifier(input)).toBe(expected);
  });
});

describe("@scp/iac: renderProductsModule / productsModuleSource — content (D20/D24)", () => {
  it("emits an interface-typed const, one readonly field per product, importing only used interfaces", () => {
    const entries: ProductEntry[] = [
      {
        identifier: "payBlue",
        kind: "cluster",
        interfaceName: "ICluster",
        urn: "urn:scp:x:deployment-target:pay-blue"
      },
      {
        identifier: "paymentsDb",
        kind: "database",
        interfaceName: "IDatabase",
        urn: "urn:scp:x:deployment-target:payments-db"
      }
    ];
    const source = renderProductsModule(entries);

    expect(source).toContain('import type { ICluster, IDatabase } from "@scp/iac";');
    expect(source).toContain("readonly payBlue: ICluster;");
    expect(source).toContain("readonly paymentsDb: IDatabase;");
    expect(source).toContain(
      'payBlue: { urn: "urn:scp:x:deployment-target:pay-blue", typeId: "deployment-target", kind: "cluster" }'
    );
    expect(source).toContain(
      'paymentsDb: { urn: "urn:scp:x:deployment-target:payments-db", typeId: "deployment-target", kind: "database" }'
    );
    // The wire shape is exactly {urn, typeId, kind} — D20: "the wire still carries only the
    // name/URN reference". No extra field leaks into the generated value.
    expect(source).not.toContain("name:");
  });

  it("imports only the interfaces actually used, deduped and sorted", () => {
    const entries: ProductEntry[] = [
      {
        identifier: "a",
        kind: "cluster",
        interfaceName: "ICluster",
        urn: "urn:scp:x:deployment-target:a"
      },
      {
        identifier: "b",
        kind: "cluster",
        interfaceName: "ICluster",
        urn: "urn:scp:x:deployment-target:b"
      }
    ];
    const source = renderProductsModule(entries);
    expect(source).toContain('import type { ICluster } from "@scp/iac";');
    expect(source.match(/ICluster/g)?.length).toBe(3); // import + 2 `readonly` type positions
  });

  it("an empty product list emits a valid, harmless module rather than broken syntax", () => {
    const source = renderProductsModule([]);
    expect(source).toContain("export const products = {} as const;");
    expect(source).not.toContain("import type");
  });

  it("productsModuleSource(scope) is collectProducts + renderProductsModule composed", () => {
    const { infra } = buildInfra("payments-infra-compose");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    new Cluster(infra, "pay-blue", { name: "pay-blue", within });
    expect(productsModuleSource(infra)).toBe(renderProductsModule(collectProducts(infra)));
  });
});

describe("@scp/iac: products module determinism (fast-check) — the construct.determinism.test.ts pattern", () => {
  interface ProductSpec {
    id: string;
    kind: "cluster" | "instanceGroup" | "database" | "bucket" | "queue";
  }

  const productSpecArb: fc.Arbitrary<ProductSpec[]> = fc.uniqueArray(
    fc.record({
      id: fc
        .string({ minLength: 1, maxLength: 12 })
        .filter((s) => /[a-zA-Z0-9]/.test(s))
        .map((s) => s.replace(/[^a-zA-Z0-9]/g, "x")),
      kind: fc.constantFrom<ProductSpec["kind"]>(
        "cluster",
        "instanceGroup",
        "database",
        "bucket",
        "queue"
      )
    }),
    { selector: (s) => s.id, minLength: 0, maxLength: 6 }
  );

  const KIND_CTORS = {
    cluster: Cluster,
    instanceGroup: InstanceGroup,
    database: Database,
    bucket: Bucket,
    queue: Queue
  };

  function build(specs: ProductSpec[], order: number[]): ReturnType<typeof buildInfra>["infra"] {
    // SAME stack name every call — the property is about construction ORDER, not stack identity;
    // varying the stack name would also vary every product's derived URN (`urn.ts`'s
    // `deriveConstructUrn` is keyed by `(stackName, id)`), which would make the two trees compare
    // unequal for a reason that has nothing to do with the property being tested.
    const { infra } = buildInfra("fc-products-determinism");
    const within = DeploymentTarget.fromName("commercial-amer-production");
    for (const i of order) {
      const s = specs[i];
      if (!s) continue;
      const Ctor = KIND_CTORS[s.kind];
      new Ctor(infra, s.id, { name: s.id, within });
    }
    return infra;
  }

  /**
   * Runs `productsModuleSource` and returns EITHER its output or its refusal message.
   *
   * A REFUSAL IS PART OF THE PROPERTY, not an escape from it. The generator can produce ids that
   * differ only in case (`"F"` and `"f"`), which is a legitimate authoring mistake the library is
   * REQUIRED to refuse — and it did, which is how the underlying `Stack.synth()` duplicate-URN
   * defect was found (this property failed in CI on seed 1953244992 and passed locally, because
   * fast-check reseeds every run). Filtering those inputs out of the generator would have hidden a
   * real bug: two constructs whose ids differ only in case derive ONE URN, and the server diffs by
   * URN, so one of the two declared objects silently never existed. See
   * `construct.test.ts`'s "two objects may not claim one URN".
   *
   * So determinism is asserted over the whole behaviour: the same tree gives the same ANSWER twice,
   * and a refusal is reproducible byte-for-byte exactly like an output.
   */
  function sourceOrRefusal(infra: ReturnType<typeof build>): string {
    try {
      return productsModuleSource(infra);
    } catch (error) {
      return `REFUSED: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  it("re-rendering the same tree twice is byte-identical — including when it refuses", () => {
    fc.assert(
      fc.property(productSpecArb, (specs) => {
        const order = specs.map((_, i) => i);
        const infra = build(specs, order);
        expect(sourceOrRefusal(infra)).toBe(sourceOrRefusal(infra));
      }),
      { numRuns: 30 }
    );
  });

  it("two independently-built-but-equivalent trees converge to byte-identical output regardless of construction order", () => {
    fc.assert(
      fc.property(productSpecArb, (specs) => {
        const order = specs.map((_, i) => i);
        const reversed = [...order].reverse();
        const infraA = build(specs, order);
        const infraB = build(specs, reversed);
        // Both were seeded with the SAME set of (id, kind) pairs, just constructed in different
        // order — the stack NAME differs (random, for isolation), so compare the RENDERED MODULE,
        // which never mentions the stack name (D20: the module is keyed by construct id only).
        // …and the refusal is order-independent too, which is the sharper half: a collision must
        // not depend on which of the two colliding constructs was declared first.
        expect(sourceOrRefusal(infraA)).toBe(sourceOrRefusal(infraB));
      }),
      { numRuns: 30 }
    );
  });
});
