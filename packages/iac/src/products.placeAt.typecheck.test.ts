import { describe, expect, it } from "vitest";
import { Component, DeploymentTarget, Service, Stack } from "./construct.js";
import type { ICluster, IDatabase, IInstanceGroup } from "./infra.js";
import { ImagePipeline, RpmPipeline } from "./pipeline.js";

/**
 * D20's whole point, proved the way this repo already proves a `placeAt` compile-time guard
 * (`pipeline.placeAt.typecheck.test.ts`'s own doc explains the pattern in full): `// @ts-expect-
 * error` lines that fail the BUILD — `tsc --noEmit`, this package's `typecheck` script,
 * `tsconfig.json`'s `include: ["src"]` sweeps this file in — the moment the error they name stops
 * occurring. The runtime `it()` block exists only so this stays a normal green vitest module too.
 *
 * WHY A HAND-WRITTEN `products` CONST HERE, NOT A GENERATED ONE. TypeScript typechecks this
 * FILE'S source; it cannot typecheck a string `productsModuleSource(...)` returns at runtime in the
 * same pass (that string only becomes real, checkable TypeScript once it lands in a consuming
 * repo's own `.ts` file — D20/D10's whole publish step). So the object below is written by hand to
 * be BYTE-FOR-BYTE THE SAME SHAPE `renderProductsModule` emits — an explicit type annotation naming
 * each field's `I<Kind>` interface, values carrying exactly `{urn, typeId, kind}` — and
 * `products.test.ts`'s content-assertion tests are what pin that `renderProductsModule` really does
 * emit this shape. Together the two files close the loop: "the generator emits X" (products.test.ts)
 * and "X makes a wrong `placeAt` a compile error" (this file) — neither on its own proves the whole
 * chain, but both together do.
 *
 * MUTATION-PROVED (restored before commit): commenting out any ONE `@ts-expect-error` line below and
 * running `pnpm --filter @scp/iac typecheck` makes tsc report "Unused '@ts-expect-error' directive"
 * for that line — RED — confirming it is load-bearing. Also proved the OTHER direction the way D20
 * actually breaks in practice: temporarily typing `paymentsDb` below as `ICluster` instead of
 * `IDatabase` (simulating a broken `INFRA_KIND_INTERFACE_NAME` row in `products.ts`) makes
 * `image.placeAt(products.paymentsDb)` STOP being a type error — the `@ts-expect-error` above it
 * then reports "Unused directive", RED — which is exactly the failure this test exists to catch.
 * Both mutations were reverted before commit.
 */
describe("@scp/iac: a D20 products module's interface typing makes a wrong placeAt a compile error", () => {
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

// -- illegal pairings — each MUST fail to type-check, or `pnpm --filter @scp/iac typecheck` fails --
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
