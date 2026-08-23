import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScpApiError } from "@scp/sdk";
import type {
  DeliveryTarget,
  FederationPeer,
  SyncScope,
  UpdateFederationPeerRequest
} from "@scp/schemas";
import { client } from "../lib/client";
import { federationStatusKey } from "../lib/query-client";
import { cn, focusRing } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Alert } from "../components/ui/alert";
import { SectionLabel } from "../components/ui/section-label";

/**
 * M16.2 phase B (B2) — PER-OUTPOST SETTINGS: the `federation_peers` ROW half of the authority split
 * (ADR-0022 clause 1). Identity, mTLS/transport, reachability. Local to this side, never journaled.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT: it writes through
 * `PATCH /v1/federation/peers/{id}` — the structurally KEYLESS door — and never through
 * `POST /federation/peers`. A re-pair REQUIRES `publicKey`, and a DIFFERENT value there is a KEY
 * ROTATION that supersedes the current key window and hard-revokes the old key at the
 * applied-sequence anchor. A settings form built on the pair route rotates a peer's trust anchor the
 * first time it drops or mangles the key — silently, with a 200. Phase A built the keyless PATCH for
 * exactly this form; using it is not an optimisation, it is the requirement.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE:
 *   * `role` — an identity-level assertion made at pairing (the PATCH body has no `role` at all;
 *     `peer-patch.integration.test.ts` measures a smuggled `role` being ignored).
 *   * key material — see above. Rotation stays a deliberate CLI re-pair.
 *   * `pokeMode` — it IS a peer-row field and the same PATCH carries it, but it is CONSENT-shaped and
 *     belongs with the other per-outpost configuration (B3, `outpost-configuration.tsx`), where it can
 *     be labelled "this side only" next to the unilateral-sparse warning. Two forms writing one field
 *     from two places is how a UI ends up disagreeing with itself.
 *   * an `s3-compatible` delivery target — its endpoint/bucket are operator-allowlisted
 *     (`SCP_DELIVERY_S3_ENDPOINTS`) and its credentials live in the vault; this form would have to
 *     round-trip a shape it cannot fully render, and a partial round-trip REPLACES the stored target.
 *     It is shown read-only with a pointer to the CLI, and the patch OMITS the field so the server
 *     preserves it.
 */

/** The transport keys this form may ever send. Deliberately a runtime value, not a comment: the test
 *  asserts it is a SUBSET of `UpdateFederationPeerRequestSchema`'s own keys, so if the request body
 *  ever grows something key-shaped this list cannot silently start carrying it. */
export const PEER_SETTINGS_PATCH_KEYS = ["name", "baseUrl", "syncScope", "deliveryTarget"] as const;

/** The four sync-scope modes this form can SET. `custom` is absent on purpose: it carries a
 *  `labelSelector` this form has no editor for, and offering it would mean writing `{mode:'custom'}`
 *  with an empty selector — a silent narrowing of what the peer receives. A peer already on `custom`
 *  keeps it (the mode select shows it, and an unchanged mode OMITS `syncScope` entirely, which the
 *  server reads as preserve). */
export const SETTABLE_SYNC_SCOPE_MODES = [
  "full",
  "policies_only",
  "changes_only",
  "status_only"
] as const;

/**
 * THE PEER'S CURRENT SYNC-SCOPE MODE, or `undefined` when the server did not send `syncScope` (Y4).
 *
 * `syncScope` is required-not-optional on `FederationPeer`, and BEFORE ADR-0023 the generated SDK
 * validated NO response, so `peer.syncScope.mode` was a bare dereference of a field nothing
 * enforced at runtime — the SAME read that white-screened the outposts pages, and here it would
 * kill the Settings form (and with it the only door an operator has to fix the peer).
 *
 * WHAT ADR-0023 CHANGED, AND WHAT IT DID NOT — the canonical statement of the rule, since this
 * comment is the one the ADR cites. The SDK now runs a generated zod schema over every 2xx JSON
 * body of every SPEC'D operation, so a body missing `syncScope` no longer RESOLVES a query: it
 * REJECTS it, once, naming the operation and the field. Three consequences, all live:
 *   1. A required field arriving through the SDK is now enforced at runtime, so a guard like this
 *      one is defence in depth rather than the only thing standing between a page and a TypeError.
 *   2. The failure moved, it did not vanish. Every page that reads through the SDK must render its
 *      `isError` state, or the diagnosis dies in the query cache and the operator sees a blank
 *      card — the regression this round fixed (`../components/query-error.tsx`).
 *   3. THE BOUND IS THE SPEC'D OPERATIONS — which, since the SSE API-parity work, is every byte the
 *      SPA parses off the network. `GET /events/stream` was the one exception (absent from
 *      `openapi.v1.json`, so `lib/use-event-stream.ts` cast raw JSON); it is declared now, and each
 *      frame is validated by the same generated validator as any 2xx body.
 *
 * `undefined` RATHER THAN A DEFAULT, deliberately. Substituting `"full"` would be the fabrication
 * class this whole branch exists to remove: it would tell the operator the peer exports everything,
 * and — because the patch builder omits an UNCHANGED mode — a form left alone would silently keep
 * whatever the real scope is while displaying a different one. An unknown mode is unknown.
 */
export function peerSyncScopeMode(peer: FederationPeer): SyncScope["mode"] | undefined {
  return (peer.syncScope as SyncScope | undefined)?.mode;
}

/** The select's value when the server never told us the current mode. Not a mode — the empty string
 *  cannot be sent, and `peerSettingsPatch` refuses to build a `syncScope` from it. */
export const SYNC_SCOPE_UNREPORTED = "" as const;

export interface PeerSettingsDraft {
  name: string;
  baseUrl: string;
  /** `""` ⇒ the server did not report a scope and the operator has not chosen one. */
  syncScopeMode: SyncScope["mode"] | typeof SYNC_SCOPE_UNREPORTED;
  outDir: string;
  inDir: string;
  /** Explicit, because `deliveryTarget: null` is the only CLEAR verb the contract has and inferring
   *  it from two emptied text boxes would make an accidental blank a destructive write. */
  clearDeliveryTarget: boolean;
}

function deliveryDir(peer: FederationPeer, key: "outDir" | "inDir"): string {
  const target = peer.deliveryTarget;
  if (!target || target.provider !== "filesystem") return "";
  return (target as { outDir?: string; inDir?: string })[key] ?? "";
}

export function isS3DeliveryTarget(peer: FederationPeer): boolean {
  return peer.deliveryTarget?.provider === "s3-compatible";
}

export function draftFromPeer(peer: FederationPeer): PeerSettingsDraft {
  return {
    name: peer.name,
    baseUrl: peer.baseUrl ?? "",
    syncScopeMode: peerSyncScopeMode(peer) ?? SYNC_SCOPE_UNREPORTED,
    outDir: deliveryDir(peer, "outDir"),
    inDir: deliveryDir(peer, "inDir"),
    clearDeliveryTarget: false
  };
}

/**
 * THE PATCH BODY, built from the draft — ABSENT MEANS PRESERVE, everywhere.
 *
 * Every unchanged field is OMITTED rather than echoed back. That is not tidiness: echoing
 * `syncScope` back would flatten a `custom` scope's `labelSelector` (this form cannot render one),
 * and re-declaring a scope of `full` fires the G8 cursor-re-anchor permit for a save that changed
 * only the peer's display name.
 *
 * The returned object is typed `UpdateFederationPeerRequest`, which HAS NO KEY FIELDS — so this
 * function is incapable of expressing a rotation even if it wanted to.
 */
export function peerSettingsPatch(
  peer: FederationPeer,
  draft: PeerSettingsDraft
): UpdateFederationPeerRequest {
  const patch: UpdateFederationPeerRequest = {};

  const name = draft.name.trim();
  if (name.length > 0 && name !== peer.name) patch.name = name;

  const baseUrl = draft.baseUrl.trim();
  // There is deliberately no clear-to-null for `baseUrl` in the contract (an effective poke-mode peer
  // must keep an https base URL), so an emptied box means "leave it alone", not "unset it".
  if (baseUrl.length > 0 && baseUrl !== (peer.baseUrl ?? "")) patch.baseUrl = baseUrl;

  // `custom` is not settable here (no label-selector editor), and `""` is not a mode at all — it is
  // the marker for "the server did not report one", so it must never become a write.
  if (
    draft.syncScopeMode !== peerSyncScopeMode(peer) &&
    draft.syncScopeMode !== "custom" &&
    draft.syncScopeMode !== SYNC_SCOPE_UNREPORTED
  ) {
    patch.syncScope = { mode: draft.syncScopeMode };
  }

  if (draft.clearDeliveryTarget) {
    // Only meaningful when there is one to clear; `null` on a peer that has none is a no-op the
    // server would happily accept, but sending it would make an untouched form a write.
    if (peer.deliveryTarget) patch.deliveryTarget = null;
  } else if (!isS3DeliveryTarget(peer)) {
    const outDir = draft.outDir.trim();
    const inDir = draft.inDir.trim();
    if (outDir.length > 0 || inDir.length > 0) {
      const next: DeliveryTarget = {
        provider: "filesystem",
        ...(outDir.length > 0 ? { outDir } : {}),
        ...(inDir.length > 0 ? { inDir } : {})
      };
      const current = peer.deliveryTarget;
      const unchanged =
        current?.provider === "filesystem" &&
        (current as { outDir?: string }).outDir === next.outDir &&
        (current as { inDir?: string }).inDir === next.inDir;
      if (!unchanged) patch.deliveryTarget = next;
    }
  }

  return patch;
}

/** The subset of the generated SDK's federation surface this form is allowed to touch. Typed as a
 *  structural interface so a test can hand in a double that ALSO exposes `pair` and then assert that
 *  `pair` was never reached — the failure mode being guarded against is a form that re-pairs. */
export interface PeerTransportDoors {
  updatePeer(id: string, req: UpdateFederationPeerRequest): Promise<FederationPeer>;
}

/**
 * The ONE function the Save button runs: build the body, then send it through the keyless PATCH.
 *
 * Build and send live together on purpose. Testing them apart would leave the join — "the form sends
 * what the builder built, through the door the builder was written for" — unpinned, which is exactly
 * where a re-pair could slip back in.
 */
export async function savePeerSettings(
  doors: PeerTransportDoors,
  peer: FederationPeer,
  draft: PeerSettingsDraft
): Promise<{ peer: FederationPeer; patch: UpdateFederationPeerRequest }> {
  const patch = peerSettingsPatch(peer, draft);
  const updated = await doors.updatePeer(peer.id, patch);
  return { peer: updated, patch };
}

/** The server's own words for a refusal. The pair-time guards (poke-mode⇒mTLS over the EFFECTIVE
 *  post-write tuple, the delivery-target allowlists) all answer 400 with an actionable `detail`, and
 *  swallowing it for a generic "save failed" would leave an operator with no way to know that their
 *  http base URL was refused because poke-mode is on. */
export function problemDetail(err: unknown): string {
  if (err instanceof ScpApiError) return err.problem?.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

function LabelledField({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <SectionLabel as="span">{label}</SectionLabel>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

const selectClass = cn(
  "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm",
  focusRing
);

/**
 * The Settings form. EXPORTED for `outpost-settings.test.tsx`, which renders it directly — the
 * "no key material, no role" property is a rendering property as much as a request-body one.
 *
 * `onSave` is injected so the test can drive the real submit path against a double; the page below
 * passes the real SDK.
 */
export function PeerSettingsCard({
  peer,
  saveError,
  isSaving = false,
  onSave
}: {
  peer: FederationPeer;
  saveError?: unknown;
  isSaving?: boolean;
  onSave: (draft: PeerSettingsDraft) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<PeerSettingsDraft>(() => draftFromPeer(peer));
  const patch = peerSettingsPatch(peer, draft);
  const nothingToSave = Object.keys(patch).length === 0;
  const currentMode = peerSyncScopeMode(peer);
  // An UNREPORTED scope gets a leading non-mode option so the select has something honest to show.
  // It is not offered as a choice the operator can save back: `peerSettingsPatch` refuses it.
  const modeOptions: (SyncScope["mode"] | typeof SYNC_SCOPE_UNREPORTED)[] =
    currentMode === undefined
      ? [SYNC_SCOPE_UNREPORTED, ...SETTABLE_SYNC_SCOPE_MODES]
      : currentMode === "custom"
        ? ["custom", ...SETTABLE_SYNC_SCOPE_MODES]
        : [...SETTABLE_SYNC_SCOPE_MODES];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>
          This outpost&apos;s <strong>peer row</strong>: identity and transport. Local to this
          instance and never journaled — nothing here is sent to the outpost. Saved through the
          keyless peer PATCH, which carries no key material at all.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          data-testid="peer-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(draft);
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <LabelledField label="Name" hint="A rename onto another peer's name is refused (409).">
              <Input
                name="name"
                data-testid="peer-name-input"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </LabelledField>

            <LabelledField
              label="Base URL"
              hint="https/mTLS to be dialable. Emptying the box preserves the stored value — there is no clear-to-null."
            >
              <Input
                name="baseUrl"
                data-testid="peer-base-url-input"
                value={draft.baseUrl}
                placeholder="https://outpost.example.net"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </LabelledField>

            <LabelledField
              label="Sync scope"
              hint="What this side exports to the peer. A `custom` label-selector scope can be kept but is not editable here."
            >
              <select
                name="syncScope"
                data-testid="peer-sync-scope-select"
                className={selectClass}
                value={draft.syncScopeMode}
                onChange={(event) =>
                  setDraft({ ...draft, syncScopeMode: event.target.value as SyncScope["mode"] })
                }
              >
                {modeOptions.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode === SYNC_SCOPE_UNREPORTED ? "not reported by this server" : mode}
                  </option>
                ))}
              </select>
            </LabelledField>

            {/* ROLE — READ-ONLY. Not a styling choice: the PATCH body has no `role` field, because a
                peer's federation role is an identity-level assertion made at pairing. */}
            <LabelledField
              label="Role"
              hint="Set at pairing and not editable here — a peer's federation role is an identity-level assertion."
            >
              <div
                className="flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600"
                data-testid="peer-role-readonly"
              >
                {peer.role}
              </div>
            </LabelledField>
          </div>

          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-slate-500">
              Delivery target (air-gap / file channel)
            </legend>
            {isS3DeliveryTarget(peer) ? (
              <p className="text-sm text-slate-600" data-testid="peer-delivery-s3-readonly">
                An <code>s3-compatible</code> target is configured (
                {(peer.deliveryTarget as { endpoint?: string }).endpoint} /{" "}
                {(peer.deliveryTarget as { bucket?: string }).bucket}). Its endpoint and bucket are
                operator-allowlisted and its credentials live in the vault, so it is edited with{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5">scp federation pair</code> rather
                than here. Saving this form leaves it untouched.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <LabelledField label="Outbound directory">
                  <Input
                    name="outDir"
                    data-testid="peer-out-dir-input"
                    value={draft.outDir}
                    disabled={draft.clearDeliveryTarget}
                    onChange={(event) => setDraft({ ...draft, outDir: event.target.value })}
                  />
                </LabelledField>
                <LabelledField label="Inbound directory">
                  <Input
                    name="inDir"
                    data-testid="peer-in-dir-input"
                    value={draft.inDir}
                    disabled={draft.clearDeliveryTarget}
                    onChange={(event) => setDraft({ ...draft, inDir: event.target.value })}
                  />
                </LabelledField>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    name="clearDeliveryTarget"
                    data-testid="peer-clear-delivery-target"
                    checked={draft.clearDeliveryTarget}
                    onChange={(event) =>
                      setDraft({ ...draft, clearDeliveryTarget: event.target.checked })
                    }
                  />
                  Clear the per-peer target and fall back to this instance&apos;s relay directories
                </label>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Directories must sit under an operator-declared root (<code>SCP_DELIVERY_ROOTS</code>
              ); anything else is refused before it is stored.
            </p>
          </fieldset>

          {/* KEY MATERIAL — DISPLAY ONLY, AND SAID OUT LOUD. There is no input for it anywhere in
              this form, and the door this form writes through cannot carry one. */}
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <SectionLabel>Registered signing key</SectionLabel>
            <div
              className="mt-1 truncate font-mono text-xs text-slate-700"
              title={peer.publicKey}
              data-testid="peer-public-key-readonly"
            >
              {peer.publicKey}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Saving these settings never touches this key. Rotating it is a deliberate re-pair (
              <code className="rounded bg-slate-100 px-1 py-0.5">scp federation pair</code>) — a
              re-pair with a different key supersedes this window and hard-revokes the old key.
            </p>
          </div>

          {saveError !== undefined && saveError !== null && (
            <Alert tone="danger" data-testid="peer-settings-error">
              {problemDetail(saveError)}
            </Alert>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={isSaving || nothingToSave}
              data-testid="peer-settings-save"
            >
              {isSaving ? "Saving…" : "Save settings"}
            </Button>
            {nothingToSave && (
              <span className="text-xs text-slate-500" data-testid="peer-settings-unchanged">
                No changes to save.
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The wired-up card: the same component, driven by the real SDK. */
export function PeerSettingsSection({ peer }: { peer: FederationPeer }): React.JSX.Element {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (draft: PeerSettingsDraft) => savePeerSettings(client.federation, peer, draft),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: federationStatusKey() })
  });

  return (
    <PeerSettingsCard
      key={`${peer.id}:${peer.name}:${peer.baseUrl ?? ""}`}
      peer={peer}
      saveError={mutation.error}
      isSaving={mutation.isPending}
      onSave={(draft) => mutation.mutate(draft)}
    />
  );
}
