import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatOutpostClaimantToken, OutpostTrustTierSchema } from "@scp/schemas";
import type {
  FederationPeer,
  FederationPeerStatus,
  FederationRole,
  OutpostConfig,
  OutpostConfigReconcileResult,
  OutpostTrustTier
} from "@scp/schemas";
import { reconcileStaleClaimants, ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { federationStatusKey, outpostConfigListKey } from "../lib/query-client";
import { cn, focusRing } from "../lib/utils";
import { isForeignOriginObject, replicaGuard, useOwnDomainId } from "../lib/replica-origin";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Alert, type AlertTone } from "../components/ui/alert";
import { SectionLabel } from "../components/ui/section-label";
import { SkeletonRows } from "../components/ui/skeleton";
import { isAbsent } from "../lib/absent";
import { UnknownHere } from "./outposts";
import { problemDetail } from "./outpost-settings";

/** M16.2 phase B (B3) — PER-OUTPOST CONFIGURATION. See docs/web.md §366. */

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

/** Is this config object one this instance may write? See docs/web.md §367. */
export function isConfigForeign(config: OutpostConfig, ownDomainId: string | undefined): boolean {
  if (config.originIsSelf !== undefined) return !config.originIsSelf;
  return isForeignOriginObject(config.originDomainId, ownDomainId);
}

/** The refusal this gate mirrors, named so it can be checked. See docs/web.md §368. */
export const CONFIG_WRITE_REFUSAL =
  "PATCH /v1/federation/outposts/{peer} answers 409 'read-only replica' for a config object this " +
  "domain did not author.";

export type RemovalOutcome = "propagates-downstream" | "local-cleanup" | "refused";

/** What reconciling with a survivor would do to the others. See docs/web.md §369. */
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

/** The server's own authority ranking, mirrored. See docs/web.md §370. */
export function authorityRank(config: OutpostConfig, ownDomainId: string | undefined): number {
  if (!isConfigForeign(config, ownDomainId)) return 0;
  return config.provenance === "manual" ? 2 : 1;
}

/** Which row a reconcile with NO `keep` would leave standing. See docs/web.md §371. */
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

const OUTCOME_COPY: Record<RemovalOutcome, { label: string; detail: string; tone: AlertTone }> = {
  "propagates-downstream": {
    label: "authored here — removal PROPAGATES to the outpost",
    detail:
      "Dropping this row journals an ordinary tombstone. It rides the next sync bundle and the outpost " +
      "drops its replica of this config. It can be re-declared afterwards, but it is a downstream change.",
    tone: "danger"
  },
  "local-cleanup": {
    label: "unverified hand-filled shadow — local cleanup only",
    detail:
      "This domain never authored this row, so removing it never rides the sync journal and nothing " +
      "downstream sees it.",
    tone: "neutral"
  },
  refused: {
    label: "signature-verified replica — reconcile REFUSES to delete it",
    detail:
      "Deleting a replica this domain did not author would claim authorship of a row its real authority " +
      "still owns, trading this config conflict for a sync wedge. Keeping a different row will be refused (409).",
    tone: "warning"
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
      <Badge variant="neutral" data-testid="config-origin-local">
        authored here
      </Badge>
    );
  }
  return config.provenance === "manual" ? (
    <Badge variant="unknown" data-testid="config-origin-shadow">
      unverified shadow
    </Badge>
  ) : (
    <Badge variant="neutral" data-testid="config-origin-replica">
      verified replica
    </Badge>
  );
}

const selectClass = cn(
  "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm",
  focusRing
);

/** TRUST TIER — owner-ENTERED, five members, ABSENT UNTIL SET. See docs/web.md §372. */
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
  // That field is required by the schema, so the fallback is. See docs/web.md §373.
  const tierUnknown = (config.unknownFields ?? []).includes("trustTier");
  // TWO INDEPENDENT SIGNALS FOR ONE FACT, OR'd. See docs/web.md §374.
  const declaredUnverifiedTier = !isAbsent(config.trustTier) && tierUnknown;
  const unverifiedShadow = config.provenance === "manual" || declaredUnverifiedTier;
  // …and the edit control follows, for the same row, on a MEASURED refusal rather than on caution:
  // `outpost-handfill-wedge.integration.test.ts` measures PATCH answering 409 when the only row is an
  // unverified hand-filled shadow. Offering an enabled control that the server will refuse is the
  // mirror-image defect of blocking one it would accept.
  const guard = replicaGuard(foreign || unverifiedShadow, CONFIG_WRITE_REFUSAL);

  return (
    <div className="flex flex-col gap-3" data-testid="trust-tier-card">
      <div className="flex items-center gap-2">
        <SectionLabel>Current trust tier</SectionLabel>
        {/* `isAbsent`, not `=== null`: `OutpostConfigSchema.trustTier` is required-nullable, and
            BEFORE ADR-0023 the generated SDK validated no response, so a server that omitted the key
            handed this component `undefined` — and `<Badge>{undefined}</Badge>` is an EMPTY BADGE with no
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
            <Badge variant={unverifiedShadow ? "unknown" : "neutral"}>{config.trustTier}</Badge>
            {/* `unverifiedShadow` ALONE. It used to be `tierUnknown && unverifiedShadow`, which meant
                the visible "unverified" word was withheld whenever the server declared nothing —
                leaving only an attribute and a badge variant to carry the whole distinction. Whenever
                the value is rendered as unverified, an operator READS that it is. */}
            {unverifiedShadow && (
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
        <Alert tone="warning" data-testid="config-unverified-shadow-notice">
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
        </Alert>
      )}

      <label className="block">
        <SectionLabel as="span">Set tier</SectionLabel>
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
        <Alert tone="danger" data-testid="config-tier-error">
          {problemDetail(saveError)}
        </Alert>
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

/** The select value → the request field. See docs/web.md §375. */
export function declaredTierOf(selectValue: string): OutpostTrustTier | undefined {
  return selectValue === "" ? undefined : (selectValue as OutpostTrustTier);
}

/** No config object exists for this peer yet. See docs/web.md §376. */
/** THE REFUSAL `POST /federation/outposts` MIRRORS, SHARED. See docs/web.md §377. */
export function ConfigRoleNotOutpostNotice({ role }: { role: string }): React.JSX.Element {
  return (
    <p className="text-sm text-slate-600" data-testid="config-role-not-outpost">
      Commander-declared configuration binds only to a peer whose federation role is{" "}
      <code>outpost</code>. This peer&apos;s role is <code>{role}</code>, so it has no config object
      and none can be declared for it.
    </p>
  );
}

export function DeclareConfigCard({
  peer,
  coLocated = false,
  selfRole,
  createError,
  isCreating = false,
  onCreate
}: {
  /** The peer this record would be about — omitted for the HQ outpost, which has none. */
  peer?: Pick<FederationPeer, "role">;
  /** §10.5 — declaring the record for THIS instance's own domain (`peerDomainId` = self). */
  coLocated?: boolean;
  /** With `coLocated`: this instance's own federation role (`GET /federation/self`/status `self`).
   *  Anything but `commander` renders the refusal — the same one the server measures. */
  selfRole?: FederationRole;
  createError?: unknown;
  isCreating?: boolean;
  onCreate: (tier: OutpostTrustTier | undefined) => void;
}): React.JSX.Element {
  const [tier, setTier] = useState<string>("");
  if (!coLocated && peer && peer.role !== "outpost") {
    return <ConfigRoleNotOutpostNotice role={peer.role} />;
  }
  if (coLocated && selfRole !== "commander") {
    return (
      <p className="text-sm text-slate-600" data-testid="config-self-role-not-commander">
        This instance&apos;s own outpost record is <strong>commander-declared</strong>: it is
        authored at the commander and arrives here replicated, read-only. This instance&apos;s
        federation role is <code>{selfRole ?? "unknown"}</code>, not <code>commander</code>, so it
        cannot declare one for itself — declare it at the commander
        {selfRole === "unset" ? (
          <>
            {" "}
            (or designate this instance&apos;s role first:{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5">
              scp federation init --role commander
            </code>
            )
          </>
        ) : null}
        .
      </p>
    );
  }
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="config-declare-card"
      data-co-located={coLocated ? "true" : undefined}
    >
      {coLocated ? (
        <p className="text-sm text-slate-600" data-testid="config-declare-co-located">
          This instance&apos;s own trust domain has no outpost record yet. Every deployment target
          is part of some outpost — declaring the <strong>HQ outpost</strong> registers this
          instance&apos;s domain as one, so the targets it authors read that outpost on their
          pipeline tiles instead of &ldquo;no outpost registered&rdquo;. It is an ordinary
          commander-origin graph object; at an outpost the same record arrives replicated from this
          commander.
        </p>
      ) : (
        <p className="text-sm text-slate-600">
          No commander-declared configuration exists for this outpost yet. Declaring it creates a
          commander-origin graph object that syncs down as a read-only replica.
        </p>
      )}
      <label className="block">
        <SectionLabel as="span">Trust tier (optional)</SectionLabel>
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
        <Alert tone="danger" data-testid="config-declare-error">
          {problemDetail(createError)}
        </Alert>
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

/** POKE-MODE — THIS SIDE ONLY. See docs/web.md §378. */
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
  // THE NOUN, ROLE-AWARE — poke-mode is genuinely both-sides consent for a retrans peer too (ADR-0009
  // does not scope it to `outpost`; a retrans polls or is poked exactly like an outpost), so only the
  // word naming the other side was wrong.
  const peerNoun = status.peer.role === "retrans" ? "retrans peer" : "outpost";
  return (
    <div className="flex flex-col gap-3" data-testid="poke-mode-card">
      <div className="flex items-center gap-2">
        <SectionLabel>Poke-mode (this side only)</SectionLabel>
        <Badge variant={enabled ? "info" : "neutral"} data-testid="poke-mode-state">
          {enabled ? "this side may poke" : "poll only"}
        </Badge>
      </div>
      {/* Copy rule 1: a fragment in chrome, the full 3-sentence rationale in the tooltip. The
          fragment keeps the two clauses `outpost-configuration.test.tsx` reads off the visible
          text ("this side" / "does not set the outpost") — compression must not drop the claim
          itself, only the words around it. */}
      <p
        className="text-xs text-slate-500"
        data-testid="poke-mode-both-sides-note"
        title={
          "This flag is local to this instance: it licenses this side to send a contentless wake " +
          `signal to the ${peerNoun}. It does not set the ${peerNoun}'s own flag — the ${peerNoun} ` +
          `decides at the ${peerNoun} whether it accepts a poke and stops polling. Poke-mode is ` +
          "both-sides consent, and this toggle is only this side's half."
        }
      >
        Local to this side only — does not set the {peerNoun}&apos;s own flag.
      </p>
      {isUnilateralSparse(status) && (
        <Alert tone="warning" data-testid="poke-mode-unilateral-sparse">
          This side is opted in to poke-mode but <strong>no poke has ever been received</strong>{" "}
          from this peer — the named unilateral-sparse misconfiguration. The scheduler is still
          polling (effective cadence <code>{status.effectiveCadence ?? "unreported"}</code>). Either
          enable poke-mode at the {peerNoun} too, or turn it off here.
        </Alert>
      )}
      {saveError !== undefined && saveError !== null && (
        <Alert tone="danger" data-testid="poke-mode-error">
          {problemDetail(saveError)}
        </Alert>
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

/** MANAGED ELSEWHERE — READ-ONLY NOTES, NO EDIT CONTROLS. See docs/web.md §379. */
export const MANAGED_ELSEWHERE = [
  {
    id: "freezes",
    title: "Freeze windows",
    where:
      "Declared per object in the governance surface, never per outpost — a freeze names a scope in the " +
      "org's graph, and one service-scoped freeze reaches every region under it. A freeze declared at the " +
      "commander reaches this outpost only if it was declared federating; otherwise it stays where it was " +
      "declared."
  },
  {
    id: "local-registry",
    title: "Outpost-local Gitea / registry",
    // Spec §4E: milestone/ADR codes leave rendered copy (was "(M15, ADR-0010)") — created or
    // imported at the outpost (M15, ADR-0010).
    where:
      "Created or imported at the outpost — the commander has no writable model for it, so it's " +
      "configured there."
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
  // `isAbsent`, not `=== null` / `!== null`. See docs/web.md §380.
  const adopted = isAbsent(result.adoptedObjectId) ? null : result.adoptedObjectId;
  // …and the two id lists are required-not-optional, dereferenced for `.length` four times: a server
  // that omits either one threw a TypeError over the whole outcome panel, i.e. the operator saw
  // NOTHING about a destructive verb that had just run.
  const removedShadows = result.removedShadowObjectIds ?? [];
  const removedLocal = result.removedLocalObjectIds ?? [];
  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm"
      data-testid="reconcile-result"
    >
      <p>
        The binding now resolves to <code>{result.config.objectId}</code>.
      </p>
      {adopted !== null && (
        <p className="mt-2 text-slate-700" data-testid="reconcile-adopted">
          Adopted <code>{adopted}</code> as this domain&apos;s own configuration — it journals down
          to the outpost from now on.
        </p>
      )}
      {removedShadows.length > 0 && (
        <p className="mt-2 text-slate-700" data-testid="reconcile-removed-shadows">
          Removed {removedShadows.length} unverified hand-filled shadow
          {removedShadows.length === 1 ? "" : "s"} — <strong>a local cleanup only</strong>; this
          domain never authored them, so nothing rode the journal and nothing downstream saw it.
        </p>
      )}
      {removedLocal.length > 0 && (
        <Alert tone="danger" className="mt-2" data-testid="reconcile-removed-local">
          Removed {removedLocal.length} configuration object
          {removedLocal.length === 1 ? "" : "s"} <strong>this domain authored</strong> — an ordinary
          journaled tombstone that <strong>PROPAGATES downstream</strong>: the outpost will drop its
          replica on the next sync.
        </Alert>
      )}
      {removedShadows.length === 0 && removedLocal.length === 0 && adopted === null && (
        <p className="mt-2 text-slate-600" data-testid="reconcile-removed-none">
          Nothing needed removing.
        </p>
      )}
    </div>
  );
}

/** One dropped row's consequence, stated before the button that would cause it is ever pressed.
 *  Shared by the per-claimant preview and the default block's preview (spec §2.3 Alert). */
function RemovalPreviewAlert({
  entry
}: {
  entry: { config: OutpostConfig; outcome: RemovalOutcome };
}): React.JSX.Element {
  const copy = OUTCOME_COPY[entry.outcome];
  return (
    <Alert
      tone={copy.tone}
      className="text-xs"
      data-testid="reconcile-removal-preview"
      data-outcome={entry.outcome}
      title={
        <>
          <code>{entry.config.objectId}</code> — {copy.label}
        </>
      }
    >
      {copy.detail}
    </Alert>
  );
}

/** THE RECONCILE PANEL. See docs/web.md §381. */
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
  // THE DEFAULT IS OFFERED ONLY WHERE IT CANNOT BE THE DESTRUCTIVE CHOICE. See docs/web.md §382.
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
      <Alert tone="warning" title="Authority conflict">
        {claimants.length} live configuration objects are bound to this outpost. The binding is
        meant to be 1:1, so ordinary edits are refused (409) until one row survives. This is not
        &quot;no configuration&quot; — it is too much of it.
      </Alert>

      {claimants.map((claimant) => {
        const preview = removalPreview(claimants, claimant.objectId, ownDomainId);
        const refused = preview.some((entry) => entry.outcome === "refused");
        const propagates = preview.some((entry) => entry.outcome === "propagates-downstream");
        const needsConfirm = propagates && confirmed !== claimant.objectId;
        return (
          <div
            key={claimant.objectId}
            className="rounded-lg border border-slate-200 p-3"
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
                <RemovalPreviewAlert key={entry.config.objectId} entry={entry} />
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
          className="rounded-lg border border-slate-200 p-3"
          data-testid="reconcile-default-block"
          data-keep={defaultKeep.objectId}
        >
          <div className="text-sm text-slate-700">
            The most authoritative row is <code>{defaultKeep.objectId}</code>. Reconciling with it
            would do this:
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {defaultPreview.map((entry) => (
              <RemovalPreviewAlert key={entry.config.objectId} entry={entry} />
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
          <strong>No default is offered for this conflict.</strong> Either two of these rows hold
          the same authority — the server breaks that tie by creation order, so this side cannot say
          which would survive and will not preview a guess — or reconciling would drop configuration
          this domain authored, whose removal <strong>propagates to the outpost</strong>. Choose the
          row that should survive above, where the consequence is stated per row.
        </p>
      )}

      {reconcileError !== undefined && reconcileError !== null && (
        <Alert tone="danger" data-testid="reconcile-error">
          {problemDetail(reconcileError)}
        </Alert>
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

/** The wired-up Configuration card. See docs/web.md §383. */
export function OutpostConfigurationSection({
  status,
  selfDomain
}: {
  status?: FederationPeerStatus;
  /** §10.5 — this instance's own domain (`GET /federation/self` / status `self`), for the
   *  HQ outpost. `role` is `federation_self.role`: the declare card offers the write only
   *  for `commander`, the one role the server's self-shape door accepts. */
  selfDomain?: { domainId: string; name: string; role: FederationRole };
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { domainId: ownDomainId } = useOwnDomainId();
  const peerDomainId = status?.peer.id ?? selfDomain?.domainId ?? "";

  // The LIST, not the single-object GET: a peer with two claimant rows is exactly the conflict the
  // reconcile verb exists for, and the single GET resolves it away before a client can see it.
  const configsQuery = useQuery({
    queryKey: outpostConfigListKey(),
    queryFn: () => client.federation.listOutposts()
  });
  const claimants = claimantsForPeer(configsQuery.data, peerDomainId);
  const conflict = claimants.length > 1;
  const config = claimants[0];
  /** Hazard closed: the editor was gated on existence alone. See docs/web.md §384. */
  const peerConfigRoleOk = status === undefined || status.peer.role === "outpost";

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: outpostConfigListKey() });
    await queryClient.invalidateQueries({ queryKey: federationStatusKey() });
  };

  /** The same premise the reconcile attaches, on the other door. See docs/web.md §385. */
  const tierMutation = useMutation({
    mutationFn: (input: { tier: OutpostTrustTier; expectedVersion: number }) =>
      client.federation.updateOutpost(peerDomainId, {
        trustTier: input.tier,
        expectedVersion: input.expectedVersion
      }),
    onSuccess: invalidate,
    // Mirrors reconcile's onError: a 412 means the row on screen is stale, so refetch it rather
    // than leaving the operator staring at the version they just tried (and failed) to overwrite.
    onError: (err: unknown) => {
      if (err instanceof ScpApiError && err.status === 412) void invalidate();
    }
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
  /** The precondition, attached where every reconcile passes. See docs/web.md §386. */
  const reconcileMutation = useMutation({
    mutationFn: (keep: string | undefined) =>
      client.federation.reconcileOutpost(peerDomainId, {
        ...(keep !== undefined ? { keep } : {}),
        // Guarded because an EMPTY set is not expressible on the wire (a query parameter repeated
        // zero times is absence, which means "unchecked"): sending one for a peer whose claimants
        // have not loaded would silently downgrade to the unguarded call. No control that triggers
        // this mutation renders before they load, so this is a floor, not a live branch.
        ...(claimants.length > 0 ? { ifClaimants: claimants.map(formatOutpostClaimantToken) } : {})
      }),
    onSuccess: invalidate,
    // A precondition failure means the list on screen is stale. See docs/web.md §387.
    onError: (err: unknown) => {
      if (reconcileStaleClaimants(err) !== null) void invalidate();
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          {status ? (
            status.peer.role === "retrans" ? (
              <>
                A <strong>retrans</strong> peer holds no commander-declared outpost configuration:
                an <code>outpost</code> config object binds only to a peer whose federation role is{" "}
                <code>outpost</code> (400 otherwise — ADR-0004). Only poke-mode below applies to it,
                and is <strong>this side only</strong>.
              </>
            ) : (
              <>
                Commander-declared configuration for this outpost. It is an ordinary graph object,
                so it rides the sync journal down and lands at the outpost as a read-only replica.
                Poke-mode below is a peer-row flag and is <strong>this side only</strong>.
              </>
            )
          ) : (
            <>
              Commander-declared configuration for the <strong>HQ outpost</strong> — this
              instance&apos;s own trust domain, registered as an outpost. It is an ordinary graph
              object; there is no peer row behind it, so there is no transport, sync or poke-mode to
              configure here.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {configsQuery.isLoading && <SkeletonRows n={3} />}

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

        {!conflict && config && peerConfigRoleOk && (
          <TrustTierCard
            key={`${config.objectId}:${config.version}`}
            config={config}
            ownDomainId={ownDomainId}
            saveError={tierMutation.error}
            isSaving={tierMutation.isPending}
            onSave={(tier) => tierMutation.mutate({ tier, expectedVersion: config.version })}
            onReconcile={() => reconcileMutation.mutate(undefined)}
          />
        )}
        {/* The MEASURED refusal (`assertOutpostPeerBinding`, ADR-0004) for a stray config object
            whose peer's role is no longer `outpost` — rendered instead of an editor the server would
            400. `status` is defined whenever `peerConfigRoleOk` is false (it is the only source of a
            non-`outpost` role), so this branch and `peerConfigRoleOk` can never disagree about which
            role to show. */}
        {!conflict && config && !peerConfigRoleOk && status && (
          <ConfigRoleNotOutpostNotice role={status.peer.role} />
        )}
        {!conflict && config && reconcileMutation.data && (
          <ReconcileOutcome result={reconcileMutation.data} />
        )}
        {!conflict && config && reconcileMutation.error !== null && (
          <Alert tone="danger" data-testid="reconcile-error">
            {problemDetail(reconcileMutation.error)}
          </Alert>
        )}

        {!conflict && !config && configsQuery.isSuccess && (
          <DeclareConfigCard
            {...(status
              ? { peer: status.peer }
              : { coLocated: true, ...(selfDomain ? { selfRole: selfDomain.role } : {}) })}
            createError={createMutation.error}
            isCreating={createMutation.isPending}
            onCreate={(tier) => createMutation.mutate(tier)}
          />
        )}
        {configsQuery.isError && !isNotFound(configsQuery.error) && (
          <Alert tone="danger" data-testid="config-load-error">
            {problemDetail(configsQuery.error)}
          </Alert>
        )}

        {status && (
          <>
            <hr className="border-slate-200" />
            <PokeModeCard
              status={status}
              saveError={pokeMutation.error}
              isSaving={pokeMutation.isPending}
              onToggle={(next) => pokeMutation.mutate(next)}
            />
          </>
        )}

        {/* Freeze windows, the outpost-local Gitea/registry, and bundled backends are OUTPOST
            concepts — none of the three exists at a CDS-boundary retrans, which runs no local
            Gitea/registry, no executor coordination and no deploy machinery (M13.1). Shown for an
            outpost row and the self/HQ outpost (both real outposts); withheld for a retrans peer
            rather than rendered as if it applied. */}
        {(!status || status.peer.role !== "retrans") && (
          <>
            <hr className="border-slate-200" />
            <ManagedElsewhereNotes />
          </>
        )}
      </CardContent>
    </Card>
  );
}
