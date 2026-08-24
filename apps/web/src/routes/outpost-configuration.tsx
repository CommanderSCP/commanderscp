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
  // `?? []` — `unknownFields` is required-not-optional by `OutpostConfigSchema`, and BEFORE ADR-0023
  // the generated SDK validated NO response, so a server that omitted the key made this dereference
  // throw a TypeError and BLANK THE WHOLE PANEL. Under the very response shape the guard below
  // exists for, that is worse than the unknown it was meant to render: fail loud beats fail
  // dishonest, but a white screen is neither. SINCE ADR-0023 that body is rejected at the SDK
  // boundary instead and the page's `isError` branch names the operation and the field; the guard
  // stays because "nothing declared" is the same reading `isPeerUnknown` gives an older server, for
  // any source of a config that is not this query.
  const tierUnknown = (config.unknownFields ?? []).includes("trustTier");
  // TWO INDEPENDENT SIGNALS FOR ONE FACT, OR'd — the same fix `outposts.tsx`'s `TrustTierCell` got,
  // applied to the file whose own commit is titled "guard both, everywhere" and which had been given
  // only the ownDomainId-load half of it.
  //
  //   * `provenance === "manual"` ALONE, not `foreign && …`. A `"manual"` row IS an unverified
  //     hand-filled shadow by the schema's own definition — its origin adds nothing. Worse,
  //     `isConfigForeign` answers FALSE while `ownDomainId` is still loading and the server omitted
  //     `originIsSelf`: deliberately the right answer for a WRITE gate (never fabricate a block on a
  //     write the server would accept) and the wrong one for a DISPLAY discriminator.
  //   * A TIER THAT RIDES THE WIRE WHILE THE SERVER DECLARES IT UNOBSERVABLE. `toOutpostConfig`
  //     pushes `"trustTier"` into `unknownFields` in exactly two cases: no tier at all, or
  //     `provenance === "manual"`. So a config that HAS a tier and declares it unknown IS the shadow
  //     case — with the OPTIONAL `provenance` key merely omitted. ADR-0023 does NOT close this one:
  //     `provenance` is `.nullable().optional()`, so an omitted key is CONTRACT-LEGAL and passes
  //     response validation untouched. MEASURED: keyed on provenance alone, such a row rendered
  //     BYTE-IDENTICAL to a signature-verified replica of the same tier — `data-tier-unverified="false"`,
  //     no shadow notice. `!isAbsent(config.trustTier) &&` is load-bearing and is what keeps this from
  //     over-blocking: an ordinary locally-authored config with NO tier yet also declares `trustTier`
  //     unknown, and must stay fully editable — that is the whole declare-then-set flow.
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
 *  the create control is not offered for one rather than offered and refused — OR (§10.5) to THIS
 *  instance's own trust domain, the HQ outpost (formerly "co-located" — GLOSSARY, ADR-0021 D7;
 *  the `coLocated` prop and test ids keep the older spelling): `coLocated` renders that case, for which
 *  there is no peer row; the role checked is THIS instance's own (`selfRole`, `federation_self.role`),
 *  which must be `commander` — an outpost's own record is commander-declared and arrives replicated,
 *  and the server 400s the self shape on any other role (MEASURED —
 *  `outpost-config-sync.integration.test.ts`, before and after the replica arrives). */
/**
 * THE REFUSAL `POST /federation/outposts` MIRRORS, SHARED. `outpost-binding.ts`'s
 * `REQUIRED_PEER_ROLE` refuses (400) to bind an `outpost` config object to any peer whose role is
 * not `outpost` — on CREATE (`DeclareConfigCard`, below) and, unchanged, on UPDATE of an existing
 * object (`assertOutpostPeerBinding` runs on both doors). So the same sentence covers two distinct
 * moments: no config object exists yet for a non-outpost peer, AND a config object exists but its
 * peer's role no longer is one (e.g. changed post-declare) — a stray row the edit door will 400 on
 * confusingly if offered a live Save button. One refusal, read from the same measured 400
 * (`outpost-object.integration.test.ts`; ADR-0004), rendered wherever that door would fire.
 */
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
  // `isAbsent`, not `=== null` / `!== null` — the SAME schema class this file already fixed for
  // `config.trustTier`, left half-guarded here. `adoptedObjectId` is required-nullable, and BEFORE
  // ADR-0023 the SDK validated no response, so `undefined` was reachable through the SDK too; SINCE
  // ADR-0023 an omitted required key rejects at the boundary and this is defence in depth for every
  // other source of a result. MEASURED with `adoptedObjectId: undefined`:
  // `!== null` was TRUE, so the panel emitted
  //   `<p data-testid="reconcile-adopted">Adopted <code></code> as this domain's own configuration —
  //    it journals down to the outpost from now on.</p>`
  // — an EMPTY element inside a confident claim about a journaling side-effect — while the `=== null`
  // mirror below simultaneously suppressed the honest `reconcile-removed-none` branch, so the panel
  // reported an adoption that did not happen AND withheld the statement that nothing did.
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

/**
 * The wired-up Configuration card — for a PAIRED PEER (`status`, the peer-status row) or, since
 * pipeline-substrate-registry-scan.md §10.5, for THIS INSTANCE'S OWN DOMAIN (`selfDomain`): the
 * HQ outpost, whose record binds `peerDomainId` = this instance's domain id and has NO peer
 * row. Exactly one of the two is given. The config half (declare / tier / reconcile) is identical
 * for both — it keys on the domain id alone; the poke-mode card is a PEER-ROW flag and is rendered
 * only for a peer (there is no peer row to flag for self, and an instance never pokes itself).
 */
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
  /**
   * HAZARD, CLOSED — the tier editor used to be gated only on a config OBJECT existing, never on the
   * PEER's own role. `assertOutpostPeerBinding` refuses (400) an UPDATE against a peer whose role is
   * not `outpost` exactly as it refuses a CREATE (`outpost-binding.ts`, ADR-0004) — so a STRAY
   * config object bound to a retrans peer (role changed post-declare; nothing deletes the row when
   * that happens) rendered a live, clickable Save button the server would refuse confusingly. The
   * self/HQ path (`status` absent) carries no peer role at all and is untouched — this guards only
   * the peer path, on the SAME role the create door already checks.
   */
  const peerConfigRoleOk = status === undefined || status.peer.role === "outpost";

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: outpostConfigListKey() });
    await queryClient.invalidateQueries({ queryKey: federationStatusKey() });
  };

  /**
   * THE SAME PREMISE THE RECONCILE MUTATION ATTACHES, ON THIS PANEL'S OTHER WRITE DOOR (R2, PR
   * #156 residual). The operator reads a tier off `config` and edits it — a prediction from the
   * row on screen, exactly like reconcile's claimant preview — but until this fix the call carried
   * no `expectedVersion`, so a concurrent edit (another operator, or this same peer's `keep`
   * reconcile) was silently overwritten: `updateObject` has always accepted the precondition
   * (`packages/schemas/src/federation.ts`'s `UpdateOutpostConfigRequestSchema`), the PATCH route
   * has always declared its 412, and NOTHING on the write path needed to change — only this call
   * site was leaving its premise unstated. `config.version` is read from the same query result the
   * rendered form derives from, so the request cannot be checked against a different world than
   * the one on screen.
   */
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
  /**
   * THE PRECONDITION, ATTACHED WHERE EVERY RECONCILE THIS PANEL ISSUES PASSES THROUGH.
   *
   * The panel predicts an outcome from `claimants` and then asks the server to act — but the server
   * derives that outcome from the rows it reads INSIDE its own transaction, which is a different
   * moment. `?ifClaimant=<objectId>:<version>` is that prediction's premise, sent with the request
   * and compared as a set, so a world that moved is a 412 that WROTE NOTHING rather than a 200 that
   * did something else. Both failure directions are covered by this one attachment, which is why it
   * lives on the mutation and not on a button:
   *   * the ADOPT-SHADOW control below (`TrustTierCard`'s `onReconcile`) sends no `keep`, so the
   *     server re-derives the survivor — a locally-authored row that appeared since this query
   *     resolved outranks the shadow, and the operator's entered value is DROPPED while the button
   *     promised it would be kept;
   *   * naming the shadow with `keep` instead makes that same concurrent row surplus, and removing a
   *     row THIS domain authored journals a tombstone that PROPAGATES to the outpost — the removal
   *     this panel elsewhere refuses to perform without an explicit confirmation.
   *
   * The token is built from `claimants` — the exact array the preview above was computed from — so
   * the request cannot be checked against a different world than the one on screen.
   */
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
    // A 412 says the claimant list on screen is stale, so REFETCH it: the refusal's own text names
    // what moved, and the preview beside it must be the new world, not the one that was refused.
    //
    // R3 (PR #156 residual) — THIS PANEL REFETCHES; IT DOES NOT RE-RENDER THE CARRIED PREVIEW.
    // `reconcileStaleClaimants(err)` is used ONLY as a 412 detector here — its return value (the
    // fresh `claimants` the refusal carried) is discarded, and `invalidate()` opens a second round
    // trip and a second, if narrower, staleness window instead. `scp federation outpost reconcile`
    // (`packages/cli/src/cli.ts`) takes the other branch: it re-previews straight from the carried
    // list, no second read. Both are correct — a second stale press here is refused again, since the
    // refetch is what the next token derives from — but they are not the same behaviour, and the
    // "no second round trip" rationale on `preconditionFailed` (`apps/server/src/errors.ts`) and on
    // `OutpostReconcileStaleProblemSchema.claimants` (`packages/schemas/src/federation.ts`) describes
    // the CLI's path, not this one.
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
