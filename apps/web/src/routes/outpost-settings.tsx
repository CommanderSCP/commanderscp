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

/** M16.2 phase B (B2) — PER-OUTPOST SETTINGS. See docs/web.md §398. */

/** The transport keys this form may ever send. Deliberately a runtime value, not a comment: the test
 *  asserts it is a SUBSET of `UpdateFederationPeerRequestSchema`'s own keys, so if the request body
 *  ever grows something key-shaped this list cannot silently start carrying it. */
export const PEER_SETTINGS_PATCH_KEYS = ["name", "baseUrl", "syncScope", "deliveryTarget"] as const;

/** The four sync-scope modes this form can SET. See docs/web.md §399. */
export const SETTABLE_SYNC_SCOPE_MODES = [
  "full",
  "policies_only",
  "changes_only",
  "status_only"
] as const;

/** The peer's current sync-scope mode, or undefined. See docs/web.md §400. */
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

/** THE PATCH BODY, built from the draft. See docs/web.md §401. */
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

/** The ONE function the Save button runs. See docs/web.md §402. */
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

/** The Settings form. See docs/web.md §403. */
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
  // THE NOUN, ROLE-AWARE — this IS the peer row for a retrans peer too (identity, transport,
  // reachability all apply to it exactly as to an outpost; only the word naming it was wrong).
  const isRetrans = peer.role === "retrans";
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
          This {isRetrans ? "retrans peer's" : "outpost's"}{" "}
          <strong>{isRetrans ? "row" : "peer row"}</strong>: identity and transport. Local to this
          instance and never journaled — nothing here is sent to the{" "}
          {isRetrans ? "peer" : "outpost"}. Saved through the keyless peer PATCH, which carries no
          key material at all.
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
