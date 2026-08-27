import type { InfraKind } from "@scp/schemas";
import { isInfraProductConstruct, type InfraProductScope } from "./infra.js";

/**
 * D20's products module — "the infra pipeline's synth emits a typed products module alongside its
 * manifest ... a product the infra pipeline never declared fails at COMPILE TIME". PURE, exactly
 * like `Stack.synth()` (no I/O in here) — this file only computes what the module's TEXT should be;
 * writing it to disk lives beside `synthToFile` in `index.ts`, the same layering split the manifest
 * side already makes.
 *
 * INTERFACE-TYPED PER D24: the emitted `products` const carries an EXPLICIT type annotation
 * (`readonly payBlue: ICluster`), not an inferred literal object type — that is what makes
 * `products.payBlue: ICluster` the thing an IDE shows at the use site, and it is the property that
 * turns `rpm.placeAt(products.payBlue)` into a compile error in the CONSUMING repo: `PlaceableTarget
 * <"rpm">` is `IInstanceGroup` only (`infra.ts`), and `ICluster`/`IInstanceGroup` are structurally
 * distinct on their `kind` literal (`infra.ts`'s `IInfraProductRef<Kind>`). `products.placeAt.
 * typecheck.test.ts` proves that mechanism the same way `pipeline.placeAt.typecheck.test.ts` proves
 * D24's compile rung: `@ts-expect-error` lines swept by `tsc --noEmit`.
 *
 * THE WIRE STILL CARRIES ONLY THE NAME/URN REFERENCE (D20): the generated module's values are
 * exactly the `{urn, typeId, kind}` shape `Cluster.fromUrn(...)` would hand back — this file adds no
 * new manifest shape, it is authoring sugar over the SAME synthesized `deployment-target` objects
 * `infra.ts` already emits.
 */

const INFRA_KIND_INTERFACE_NAME = {
  cluster: "ICluster",
  instanceGroup: "IInstanceGroup",
  database: "IDatabase",
  bucket: "IBucket",
  queue: "IQueue"
} as const satisfies Record<InfraKind, string>;

/** One entry of a products module — one owned infra product, resolved to what the generated source
 *  needs to print it: a valid JS property name, its interface type name, and its real (not
 *  placeholder) URN + kind. */
export interface ProductEntry {
  /** camelCase JS property name derived from the construct's own id (`pay-blue` -> `payBlue`). */
  readonly identifier: string;
  readonly kind: InfraKind;
  /** The `I<Kind>` interface name this entry's value is typed as (D24). */
  readonly interfaceName: string;
  readonly urn: string;
}

/**
 * camelCase JS identifier from any construct id/slug — `pay-blue` -> `payBlue`, `pay_blue` ->
 * `payBlue`, `Pay Blue` -> `payBlue`. Every run of non-alphanumeric characters is a word boundary,
 * matching how `slugify` (`urn.ts`) already treats separators, so an id built by hand and one built
 * by `slugify` camelCase to the same identifier.
 */
export function camelIdentifier(input: string): string {
  const parts = input
    .trim()
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return "product";
  return parts
    .map((part, i) => {
      const lower = part.toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/**
 * Every infra product owned anywhere under `scope` (D19: "declared by — scoped to — the
 * Infrastructure/Configuration pipeline that manages it"), as `ProductEntry`s — SORTED BY URN (the
 * same determinism convention `Stack.synth()` uses for `objects`/`relationships`), so declaration
 * order in the authoring program never changes the generated module's bytes, only content does.
 *
 * Throws if two products under `scope` camelCase to the SAME identifier (e.g. `pay-blue` and
 * `pay_blue` are two different construct ids that collide once slugified into JS) — a generated
 * module with a duplicate key would silently drop one product rather than fail loudly, and this is
 * the one place that can still be caught before the module ships.
 */
export function collectProducts(scope: InfraProductScope): ProductEntry[] {
  const owned = scope.stack._resourcesWithin(scope).filter(isInfraProductConstruct);
  const sorted = [...owned].sort((a, b) => a.urn.localeCompare(b.urn));

  const entries: ProductEntry[] = [];
  const byIdentifier = new Map<string, ProductEntry>();
  for (const resource of sorted) {
    const identifier = camelIdentifier(resource.id);
    const existing = byIdentifier.get(identifier);
    if (existing) {
      throw new Error(
        `Products module for "${scope.path}": both "${existing.urn}" and "${resource.urn}" map to ` +
          `the identifier "${identifier}" — rename one of the two construct ids so the generated ` +
          `module does not silently drop one of them.`
      );
    }
    const entry: ProductEntry = {
      identifier,
      kind: resource.kind,
      interfaceName: INFRA_KIND_INTERFACE_NAME[resource.kind],
      urn: resource.urn
    };
    byIdentifier.set(identifier, entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * Renders `entries` as the module's TypeScript SOURCE TEXT — pure string building, deterministic
 * given a deterministic `entries` (which `collectProducts` already guarantees by sorting on URN).
 * Exported separately from `productsModuleSource` so a test (or a caller with its own product list,
 * e.g. the D20 aggregated `targets.*` form) can render without needing a live construct tree.
 */
export function renderProductsModule(entries: readonly ProductEntry[]): string {
  const header =
    "// GENERATED by `@scp/iac` synth (team-pipeline-iac.md D20) — DO NOT EDIT BY HAND.\n" +
    "// Regenerate by re-running this pipeline's synth step. The wire manifest carries only URNs;\n" +
    "// this module exists purely so a consuming repo gets a compile-time-checked `placeAt(...)`.\n";

  if (entries.length === 0) {
    return `${header}\nexport const products = {} as const;\n`;
  }

  const usedInterfaces = [...new Set(entries.map((e) => e.interfaceName))].sort((a, b) =>
    a.localeCompare(b)
  );
  const importLine = `import type { ${usedInterfaces.join(", ")} } from "@scp/iac";\n\n`;

  const typeLines = entries
    .map((e) => `  readonly ${e.identifier}: ${e.interfaceName};`)
    .join("\n");
  const valueLines = entries
    .map(
      (e) =>
        `  ${e.identifier}: { urn: ${JSON.stringify(e.urn)}, typeId: "deployment-target", kind: ${JSON.stringify(e.kind)} }`
    )
    .join(",\n");

  return (
    `${header}${importLine}` + `export const products: {\n${typeLines}\n} = {\n${valueLines}\n};\n`
  );
}

/** `collectProducts(scope)` piped straight into `renderProductsModule` — the one call an infra
 *  pipeline's own synth step reaches for (`pipeline.ts`'s `PipelineBase.synthProducts()`). */
export function productsModuleSource(scope: InfraProductScope): string {
  return renderProductsModule(collectProducts(scope));
}
