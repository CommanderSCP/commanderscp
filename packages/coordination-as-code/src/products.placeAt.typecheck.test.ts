import { describe, expect, it } from "vitest";
import { Component, DeploymentTarget, Service, Stack } from "./construct.js";
import type { ICluster, IDatabase, IInstanceGroup } from "./infra.js";
import { ImagePipeline, RpmPipeline } from "./pipeline.js";

/** The whole point, proved as a compile-time guarantee. See docs/coordination-as-code.md §295. */
describe("@scp/coordination-as-code: a D20 products module's interface typing makes a wrong placeAt a compile error", () => {
  it("the legal pairing type-checks and runs at runtime", () => {
    const stack = new Stack("products-typecheck");
    const svc = new Service(stack, "svc", { name: "svc" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const image = new ImagePipeline(api, { repo: "x/y", waves: [] });

    // Exactly the shape `renderProductsModule` emits for a `payBlue: ICluster` entry (products.ts /
    // products.test.ts) — a consuming repo's generated `import { products } from "@corp/payments-
    // infra"` resolves to this same explicitly-annotated shape.
    const products: { readonly payBlue: ICluster } = {
      payBlue: {
        urn: "urn:scp:payments-infra:deployment-target:pay-blue",
        typeId: "deployment-target",
        kind: "cluster"
      }
    };

    expect(image.placeAt(products.payBlue)).toBe(image);
  });
});

// -- illegal pairings — each MUST fail to type-check, or `pnpm --filter @scp/coordination-as-code typecheck` fails --
const stack2 = new Stack("products-typecheck-illegal");
const svc2 = new Service(stack2, "svc", { name: "svc" });
const api2 = new Component(stack2, "api", { name: "api", service: svc2 });
const withinTarget2 = new DeploymentTarget(stack2, "target", { name: "target" });
void withinTarget2;

const image2 = new ImagePipeline(api2, "image2", { repo: "x/y", waves: [] });
const rpm2 = new RpmPipeline(api2, "rpm2", { repo: "x/y", waves: [] });

// The exact shape a generated products module emits for a Cluster / InstanceGroup / Database mix
// (products.ts's `renderProductsModule`, pinned by products.test.ts's content assertions).
const products2: {
  readonly payBlue: ICluster;
  readonly payProdIg: IInstanceGroup;
  readonly paymentsDb: IDatabase;
} = {
  payBlue: {
    urn: "urn:scp:payments-infra:deployment-target:pay-blue",
    typeId: "deployment-target",
    kind: "cluster"
  },
  payProdIg: {
    urn: "urn:scp:payments-infra:deployment-target:pay-prod-ig",
    typeId: "deployment-target",
    kind: "instanceGroup"
  },
  paymentsDb: {
    urn: "urn:scp:payments-infra:deployment-target:payments-db",
    typeId: "deployment-target",
    kind: "database"
  }
};

// @ts-expect-error — a Database is never a deploy target for any artifact (D24) — image.placeAt only accepts ICluster
image2.placeAt(products2.paymentsDb);
// @ts-expect-error — an image cannot be placed on an instance group: ImagePipeline.placeAt takes ICluster only (D24)
image2.placeAt(products2.payProdIg);
// @ts-expect-error — an RPM cannot be placed on a cluster: RpmPipeline.placeAt takes IInstanceGroup only (D24)
rpm2.placeAt(products2.payBlue);
// @ts-expect-error — a product this program never imported has no property to reference at all
const undeclaredProduct = products2.noSuchProduct;
void undeclaredProduct;
