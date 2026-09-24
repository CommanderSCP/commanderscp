import { DESTINATION_FORMAT_OF_TYPE, type ExecutorType } from "@scp/schemas";
import {
  BUILD_DESTINATION_PARAMETER_KEYS,
  BuildDestinationRefused
} from "./build-trigger-parameters.js";
import { AUTHORED_APPLICATION_PARAMETER } from "./deploy-lane-trigger-parameters.js";
import {
  OPS_RUN_ID_PARAMETER,
  OPS_RUN_TOKEN_SEALED_PARAMETER
} from "./ops-lane-trigger-parameters.js";
import {
  TriggerParameterRefusal,
  WAVE_TARGET_RECIPE_RESERVED_PARAMETER_AUDIT_ACTION,
  WAVE_TARGET_RECIPE_RESERVED_PARAMETER_STATUS
} from "./trigger-parameter-refusal.js";

/**
 * SERVER-RESERVED TRIGGER PARAMETERS — ONE TABLE, ONE CHOKE POINT (M28.4 fix round, ADR-0055 D9).
 *
 * THE PROPERTY, not the instance. Every lane in `reconcile.ts` derives some trigger parameters as a
 * BOUND — what gets deployed, which machines get touched, where an artifact is published. A bound is
 * only a bound if nothing authored can restate it. The instance review found was a campaign recipe
 * carrying `scpAuthoredApplication` for a component that declared no deployment: the deploy lane
 * derived nothing, the recipe's value passed straight through, and the argocd plugin created an
 * Application with a foreign source and a cluster-admin ClusterRoleBinding. The same shape exists for
 * every derived key a lane might OMIT: an omitted bound is filled by the recipe.
 *
 * So: a key listed here comes from a server lane and from nowhere else. `recipeReservedParameterRefusal`
 * is called at the ONE place a recipe's parameters enter a trigger (`reconcile.ts`, right after they
 * are read, inside the claim transaction) and refuses — terminally, Decision + audit through
 * `TriggerParameterRefusal` — before any lane runs. Keys NOT listed are conveniences an operator may
 * legitimately restate; the recipe-wins rule stands for those (see
 * `reserved-trigger-parameters.test.ts`, which fails on any lane key nobody classified).
 *
 * REGISTRATION POINT. A lane that derives a new bound adds ONE entry to `RESERVED_BY_LANE`. M28.2's
 * Argo ops lane (ADR-0054) registers its keys here as `"ops-argo"`.
 */
export interface ReservedLane {
  /** Why these keys are bounds. */
  why: string;
  keys: readonly string[];
  /** When the reservation applies. Absent ⇒ always. The build destination is reserved only for a
   *  Type whose destination SCP derives — a no-class Type (`npm`, …) derives none to protect, so a
   *  recipe may still name those keys there (ADR-0053 §4a). */
  appliesTo?: (type: ExecutorType) => boolean;
}

export const RESERVED_BY_LANE: Readonly<Record<string, ReservedLane>> = {
  deploy: {
    why: "the SCP-authored Argo CD Application (ADR-0055)",
    keys: [AUTHORED_APPLICATION_PARAMETER]
  },
  "ops-managed": {
    why: "which hosts a host-reaching run touches, what it may reach, and the credential it holds (ADR-0052)",
    keys: [
      "opsRole",
      "opsInventory",
      "opsEgressAllowlist",
      "opsPrincipals",
      "opsCredentialSecretKey"
    ]
  },
  // M28.2 (ADR-0054 D3) — the Argo host-ops delivery: a run id and the token SEALED to the pinned
  // key. A recipe naming either could substitute a token SCP did not mint for this run.
  "ops-argo": {
    why: "the Argo host-ops run's sealed one-time token and its run id (ADR-0054)",
    keys: [OPS_RUN_TOKEN_SEALED_PARAMETER, OPS_RUN_ID_PARAMETER]
  },
  "build-destination": {
    why: "where an artifact is published — the publishes_to edge is the only door (ADR-0053 §4a)",
    keys: BUILD_DESTINATION_PARAMETER_KEYS,
    appliesTo: (type) =>
      (DESTINATION_FORMAT_OF_TYPE as Partial<Record<ExecutorType, unknown>>)[type] != null
  },
  "build-identity": {
    why: "the change identity the executor reports back under",
    keys: ["changeObjectId"]
  }
};

/** Every reserved key, whatever the Type — for the census. */
export const SERVER_RESERVED_TRIGGER_PARAMETER_KEYS: ReadonlySet<string> = new Set(
  Object.values(RESERVED_BY_LANE).flatMap((l) => [...l.keys])
);

/** The reserved keys an authored parameter bag names FOR THIS TYPE, sorted (content-stable). */
export function reservedKeysIn(
  parameters: Record<string, unknown> | undefined,
  type: ExecutorType
): string[] {
  if (!parameters) return [];
  const out = new Set<string>();
  for (const lane of Object.values(RESERVED_BY_LANE)) {
    if (lane.appliesTo && !lane.appliesTo(type)) continue;
    for (const k of lane.keys) if (Object.hasOwn(parameters, k)) out.add(k);
  }
  return [...out].sort();
}

export class RecipeReservedParameterRefused extends TriggerParameterRefusal {
  readonly status = WAVE_TARGET_RECIPE_RESERVED_PARAMETER_STATUS;
  readonly action = WAVE_TARGET_RECIPE_RESERVED_PARAMETER_AUDIT_ACTION;
}

/** THE CHOKE POINT. `undefined` ⇒ the recipe names no bound. A recipe naming ONLY build-destination
 *  keys is refused exactly as ADR-0053 §4a states it (`BuildDestinationRefused`, gate
 *  `build_destination_recipe`), so that lane's contract is unchanged; anything else reserved is
 *  `recipe_reserved_parameter`. */
export function recipeReservedParameterRefusal(
  recipeParameters: Record<string, unknown> | undefined,
  type: ExecutorType
): TriggerParameterRefusal | undefined {
  const reserved = reservedKeysIn(recipeParameters, type);
  if (reserved.length === 0) return undefined;
  const destination = new Set<string>(RESERVED_BY_LANE["build-destination"]!.keys);
  if (reserved.every((k) => destination.has(k))) {
    return new BuildDestinationRefused(
      `refusing to trigger this '${type}' build: its campaign recipe sets ${reserved.join(", ")}, ` +
        `which SCP derives from the component's publishes_to registry. A recipe may add parameters ` +
        `but not choose where a '${type}' artifact is published — that would route it around the ` +
        `destination check entirely.`,
      {
        remediation:
          `remove ${reserved.join(", ")} from the recipe's trigger.parameters and declare the ` +
          `destination as data instead (the component's publishes_to edge, and the registry's ` +
          `packageFormats), then cancel/rollback/re-propose the change`,
        inputContext: { gate: "build_destination_recipe", type, recipeDestinationKeys: reserved }
      }
    );
  }
  const lanes = Object.values(RESERVED_BY_LANE)
    .filter((l) => l.keys.some((k) => reserved.includes(k)))
    .map((l) => l.why);
  return new RecipeReservedParameterRefused(
    `this change's recipe supplies ${reserved.map((k) => `'${k}'`).join(", ")}, which only ` +
      `CommanderSCP's own lanes may derive (${lanes.join("; ")})`,
    {
      remediation:
        `remove those keys from the recipe's trigger parameters. What they bound is declared on the ` +
        `graph (a component's deployment, its publishes_to registry, an operation's inventory) and ` +
        `derived by the server — an authored document restating it would replace the bound with an ` +
        `assertion`,
      // The keys only, never the values: a smuggled Application is not worth persisting verbatim.
      inputContext: { gate: "recipe_reserved_parameter", reservedParameters: reserved }
    }
  );
}
