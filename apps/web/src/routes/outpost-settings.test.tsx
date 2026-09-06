import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateFederationPeerRequestSchema } from "@scp/schemas";
import type { FederationPeer, UpdateFederationPeerRequest } from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";

/**
 * M16.2 phase B (B2) — THE SETTINGS FORM WRITES THROUGH THE KEYLESS DOOR, on every PR.
 *
 * THE DEFECT THIS PREVENTS. `POST /federation/peers` REQUIRES `publicKey` and treats a DIFFERENT
 * value as a KEY ROTATION: it supersedes the peer's current key window and hard-revokes the old key
 * at the applied-sequence anchor. A settings form that reads a peer, changes one field and re-pairs
 * therefore rotates that peer's trust anchor — with a 200, and no signal anywhere. Phase A built
 * `PATCH /v1/federation/peers/{id}` (structurally keyless) for this form; this file pins that the
 * form actually uses it.
 *
 * THE OTHER HALF OF THE PROOF is server-side, in
 * `apps/server/src/federation/peer-patch.integration.test.ts` ("B2: the WHOLE settings-form save …"),
 * which sends this form's full field set against a real Postgres and asserts `federation_peer_keys`
 * is byte-identical afterwards: no new window row, the existing row's `superseded_at` still NULL. The
 * two halves meet at `PEER_SETTINGS_PATCH_KEYS`, asserted below to be a subset of the PATCH body's
 * own schema — so the field set this form can send is checked against the contract rather than
 * against a comment.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  PEER_SETTINGS_PATCH_KEYS,
  PeerSettingsCard,
  draftFromPeer,
  peerSettingsPatch,
  problemDetail,
  savePeerSettings
} = await import("./outpost-settings");

const PEER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

function peerFixture(overrides: Partial<FederationPeer> = {}): FederationPeer {
  return {
    id: PEER_ID,
    name: "amer-prod",
    role: "outpost",
    baseUrl: "https://outpost.example.net",
    syncScope: { mode: "full" },
    publicKey: "MCowBQYDK2VwAyEAtestkeymaterial",
    pokeMode: false,
    pairedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

/** A double for the SDK's federation surface that ALSO exposes `pair` — so "the form never re-pairs"
 *  is a MEASURED absence rather than a type-level one. */
function doorsDouble(peer: FederationPeer) {
  return {
    updatePeer: vi.fn(async (id: string, req: UpdateFederationPeerRequest) => {
      void id;
      void req;
      return peer;
    }),
    pair: vi.fn(async () => peer)
  };
}

describe("peer settings: the body can only carry transport fields", () => {
  it("every key this form may send is a key the KEYLESS PATCH body declares", () => {
    const allowed = Object.keys(UpdateFederationPeerRequestSchema.shape);
    for (const key of PEER_SETTINGS_PATCH_KEYS) {
      expect(allowed, `${key} is a field of UpdateFederationPeerRequestSchema`).toContain(key);
    }
    // …and the contract itself carries no key material and no role, which is WHY this door is safe.
    expect(allowed).not.toContain("publicKey");
    expect(allowed).not.toContain("cosignPublicKey");
    expect(allowed).not.toContain("role");
    // `pokeMode` IS in the contract but is deliberately not this form's field (B3 owns it, labelled
    // "this side only"). Asserted so the split is a fact, not a convention.
    expect(allowed).toContain("pokeMode");
    expect(PEER_SETTINGS_PATCH_KEYS as readonly string[]).not.toContain("pokeMode");
  });

  it("a save sends the body through updatePeer and NEVER through pair", async () => {
    const peer = peerFixture();
    const doors = doorsDouble(peer);
    const draft = { ...draftFromPeer(peer), name: "amer-prod-renamed" };

    const { patch } = await savePeerSettings(doors, peer, draft);

    expect(doors.updatePeer).toHaveBeenCalledTimes(1);
    expect(doors.pair).not.toHaveBeenCalled();

    const [sentId, sentBody] = doors.updatePeer.mock.calls[0]!;
    expect(sentId).toBe(PEER_ID);
    expect(sentBody).toEqual(patch);
    // No key material can even reach the wire from here.
    expect(Object.keys(sentBody)).not.toContain("publicKey");
    expect(Object.keys(sentBody)).not.toContain("cosignPublicKey");
    expect(Object.keys(sentBody)).not.toContain("role");
    // …and the body is a valid instance of the keyless contract.
    expect(UpdateFederationPeerRequestSchema.safeParse(sentBody).success).toBe(true);
  });
});

describe("peer settings: absent means preserve", () => {
  it("an untouched form sends an EMPTY body — it cannot blank anything", () => {
    const peer = peerFixture({ deliveryTarget: { provider: "filesystem", outDir: "/relay/out" } });
    expect(peerSettingsPatch(peer, draftFromPeer(peer))).toEqual({});
  });

  it("a rename OMITS syncScope, so a `custom` label-selector scope survives it", () => {
    const peer = peerFixture({
      syncScope: { mode: "custom", labelSelector: { tier: "gold" } }
    });
    const patch = peerSettingsPatch(peer, { ...draftFromPeer(peer), name: "renamed" });

    expect(patch).toEqual({ name: "renamed" });
    // Echoing the mode back would write `{mode:'custom'}` with NO selector — a silent narrowing of
    // everything this peer receives — and re-declaring `full` would fire the G8 cursor re-anchor for
    // a save that changed a display name.
    expect(patch.syncScope).toBeUndefined();
  });

  it("PREMISE: an actual scope CHANGE is sent", () => {
    const peer = peerFixture({ syncScope: { mode: "custom", labelSelector: { tier: "gold" } } });
    const patch = peerSettingsPatch(peer, { ...draftFromPeer(peer), syncScopeMode: "status_only" });
    expect(patch).toEqual({ syncScope: { mode: "status_only" } });
  });

  it("an emptied base-URL box preserves the stored URL rather than clearing it", () => {
    const peer = peerFixture();
    const patch = peerSettingsPatch(peer, { ...draftFromPeer(peer), baseUrl: "   " });
    // The contract has no clear-to-null for `baseUrl` (an effective poke-mode peer must keep an
    // https one), so an emptied box must not become a write at all.
    expect(patch).toEqual({});
  });

  it("an s3-compatible delivery target is never round-tripped by this form", () => {
    const peer = peerFixture({
      deliveryTarget: {
        provider: "s3-compatible",
        endpoint: "https://minio.example.test:9000",
        bucket: "bundles"
      }
    });
    // A partial round-trip REPLACES the stored target; omitting the field preserves it.
    expect(peerSettingsPatch(peer, draftFromPeer(peer))).toEqual({});
    expect(
      peerSettingsPatch(peer, { ...draftFromPeer(peer), outDir: "/relay/out" }).deliveryTarget
    ).toBeUndefined();
  });

  it("clearing the delivery target is EXPLICIT, and a no-op when there is none", () => {
    const withTarget = peerFixture({
      deliveryTarget: { provider: "filesystem", outDir: "/relay/out" }
    });
    expect(
      peerSettingsPatch(withTarget, { ...draftFromPeer(withTarget), clearDeliveryTarget: true })
    ).toEqual({ deliveryTarget: null });

    const withoutTarget = peerFixture();
    expect(
      peerSettingsPatch(withoutTarget, {
        ...draftFromPeer(withoutTarget),
        clearDeliveryTarget: true
      })
    ).toEqual({});
  });
});

describe("peer settings: the rendered form", () => {
  function render(peer: FederationPeer, saveError?: unknown): string {
    return renderToStaticMarkup(
      <PeerSettingsCard peer={peer} saveError={saveError} onSave={() => {}} />
    );
  }

  /** The text an operator actually reads — every tag stripped out (so a match cannot be satisfied by
   *  an attribute or a `title` tooltip instead of the visible copy), the apostrophe entity
   *  `renderToStaticMarkup` emits for a literal `'` decoded back (so an assertion can be written the
   *  way the copy is actually read), and whitespace collapsed (tag stripping otherwise leaves doubled
   *  spaces at every element boundary, e.g. around <strong>). */
  function visibleText(html: string): string {
    return html
      .replace(/<[^>]*>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  it("offers no editor for role or for key material", () => {
    const html = render(peerFixture());

    // PREMISE: the form really does render editors, so these absences mean something.
    expect(html).toContain('name="name"');
    expect(html).toContain('name="baseUrl"');
    expect(html).toContain('name="syncScope"');

    // Role is displayed, never editable — the PATCH body has no `role` field at all.
    expect(html).toContain('data-testid="peer-role-readonly"');
    expect(html).not.toContain('name="role"');
    // No key input of any kind. A key box on this form is a rotation waiting to happen.
    expect(html).not.toContain('name="publicKey"');
    expect(html).not.toContain('name="cosignPublicKey"');
    expect(html).toContain('data-testid="peer-public-key-readonly"');
  });

  it("does not offer a filesystem editor over an s3 target", () => {
    const html = render(
      peerFixture({
        deliveryTarget: {
          provider: "s3-compatible",
          endpoint: "https://minio.example.test:9000",
          bucket: "bundles"
        }
      })
    );
    expect(html).toContain('data-testid="peer-delivery-s3-readonly"');
    expect(html).not.toContain('name="outDir"');
    expect(html).not.toContain('name="inDir"');
  });

  it("surfaces the server's own 400 detail, not a generic failure", () => {
    const refusal =
      "poke-mode requires an mTLS/https peer — the poke must authenticate the caller as the enrolled commander";
    const html = render(
      peerFixture(),
      new ScpApiError("Bad Request", {
        status: 400,
        problem: { type: "about:blank", title: "Bad Request", status: 400, detail: refusal }
      })
    );

    expect(html).toContain('data-testid="peer-settings-error"');
    // The ACTIONABLE half — an operator who sees only "save failed" cannot know that their http base
    // URL was refused because poke-mode is on for this peer.
    expect(html).toContain("poke-mode requires an mTLS/https peer");
  });

  it("names the peer row's owner with the right noun — outpost verbatim, retrans distinctly", () => {
    // The concepts (identity, transport, "local and never journaled") are real for a retrans peer
    // too — only the noun naming it was wrong. Outpost copy must stay byte-identical; retrans must
    // say so distinctly rather than call a retrans an "outpost".
    const outpostHtml = render(peerFixture({ role: "outpost" }));
    const retransHtml = render(peerFixture({ role: "retrans" }));

    expect(visibleText(outpostHtml)).toContain("This outpost's peer row");
    expect(visibleText(outpostHtml)).toContain("nothing here is sent to the outpost");

    expect(visibleText(retransHtml)).not.toContain("This outpost's");
    expect(visibleText(retransHtml)).toContain("This retrans peer's row");
    expect(visibleText(retransHtml)).toContain("nothing here is sent to the peer");
    expect(visibleText(retransHtml)).not.toContain("nothing here is sent to the outpost");
  });

  it("problemDetail prefers the problem detail and falls back honestly", () => {
    expect(
      problemDetail(
        new ScpApiError("Conflict", {
          status: 409,
          problem: { type: "about:blank", title: "Conflict", status: 409, detail: "name taken" }
        })
      )
    ).toBe("name taken");
    expect(problemDetail(new Error("network down"))).toBe("network down");
    expect(problemDetail("odd")).toBe("odd");
  });
});

/**
 * Y4 — THE X7 CLASS, CLOSED FOR `syncScope`.
 *
 * `syncScope` is required-not-optional on `FederationPeer` and BEFORE ADR-0023 the SDK validated no
 * response, so `peer.syncScope.mode` was a bare dereference of a promise nothing enforced at
 * runtime — the same read that white-screened the outposts pages. Here it would kill the Settings
 * card, which is the only door an operator has to fix the peer whose response is malformed.
 *
 * SINCE ADR-0023 a body omitting `syncScope` no longer reaches this card through
 * `client.federation.status()` — it rejects at the SDK boundary and `/federation` renders the
 * diagnosis (`federation-status-crash.test.tsx` pins that). These cases drive the COMPONENT
 * directly, which is the only level at which the guard itself — as opposed to the boundary in front
 * of it — can be pinned, and the level that still decides what happens for any other source of a
 * peer (a cached snapshot, a future unspec'd feed).
 *
 * The guard must not become the OTHER failure: substituting a default mode would tell the operator
 * the peer exports everything, and — since the patch builder omits an UNCHANGED mode — a form left
 * alone would keep whatever the real scope is while displaying a different one.
 */
describe("Y4: a peer whose response omits `syncScope` neither crashes nor invents a scope", () => {
  /** A peer with the `syncScope` KEY DELETED, as a server predating the field would send it. */
  function peerWithoutSyncScope(): FederationPeer {
    const peer: Partial<FederationPeer> = peerFixture();
    delete peer.syncScope;
    return peer as FederationPeer;
  }

  it("renders the Settings card instead of throwing", () => {
    const peer = peerWithoutSyncScope();
    const html = renderToStaticMarkup(<PeerSettingsCard peer={peer} onSave={() => {}} />);

    expect(html).toContain('data-testid="peer-sync-scope-select"');
    // and it says so in words rather than picking a mode
    expect(html).toContain("not reported by this server");
  });

  it("NEVER paints an unreported scope as `full`", () => {
    const html = renderToStaticMarkup(
      <PeerSettingsCard peer={peerWithoutSyncScope()} onSave={() => {}} />
    );
    // `full` is still offered as a CHOICE; what is forbidden is it being the SELECTED value.
    expect(html).not.toMatch(/<option[^>]*selected[^>]*>full</);
  });

  it("an untouched form over an unreported scope is still NOT a write", () => {
    const peer = peerWithoutSyncScope();
    const patch = peerSettingsPatch(peer, draftFromPeer(peer));
    expect(patch).toEqual({});
    // in particular the marker must never be sent as a mode
    expect(patch.syncScope).toBeUndefined();
  });

  it("but an operator who PICKS a mode over an unreported one does write it", () => {
    const peer = peerWithoutSyncScope();
    const patch = peerSettingsPatch(peer, {
      ...draftFromPeer(peer),
      syncScopeMode: "status_only"
    });
    expect(patch.syncScope).toEqual({ mode: "status_only" });
  });

  it("a REPORTED scope still round-trips unchanged — the guard must not swallow the honest case", () => {
    const peer = peerFixture({ syncScope: { mode: "policies_only" } });
    expect(draftFromPeer(peer).syncScopeMode).toBe("policies_only");
    expect(peerSettingsPatch(peer, draftFromPeer(peer))).toEqual({});
    expect(
      peerSettingsPatch(peer, { ...draftFromPeer(peer), syncScopeMode: "full" }).syncScope
    ).toEqual({ mode: "full" });
  });
});
