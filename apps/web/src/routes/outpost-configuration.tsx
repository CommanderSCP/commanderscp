import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OutpostTrustTierSchema } from "@scp/schemas";
import type {
  FederationPeer,
  FederationPeerStatus,
  OutpostConfig,
  OutpostConfigReconcileResult,
  OutpostTrustTier
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { federationStatusKey, outpostConfigListKey } from "../lib/query-client";
import { isForeignOriginObject, replicaGuard, useOwnDomainId } from "../lib/replica-origin";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { isAbsent, UnknownHere } from "./outposts";
import { problemDetail } from "./outpost-settings";

/**
 * M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION: the `outpost` GRAPH OBJECT half of the authority
 * split (ADR-0022 clause 2). Commander-declared, journaled, and read-only at the outpost.
 *
 * FOUR THINGS LIVE HERE, AND THEY ARE NOT THE SAME KIND OF THING — which is the point:
 *
 *  1. TRUST TIER — commander-declared config that SYNCS DOWN. Editable, five members, and ABSENT
 *     until an operator sets one. There is no clear-to-unknown verb in phase A, so once set it can be
 *     changed but not un-asserted.
 *  2. POKE-MODE — a PEER-ROW flag, edited through the same keyless peer PATCH the Settings card uses,
 *     and labelled THIS SIDE ONLY. It is both-sides consent: this flag licenses the commander to
 *     SEND a wake signal; the outpost's OWN flag, set at the outpost, decides whether it accepts one
 *     and stops polling. Presenting one toggle as controlling both sides would be the fabrication.
 *  3. FREEZES / LOCAL GITEA REGISTRY / BUNDLED BACKENDS — READ-ONLY "managed elsewhere" notes (owner
 *     decision). None has a commander-writable data model, and freezes are TESTED never to ride the
 *     journal (`coordination/service-board-precedence.integration.test.ts`). They are named, with
 *     where they are actually configured, and offered NO edit control.
 *  4. RECONCILE — the recovery verb for a peer wedged by duplicate config objects, including the
 *     `?keep=` form, with the two removal outcomes rendered DISTINCTLY: dropping a row THIS domain
 *     authored journals a tombstone that PROPAGATES downstream to the outpost, while dropping an
 *     unverified shadow is a silent local cleanup nothing downstream ever sees.
 */

/** Every LIVE config object bound to this peer. Normally one; more than one is the authority conflict
 *  the reconcile verb exists for. Read from the LIST endpoint on purpose — the single-object `GET`
 *  answers with the winner alone and so cannot show a conflict it has already resolved. */
export function claimantsForPeer(
  configs: OutpostConfig[] | undefined,
  peerDomainId: string
): OutpostConfig[] {
  return (configs ?? []).filter((config) => config.peerDomainId === peerDomainId);
}

export function hasAuthorityConflict(
  configs: OutpostConfig[] | undefined,
  peerDomainId: string
): boolean {
  return claimantsForPeer(configs, peerDomainId).length > 1;
}

/**
 * Is this config object one this instance may write?
 *
 * `originIsSelf` is the server's own resolved answer and is preferred; the `originDomainId` compare
 * is the fallback for a response that predates it. `undefined`/unknown is treated as NOT foreign, so
 * missing data can never fabricate a block on a write the server would accept (the
 * `replica-origin.tsx` rule — a UI that blocks an accepted write is a defect this repo has already
 * fixed once).
 */
export function isConfigForeign(config: OutpostConfig, ownDomainId: string | undefined): boolean {
  if (config.originIsSelf !== undefined) return !config.originIsSelf;
  return isForeignOriginObject(config.originDomainId, ownDomainId);
}

/** The refusal this gate MIRRORS, named so the gate can be checked against a measurement rather than
 *  against a belief. Both halves are measured on a real two-database topology:
 *  `outpost-config-sync.integration.test.ts` ("the OUTPOST's own write … is REFUSED", 409 read-only
 *  replica) and `outpost-handfill-wedge.integration.test.ts` (the same 409 when the only row is an
 *  unverified hand-filled shadow, which this domain likewise did not author). */
export const CONFIG_WRITE_REFUSAL =
  "PATCH /v1/federation/outposts/{peer} answers 409 'read-only replica' for a config object this " +
  "domain did not author.";

export type RemovalOutcome = "propagates-downstream" | "local-cleanup" | "refused";

/**
 * What reconciling with a given survivor would DO to each of the peer's other claimant rows —
 * derived from each row's OWN provenance, not from a guess about server internals:
 *
 *   * a row THIS DOMAIN AUTHORED → an ordinary JOURNALED TOMBSTONE. It PROPAGATES downstream to the
 *     outpost, which will drop its replica. This is the destructive case and it must be said before
 *     the button is pressed, not discovered afterwards.
 *   * an UNVERIFIED hand-filled shadow → a silent local cleanup. This domain never authored it, so
 *     its removal never rides the journal and nothing downstream sees it.
 *   * a SIGNATURE-VERIFIED REPLICA → REFUSED, unconditionally, with or without `?keep=`. Deleting one
 *     would claim authorship of a row the real authority still owns and would trade a config wedge
 *     for a sync wedge. Choosing a survivor that requires deleting one is a 409.
 */
export function removalPreview(
  claimants: OutpostConfig[],
  keepObjectId: string,
  ownDomainId: string | undefined
): { config: OutpostConfig; outcome: RemovalOutcome }[] {
  return claimants
    .filter((config) => config.objectId !== keepObjectId)
    .map((config) => {
      if (!isConfigForeign(config, ownDomainId)) {
        return { config, outcome: "propagates-downstream" as const };
      }
      if (config.provenance === "manual") return { config, outcome: "local-cleanup" as const };
      return { config, outcome: "refused" as const };
    });
}

/**
 * The server's own authority ranking, mirrored — `outposts-repo.ts`'s `byAuthority`: a row THIS
 * DOMAIN AUTHORED outranks a signature-verified replica, which outranks an unverified hand-filled
 * shadow. Every input is already on the wire (`originIsSelf`/`originDomainId`, `provenance`).
 */
export function authorityRank(config: OutpostConfig, ownDomainId: string | undefined): number {
  if (!isConfigForeign(config, ownDomainId)) return 0;
  return config.provenance === "manual" ? 2 : 1;
}

/**
 * Which row a reconcile with NO `keep` would leave standing — or `null` when this side cannot know.
 *
 * DELIBERATELY REFUSES TO GUESS. The server breaks a tie inside one authority class by `(created_at,
 * id)`, which is its list order and not something a client should reconstruct and present as a
 * prediction. So a determinate answer means EXACTLY ONE row holds the top rank; two rows of equal
 * authority return `null`, and the panel then declines to offer the default at all rather than
 * preview a survivor it is guessing at. A preview that might be wrong is worse than no default
 * button, because the whole point of the preview is that it is what will happen.
 */
export function defaultSurvivor(
  claimants: OutpostConfig[],
  ownDomainId: string | undefined
): OutpostConfig | null {
  if (claimants.length === 0) return null;
  const ranks = claimants.map((config) => authorityRank(config, ownDomainId));
  const best = Math.min(...ranks);
  const top = claimants.filter((_, index) => ranks[index] === best);
  return top.length === 1 ? (top[0] ?? null) : null;
}

const OUTCOME_COPY: Record<RemovalOutcome, { label: string; detail: string; tone: string }> = {
  "propagates-downstream": {
    label: "authored here — removal PROPAGATES to the outpost",
    detail:
      "Dropping this row journals an ordinary tombstone. It rides the next sync bundle and the outpost " +
      "drops its replica of this config. It can be re-declared afterwards, but it is a downstream change.",
    tone: "border-red-300 bg-red-50 text-red-800"
  },
  "local-cleanup": {
    label: "unverified hand-filled shadow — local cleanup only",
    detail:
      "This domain never authored this row, so removing it never rides the sync journal and nothing " +
      "downstream sees it.",
    tone: "border-slate-300 bg-slate-50 text-slate-700"
  },
  refused: {
    label: "signature-verified replica — reconcile REFUSES to delete it",
    detail:
      "Deleting a replica this domain did not author would claim authorship of a row its real authority " +
      "still owns, trading this config conflict for a sync wedge. Keeping a different row will be refused (409).",
    tone: "border-amber-300 bg-amber-50 text-amber-800"
  }
};

function ConfigOriginBadge({
  config,
  ownDomainId
}: {
  config: OutpostConfig;
  ownDomainId: string | undefined;
}): React.JSX.Element {
  if (!isConfigForeign(config, ownDomainId)) {
    return (
      <Badge variant="secondary" data-testid="config-origin-local">
        authored here
      </Badge>
    );
  }
  return config.provenance === "manual" ? (
    <Badge variant="outline" data-testid="config-origin-shadow">
      unverified shadow
    </Badge>
  ) : (
    <Badge variant="outline" data-testid="config-origin-replica">
      verified replica
    </Badge>
  );
}

const selectClass =
  "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm";

/**
 * TRUST TIER — owner-ENTERED, five members, ABSENT UNTIL SET.
 *
 * The select's members come from `OutpostTrustTierSchema.options` at runtime, so the control cannot
 * drift from the API's enum. When no tier has been asserted, the select shows an unselectable
 * placeholder and the unknown marker sits beside it — never a blank that reads as `commercial`.
 */
export function TrustTierCard({
  config,
  ownDomainId,
  saveError,
  isSaving = false,
  onSave,
  onReconcile
}: {
  config: OutpostConfig;
  ownDomainId: string | undefined;
  saveError?: unknown;
  isSaving?: boolean;
  onSave: (tier: OutpostTrustTier) => void;
  onReconcile: () => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<string>(config.trustTier ?? "");
  const foreign = isConfigForeign(config, ownDomainId);
  // `provenance === "manual"` ALONE, not `foreign && …`. A `"manual"` row IS an unverified hand-filled
  // shadow by the schema's own definition (`"manual"` for a hand-filled shadow, `null` for anything a
  // signature verified or this domain authored) — its origin adds nothing. Worse, `isConfigForeign`
  // answers FALSE while `ownDomainId` is still loading and the server omitted `originIsSelf`: that is
  // deliberately the right answer for a WRITE gate (never fabricate a block on a write the server
  // would accept) and the wrong one for a DISPLAY discriminator. Conjoining them meant that during
  // the load window a hand-typed shadow rendered `data-tier-unverified="false"` — a manual claim
  // presented as this domain's authority, which is what phase A round 4 exists to prevent.
  const unverifiedShadow = config.provenance === "manual";
  // …and the edit control follows, for the same row, on a MEASURED refusal rather than on caution:
  // `outpost-handfill-wedge.integration.test.ts` measures PATCH answering 409 when the only row is an
  // unverified hand-filled shadow. Offering an enabled control that the server will refuse is the
  // mirror-image defect of blocking one it would accept.
  const guard = replicaGuard(foreign || unverifiedShadow, CONFIG_WRITE_REFUSAL);
  const tierUnknown = config.unknownFields.includes("trustTier");

  return (
    <div className="flex flex-col gap-3" data-testid="trust-tier-card">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Current trust tier
        </span>
        {/* `isAbsent`, not `=== null`: `OutpostConfigSchema.trustTier` is required-nullable, but the
            generated SDK does not validate responses at runtime, so a server that omits the key hands
            this component `undefined` — and `<Badge>{undefined}</Badge>` is an EMPTY BADGE with no
            `data-trust-tier` attribute, i.e. a blank standing in for an unknown. Three lines above,
            the select's own initial state already reads this field with `??`; this makes the two
            agree. */}
        {isAbsent(config.trustTier) ? (
          <span data-testid="config-tier-current" data-trust-tier="unknown">
            <UnknownHere
              title={
                "No trust tier has been asserted for this outpost. It is entered by an operator and has no " +
                "other source — it is never derived and never defaulted."
              }
            />
          </span>
        ) : (
          <span
            data-testid="config-tier-current"
            data-trust-tier={config.trustTier}
            data-tier-unverified={String(unverifiedShadow)}
          >
            <Badge variant={unverifiedShadow ? "outline" : "secondary"}>{config.trustTier}</Badge>
            {tierUnknown && unverifiedShadow && (
              <span className="ml-2">
                <UnknownHere
                  label="unverified"
                  title="This value came from a hand-filled shadow copy, not from this domain's own assertion."
                />
              </span>
            )}
          </span>
        )}
      </div>

      {unverifiedShadow && (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="config-unverified-shadow-notice"
        >
          <p>
            The only config object bound to this outpost is an{" "}
            <strong>unverified hand-filled shadow</strong> — somebody typed it here; this domain did
            not author it and no signature verified it. Editing it is refused (409), so it cannot be
            quietly overwritten. Adopt it as this domain&apos;s own configuration first —{" "}
            <em>reconcile</em> keeps the entered value and makes it journal down to the outpost like
            any commander-origin object.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-2"
            onClick={onReconcile}
            data-testid="config-adopt-shadow"
          >
            Reconcile (adopt this configuration)
          </Button>
        </div>
      )}

      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Set tier</span>
        <select
          name="trustTier"
          data-testid="config-tier-select"
          className={`${selectClass} mt-1`}
          value={tier}
          disabled={guard.disabled}
          onChange={(event) => setTier(event.target.value)}
        >
          {/* Offered ONLY while nothing is asserted: phase A has no clear-to-unknown verb, so an
              already-set tier cannot be un-asserted from here and the placeholder must not pretend
              otherwise. It is `disabled` so it can never be SUBMITTED as a value. */}
          {isAbsent(config.trustTier) && (
            <option value="" disabled>
              — not set —
            </option>
          )}
          {OutpostTrustTierSchema.options.map((member) => (
            <option key={member} value={member}>
              {member}
            </option>
          ))}
        </select>
      </label>

      {saveError !== undefined && saveError !== null && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="config-tier-error"
        >
          {problemDetail(saveError)}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          {...guard}
          disabled={guard.disabled || isSaving || tier === "" || tier === config.trustTier}
          onClick={() => onSave(tier as OutpostTrustTier)}
          data-testid="config-tier-save"
        >
          {isSaving ? "Saving…" : "Save trust tier"}
        </Button>
        <span className="text-xs text-slate-500">
          Commander-declared config: this rides the sync journal down to the outpost, where it is a
          read-only replica.
        </span>
      </div>
    </div>
  );
}

/** The select value → the request field. `""` (the leave-unset option) becomes an ABSENT `trustTier`,
 *  never an empty string: `CreateOutpostConfigRequestSchema` is a `z.strictObject` whose `trustTier`
 *  is the five-member enum, so `""` is a 400 — and a value silently coerced to a member would be the
 *  invented posture this milestone exists to prevent. Absent is the only honest encoding of "the
 *  operator has not decided yet", which is exactly why the create body makes the field optional. */
export function declaredTierOf(selectValue: string): OutpostTrustTier | undefined {
  return selectValue === "" ? undefined : (selectValue as OutpostTrustTier);
}

/** No config object exists for this peer yet. `POST /federation/outposts` binds only to a peer whose
 *  role is `outpost` — a `retrans` peer is a MEASURED 400 (`outpost-object.integration.test.ts`), so
 *  the create control is not offered for one rather than offered and refused. */
export function DeclareConfigCard({
  peer,
  createError,
  isCreating = false,
  onCreate
}: {
  peer: FederationPeer;
  createError?: unknown;
  isCreating?: boolean;
  onCreate: (tier: OutpostTrustTier | undefined) => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<string>("");
  if (peer.role !== "outpost") {
    return (
      <p className="text-sm text-slate-600" data-testid="config-role-not-outpost">
        Commander-declared configuration binds only to a peer whose federation role is{" "}
        <code>outpost</code>. This peer&apos;s role is <code>{peer.role}</code>, so it has no config
        object and none can be declared for it.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="config-declare-card">
      <p className="text-sm text-slate-600">
        No commander-declared configuration exists for this outpost yet. Declaring it creates a
        commander-origin graph object that syncs down as a read-only replica.
      </p>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Trust tier (optional)
        </span>
        <select
          name="trustTier"
          data-testid="config-declare-tier-select"
          className={`${selectClass} mt-1`}
          value={tier}
          onChange={(event) => setTier(event.target.value)}
        >
          {/* Enabled here, unlike the editor above: an operator who has not decided the tier yet MUST
              be able to declare the object without one being invented for them. */}
          <option value="">— leave unset —</option>
          {OutpostTrustTierSchema.options.map((member) => (
            <option key={member} value={member}>
              {member}
            </option>
          ))}
        </select>
      </label>
      {createError !== undefined && createError !== null && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="config-declare-error"
        >
          {problemDetail(createError)}
        </div>
      )}
      <div>
        <Button
          type="button"
          disabled={isCreating}
          onClick={() => onCreate(declaredTierOf(tier))}
          data-testid="config-declare-save"
        >
          {isCreating ? "Declaring…" : "Declare configuration"}
        </Button>
      </div>
    </div>
  );
}

/**
 * POKE-MODE — THIS SIDE ONLY (owner decision).
 *
 * ADR-0009's flag is PER-SIDE. On a commander it means "this side MAY send a contentless wake signal
 * to that peer"; it does not, and cannot, set the outpost's own flag, which is what decides whether
 * the outpost accepts a poke and disables its frequent poll. A single toggle presented as controlling
 * both sides would be a claim about a database this instance cannot write.
 *
 * The UNILATERAL-SPARSE case is rendered as such: `pokeMode: true` with `lastPokeReceivedAt: null` is
 * this side opted in while the other side has never actually poked — the scheduler keeps polling
 * (`effectiveCadence: "poll"`), and this is how an operator sees it.
 */
export function isUnilateralSparse(status: FederationPeerStatus): boolean {
  return status.peer.pokeMode === true && (status.lastPokeReceivedAt ?? null) === null;
}

export function PokeModeCard({
  status,
  saveError,
  isSaving = false,
  onToggle
}: {
  status: FederationPeerStatus;
  saveError?: unknown;
  isSaving?: boolean;
  onToggle: (next: boolean) => void;
}): React.JSX.Element {
  const enabled = status.peer.pokeMode === true;
  return (
    <div className="flex flex-col gap-3" data-testid="poke-mode-card">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Poke-mode (this side only)
        </span>
        <Badge variant={enabled ? "info" : "secondary"} data-testid="poke-mode-state">
          {enabled ? "this side may poke" : "poll only"}
        </Badge>
      </div>
      <p className="text-sm text-slate-600" data-testid="poke-mode-both-sides-note">
        This flag is <strong>local to this instance</strong>: it licenses this side to SEND a
        contentless wake signal to the outpost. It does not set the outpost&apos;s own flag — the
        outpost decides at the outpost whether it accepts a poke and stops polling. Poke-mode is
        both-sides consent, and this toggle is only this side&apos;s half.
      </p>
      {isUnilateralSparse(status) && (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="poke-mode-unilateral-sparse"
        >
          This side is opted in to poke-mode but <strong>no poke has ever been received</strong>{" "}
          from this peer — the named unilateral-sparse misconfiguration. The scheduler is still
          polling (effective cadence <code>{status.effectiveCadence ?? "unreported"}</code>). Either
          enable poke-mode at the outpost too, or turn it off here.
        </div>
      )}
      {saveError !== undefined && saveError !== null && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="poke-mode-error"
        >
          {problemDetail(saveError)}
        </div>
      )}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={() => onToggle(!enabled)}
          data-testid="poke-mode-toggle"
        >
          {enabled ? "Disable poke-mode on this side" : "Enable poke-mode on this side"}
        </Button>
      </div>
    </div>
  );
}

/**
 * MANAGED ELSEWHERE — READ-ONLY NOTES, NO EDIT CONTROLS (owner decision).
 *
 * The proposal listed freezes, the outpost-local Gitea registry and the enabled bundled backends as
 * per-outpost configuration. None of the three has a commander-writable data model today, and
 * freezes are TESTED never to ride the journal
 * (`coordination/service-board-precedence.integration.test.ts`) — a freeze declared at the commander
 * does not become a freeze at the outpost. So they are named here, with where they are ACTUALLY
 * configured, and offered no control at all. An edit box that silently does nothing downstream would
 * be worse than no box.
 */
export const MANAGED_ELSEWHERE = [
  {
    id: "freezes",
    title: "Freeze windows",
    where:
      "Declared per object in the governance surface of the instance that enforces them. A freeze is a " +
      "local projection row: it does NOT ride the sync journal, so a freeze declared at the commander is " +
      "not a freeze at the outpost."
  },
  {
    id: "local-registry",
    title: "Outpost-local Gitea / registry",
    where:
      "Created or imported AT the outpost (M15, ADR-0010). The commander has no writable model for it — " +
      "it is outpost-owned infrastructure, and the outpost's own UI/CLI configures it."
  },
  {
    id: "bundled-backends",
    title: "Enabled bundled backends",
    where:
      "A deployment-time choice in that instance's Helm values / compose file (deploy/helm-bundled), not " +
      "graph data this API can write."
  }
] as const;

export function ManagedElsewhereNotes(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="managed-elsewhere" data-editable="false">
      <p className="text-sm text-slate-600">
        Configured elsewhere, and shown here only so it is not mistaken for missing. This page
        offers no control over any of it.
      </p>
      <dl className="flex flex-col gap-3">
        {MANAGED_ELSEWHERE.map((item) => (
          <div
            key={item.id}
            className="rounded border border-slate-200 bg-slate-50 p-3"
            data-testid={`managed-elsewhere-${item.id}`}
          >
            <dt className="text-sm font-medium text-slate-800">{item.title}</dt>
            <dd className="mt-1 text-xs text-slate-600">{item.where}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The two removal outcomes, rendered so they can never be read as one. */
export function ReconcileOutcome({
  result
}: {
  result: OutpostConfigReconcileResult;
}): React.JSX.Element {
  return (
    <div
      className="rounded border border-slate-300 bg-white p-3 text-sm"
      data-testid="reconcile-result"
    >
      <p>
        The binding now resolves to <code>{result.config.objectId}</code>.
      </p>
      {result.adoptedObjectId !== null && (
        <p className="mt-2 text-slate-700" data-testid="reconcile-adopted">
          Adopted <code>{result.adoptedObjectId}</code> as this domain&apos;s own configuration — it
          journals down to the outpost from now on.
        </p>
      )}
      {result.removedShadowObjectIds.length > 0 && (
        <p className="mt-2 text-slate-700" data-testid="reconcile-removed-shadows">
          Removed {result.removedShadowObjectIds.length} unverified hand-filled shadow
          {result.removedShadowObjectIds.length === 1 ? "" : "s"} —{" "}
          <strong>a local cleanup only</strong>; this domain never authored them, so nothing rode
          the journal and nothing downstream saw it.
        </p>
      )}
      {result.removedLocalObjectIds.length > 0 && (
        <p
          className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-red-800"
          data-testid="reconcile-removed-local"
        >
          Removed {result.removedLocalObjectIds.length} configuration object
          {result.removedLocalObjectIds.length === 1 ? "" : "s"}{" "}
          <strong>this domain authored</strong> — an ordinary journaled tombstone that{" "}
          <strong>PROPAGATES downstream</strong>: the outpost will drop its replica on the next
          sync.
        </p>
      )}
      {result.removedShadowObjectIds.length === 0 &&
        result.removedLocalObjectIds.length === 0 &&
        result.adoptedObjectId === null && (
          <p className="mt-2 text-slate-600" data-testid="reconcile-removed-none">
            Nothing needed removing.
          </p>
        )}
    </div>
  );
}

/**
 * THE RECONCILE PANEL. Shown when the peer has more than one live claimant row (an authority
 * conflict) — and reachable from the unverified-shadow notice above, which is the single-row case
 * where adoption is the recovery.
 *
 * Every destructive choice states its consequence BEFORE it is taken, per claimant, from that
 * claimant's own provenance.
 */
export function ReconcilePanel({
  claimants,
  ownDomainId,
  result,
  reconcileError,
  isReconciling = false,
  onReconcile
}: {
  claimants: OutpostConfig[];
  ownDomainId: string | undefined;
  result?: OutpostConfigReconcileResult | undefined;
  reconcileError?: unknown;
  isReconciling?: boolean;
  onReconcile: (keep?: string) => void;
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState<string | null>(null);
  // THE DEFAULT IS OFFERED ONLY WHERE IT CANNOT BE THE DESTRUCTIVE CHOICE — one rule, not a second
  // copy of the confirmation machinery. It stands down for either reason:
  //   * the survivor is INDETERMINATE (two rows of equal authority, tie broken server-side), so any
  //     preview would be a guess; or
  //   * reconciling with it would drop a row THIS DOMAIN AUTHORED, whose tombstone PROPAGATES to the
  //     outpost. That choice must be made explicitly, per row, behind the checkbox below.
  // As it happens the second condition is implied by the first today (a UNIQUE top-ranked survivor
  // means every dropped row ranks strictly lower, hence is foreign, hence never propagates) — it is
  // written out anyway so a later change to `authorityRank` cannot silently reopen the bypass.
  const candidate = defaultSurvivor(claimants, ownDomainId);
  const candidatePreview = candidate
    ? removalPreview(claimants, candidate.objectId, ownDomainId)
    : [];
  const candidatePropagates = candidatePreview.some(
    (entry) => entry.outcome === "propagates-downstream"
  );
  const defaultKeep = candidate !== null && !candidatePropagates ? candidate : null;
  const defaultPreview = defaultKeep ? candidatePreview : [];
  const defaultRefused = defaultPreview.some((entry) => entry.outcome === "refused");

  return (
    <div className="flex flex-col gap-3" data-testid="reconcile-panel">
      <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Authority conflict:</strong> {claimants.length} live configuration objects are bound
        to this outpost. The binding is meant to be 1:1, so ordinary edits are refused (409) until
        one row survives. This is not &quot;no configuration&quot; — it is too much of it.
      </div>

      {claimants.map((claimant) => {
        const preview = removalPreview(claimants, claimant.objectId, ownDomainId);
        const refused = preview.some((entry) => entry.outcome === "refused");
        const propagates = preview.some((entry) => entry.outcome === "propagates-downstream");
        const needsConfirm = propagates && confirmed !== claimant.objectId;
        return (
          <div
            key={claimant.objectId}
            className="rounded border border-slate-200 p-3"
            data-testid="reconcile-claimant"
            data-object-id={claimant.objectId}
          >
            <div className="flex items-center gap-2">
              <ConfigOriginBadge config={claimant} ownDomainId={ownDomainId} />
              <span className="font-mono text-xs text-slate-600">{claimant.objectId}</span>
              <span className="text-xs text-slate-500">
                tier: {claimant.trustTier ?? "not asserted"}
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {preview.map((entry) => (
                <div
                  key={entry.config.objectId}
                  className={`rounded border p-2 text-xs ${OUTCOME_COPY[entry.outcome].tone}`}
                  data-testid="reconcile-removal-preview"
                  data-outcome={entry.outcome}
                >
                  <div className="font-medium">
                    <code>{entry.config.objectId}</code> — {OUTCOME_COPY[entry.outcome].label}
                  </div>
                  <div className="mt-1">{OUTCOME_COPY[entry.outcome].detail}</div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                variant={propagates ? "destructive" : "outline"}
                disabled={isReconciling || refused || needsConfirm}
                onClick={() => onReconcile(claimant.objectId)}
                data-testid="reconcile-keep"
                data-keep={claimant.objectId}
                {...(refused
                  ? {
                      title:
                        "Refused: keeping this row would require deleting a signature-verified replica " +
                        "this domain did not author (409)."
                    }
                  : {})}
              >
                Keep this one
              </Button>
              {needsConfirm && (
                <label className="flex items-center gap-2 text-xs text-red-800">
                  <input
                    type="checkbox"
                    data-testid="reconcile-confirm-propagating"
                    checked={false}
                    onChange={() => setConfirmed(claimant.objectId)}
                  />
                  I understand this removes configuration this domain authored and propagates the
                  removal to the outpost
                </label>
              )}
            </div>
          </div>
        );
      })}

      {/* THE DEFAULT, THROUGH THE SAME DOOR AS EVERY OTHER CHOICE.
          It used to call the same destructive verb with NO `keep` — no preview of which row survives,
          no per-outcome block, no confirmation, and a label naming no consequence — while the
          per-claimant buttons beside it stayed disabled behind a checkbox for exactly that action.
          The measured shape of the bypass: with two locally-authored claimants both `reconcile-keep`
          buttons carried `disabled=""` and `reconcile-default` was fully clickable, and server-side
          that call still soft-deletes the surplus, journaling a tombstone that PROPAGATES to the
          outpost for any row this domain authored.

          So it now NAMES its survivor, previews every dropped row, and is withheld entirely wherever
          it would be the propagating choice. Naming the survivor is not cosmetic: a request carrying
          `?keep=` cannot diverge from the preview shown beside it, whereas a bare call re-derives the
          survivor server-side after the operator has already read a prediction. */}
      {defaultKeep ? (
        <div
          className="rounded border border-slate-200 p-3"
          data-testid="reconcile-default-block"
          data-keep={defaultKeep.objectId}
        >
          <div className="text-sm text-slate-700">
            The most authoritative row is <code>{defaultKeep.objectId}</code>. Reconciling with it
            would do this:
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {defaultPreview.map((entry) => (
              <div
                key={entry.config.objectId}
                className={`rounded border p-2 text-xs ${OUTCOME_COPY[entry.outcome].tone}`}
                data-testid="reconcile-removal-preview"
                data-outcome={entry.outcome}
              >
                <div className="font-medium">
                  <code>{entry.config.objectId}</code> — {OUTCOME_COPY[entry.outcome].label}
                </div>
                <div className="mt-1">{OUTCOME_COPY[entry.outcome].detail}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isReconciling || defaultRefused}
              onClick={() => onReconcile(defaultKeep.objectId)}
              data-testid="reconcile-default"
              // The SAME value the click sends, on the control itself — `renderToStaticMarkup` cannot
              // fire a handler, so this is what makes the named survivor machine-checkable.
              data-keep={defaultKeep.objectId}
              {...(defaultRefused
                ? {
                    title:
                      "Refused: keeping the most authoritative row would require deleting a " +
                      "signature-verified replica this domain did not author (409)."
                  }
                : {})}
            >
              Reconcile (keep the most authoritative row)
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-600" data-testid="reconcile-default-indeterminate">
          <strong>No default is offered for this conflict.</strong> Either two of these rows hold the
          same authority — the server breaks that tie by creation order, so this side cannot say
          which would survive and will not preview a guess — or reconciling would drop configuration
          this domain authored, whose removal <strong>propagates to the outpost</strong>. Choose the
          row that should survive above, where the consequence is stated per row.
        </p>
      )}

      {reconcileError !== undefined && reconcileError !== null && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="reconcile-error"
        >
          {problemDetail(reconcileError)}
        </div>
      )}
      {result && <ReconcileOutcome result={result} />}
    </div>
  );
}

/** `404` from `GET /federation/outposts/{peer}` is the ONE branch where the resource really is
 *  absent (phase A reserves it for that, and answers 409 for an authority conflict). Anything else is
 *  a real error and must not be flattened into "no configuration". */
function isNotFound(err: unknown): boolean {
  return err instanceof ScpApiError && err.status === 404;
}

/** The wired-up Configuration card. */
export function OutpostConfigurationSection({
  status
}: {
  status: FederationPeerStatus;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { domainId: ownDomainId } = useOwnDomainId();
  const peerDomainId = status.peer.id;

  // The LIST, not the single-object GET: a peer with two claimant rows is exactly the conflict the
  // reconcile verb exists for, and the single GET resolves it away before a client can see it.
  const configsQuery = useQuery({
    queryKey: outpostConfigListKey(),
    queryFn: () => client.federation.listOutposts()
  });
  const claimants = claimantsForPeer(configsQuery.data, peerDomainId);
  const conflict = claimants.length > 1;
  const config = claimants[0];

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: outpostConfigListKey() });
    await queryClient.invalidateQueries({ queryKey: federationStatusKey() });
  };

  const tierMutation = useMutation({
    mutationFn: (tier: OutpostTrustTier) =>
      client.federation.updateOutpost(peerDomainId, { trustTier: tier }),
    onSuccess: invalidate
  });
  const createMutation = useMutation({
    mutationFn: (tier: OutpostTrustTier | undefined) =>
      client.federation.createOutpost({
        peerDomainId,
        ...(tier !== undefined ? { trustTier: tier } : {})
      }),
    onSuccess: invalidate
  });
  const pokeMutation = useMutation({
    mutationFn: (next: boolean) => client.federation.updatePeer(peerDomainId, { pokeMode: next }),
    onSuccess: invalidate
  });
  const reconcileMutation = useMutation({
    mutationFn: (keep: string | undefined) =>
      client.federation.reconcileOutpost(peerDomainId, keep !== undefined ? { keep } : {}),
    onSuccess: invalidate
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          Commander-declared configuration for this outpost. It is an ordinary graph object, so it
          rides the sync journal down and lands at the outpost as a read-only replica. Poke-mode
          below is a peer-row flag and is <strong>this side only</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {configsQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

        {conflict && (
          <ReconcilePanel
            claimants={claimants}
            ownDomainId={ownDomainId}
            result={reconcileMutation.data}
            reconcileError={reconcileMutation.error}
            isReconciling={reconcileMutation.isPending}
            onReconcile={(keep) => reconcileMutation.mutate(keep)}
          />
        )}

        {!conflict && config && (
          <TrustTierCard
            key={`${config.objectId}:${config.version}`}
            config={config}
            ownDomainId={ownDomainId}
            saveError={tierMutation.error}
            isSaving={tierMutation.isPending}
            onSave={(tier) => tierMutation.mutate(tier)}
            onReconcile={() => reconcileMutation.mutate(undefined)}
          />
        )}
        {!conflict && config && reconcileMutation.data && (
          <ReconcileOutcome result={reconcileMutation.data} />
        )}
        {!conflict && config && reconcileMutation.error !== null && (
          <div
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
            data-testid="reconcile-error"
          >
            {problemDetail(reconcileMutation.error)}
          </div>
        )}

        {!conflict && !config && configsQuery.isSuccess && (
          <DeclareConfigCard
            peer={status.peer}
            createError={createMutation.error}
            isCreating={createMutation.isPending}
            onCreate={(tier) => createMutation.mutate(tier)}
          />
        )}
        {configsQuery.isError && !isNotFound(configsQuery.error) && (
          <p className="text-sm text-red-700" data-testid="config-load-error">
            {problemDetail(configsQuery.error)}
          </p>
        )}

        <hr className="border-slate-200" />
        <PokeModeCard
          status={status}
          saveError={pokeMutation.error}
          isSaving={pokeMutation.isPending}
          onToggle={(next) => pokeMutation.mutate(next)}
        />

        <hr className="border-slate-200" />
        <ManagedElsewhereNotes />
      </CardContent>
    </Card>
  );
}
