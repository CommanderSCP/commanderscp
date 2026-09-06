# component-pipeline

Reference for `apps/web/src/routes/component-pipeline.tsx`. The source carries a one-line headline at each site and points here.

> Partial: 24 of 69 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE COMPONENT PIPELINE

THE COMPONENT PIPELINE — the default view of a component (coordination-ui-views.md §2, corrected 2026-08-03).

A pipeline is a durable property of a component; artifacts move THROUGH it. Two corrections got it here, and this file must keep BOTH:

```text
1. The surface this replaces was keyed on a CHANGE, so a component with nothing in flight had no
   pipeline to open at all. Nothing here may be gated on `stage.current`.
2. The first version of the replacement drew one card per PLACEMENT, so a stage the component is
   NOT placed at rendered nowhere — on the live estate, a two-wave topology showed one card and
   prod was simply absent. The journey is the topology's WAVES, and a stage with no placement is
   drawn greyed and explicitly "not placed" rather than omitted.
```

"Not placed" and "placed, nothing released yet" are deliberately different pictures. The second is ordinary (a new placement); the first says this component's releases never reach that stage, which is usually the most important thing on the page.

Waves stack VERTICALLY with a `PromotionArrow` between them — the same shape `change-pipeline.tsx` uses, and the one that component was drawn for (its arrow points down). Targets inside one wave sit side by side, because that is what a parallel wave means.

## §2. THE CORRELATED-INFRASTRUCTURE LANE

THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — `undefined` = an OLDER SERVER, which never evaluated correlation and renders no section at all; an object (`changes` possibly empty) = evaluated. Unlike `artifact`/`observedRun`, the server never sends `null` here — evaluated-and-empty is spelled `{ changes: [] }`, not `null` — but the wire type still allows it (the same additive idiom `registry`/`artifact` use), so this reading keeps both apart.

## §3. WHO MAINTAINS THIS PLACE

WHO MAINTAINS THIS PLACE — shown on every stage, placed or not.

The commander gives the go-ahead; the OUTPOST still runs and maintains its own targets (owner, 2026-08-04) — ADR-0017 §2 devolves execution to the originating outpost and leaves the commander owning only the cross-boundary gate, and ADR-0011 has the receiving outpost validate every deploy inside its own domain. A stage drawn with no domain on it invites the reading that the commander deploys it, which is the one thing charter principle 1 says it does not do.

An UNKNOWN domain renders as unknown rather than as ours: on a replica whose peer row has not arrived, claiming a place is maintained here would be the exact misreading this exists to stop.

## §4. WHAT IS WITHHOLDING THIS STAGE'S RELEASE

WHAT IS WITHHOLDING THIS STAGE'S RELEASE — a subnode of the stage, beside its entry gate.

A subnode rather than a node of the pipeline, for exactly the reason the gate is one: this is a condition on entering ONE place, not a step the release passes through on its way somewhere.

IT NAMES THE DEPENDENCY, which is the entire point of the increment. A badge saying only "held" would move the operator from "why is this pending?" to "why is this held?" and no further, and the answer is not discoverable from anywhere else on this page. Each line is the server's own `describeStageDependencyHold` sentence — the same one the hold Decision's `reasonTree` carries — so the page and the audit record cannot describe the same verdict differently.

The dependency renders by NAME with the id only as a tooltip, and falls back to the id when the server sent no name (a deleted component, or an `undeclarable` entry whose raw JSON never had an id to resolve). It is never an id dressed up as a name.

## §5. THE REMOVE-PLACEMENT CONFIRM'S COPY

THE REMOVE-PLACEMENT CONFIRM'S COPY (B2) — exported for the same portal reason as `DeleteMappingConfirmBody`. Names the actual consequence rather than a euphemism: the component loses this stage (no release reaches it until placed again), and states the coordination/ execution boundary explicitly (charter principle 1) — removing the placement withdraws SCP's OWN coordination record, it does not touch whatever is already running at the target.

## §6. PLACE AT TARGET

PLACE AT TARGET (B2, docs/proposals/outpost-ui.md §4) — the affordance that replaces the formerly-inert "Declare a placement…" prose. Two call sites, two shapes of the same picker:

```text
- `UnplacedStageCard` already knows its own `deploymentTarget` (that IS the stage), so it
  pre-selects it — the picker still lists every target, because an operator opening it here
  may want a DIFFERENT one, but the common case is one click.
- The whole-page empty state (`pipeline-empty`) knows no target at all, so it opens blank.
```

Closed by default (just the button) — the list of deployment targets is fetched lazily (`enabled: open`) so a page with several unplaced stages does not fire the query once per card.

## §7. Builds one lane's node chain

Builds one lane's node chain. Exported for `component-pipeline-continuous.test.tsx` — which nodes appear, and in what order, is the contract this view now IS. `registry` and `artifact` are optional on the wire (older servers), so a caller may omit them: the pre-§9.2 chain then comes back unchanged. `instanceRole` omitted/undefined reads as "not known to be the commander" — the Scan & sign node is never drawn on a guess.

## §8. THE HEAD OF A LANE

THE HEAD OF A LANE — the repos a push to which releases this component through this pipeline.

This is the durable RULE (`source_mappings`), not release history, so it answers "does a change there affect this?" for a component that has never released — the same property the stages have.

## §9. PIPELINE NODE ICONS

PIPELINE NODE ICONS — one distinct glyph per node KIND, from the lucide vocabulary (design spec §1.6/§4C's kinds map; the hand-rolled inline SVG set this replaces is gone — one icon system).

Every node previously rendered as an identical white rectangle, so the chain read as a stack of boxes and the KIND of each step was carried only by its title text. The glyph is what makes "repo, build, registry, deploy" legible at a glance (owner, 2026-08-10). The `data-node-icon` attribute is the distinctness contract `component-pipeline-continuous.test.tsx` pins.

## §10. THE CHANGE-SOURCE KINDS THIS PAGE OFFERS

THE CHANGE-SOURCE KINDS THIS PAGE OFFERS (A1, docs/proposals/outpost-ui.md §3). `sourceKind` is an open string on the wire (`ChangeSourceEventParamSchema` is `z.string().min(1)`) — but only these three carry a signature verifier in the webhook-adapter registry (`apps/server/src/coordination/webhook-adapters.ts`'s `ADAPTERS`), so offering a fourth here would create a mapping whose deliveries can never authenticate (falls back to the generic HMAC scheme, which is a real but DIFFERENT configuration step, not "this kind works out of the box").

## §11. ADD SOURCE MAPPING

ADD SOURCE MAPPING (A1) — offers exactly `CreateSourceMappingRequestSchema`'s fields, minus `component`: this page already IS the component, so asking for it again would be asking the operator to re-type something the URL already answers. `sourceKind` is a path segment on the wire, not free text — see `SOURCE_KINDS`.

## §12. THE DELETE CONFIRM'S COPY

THE DELETE CONFIRM'S COPY — exported so the honesty claim is assertable directly (Radix's `DialogContent` portals its children, which render nothing under `renderToStaticMarkup`; see `domain-local.test.tsx`'s precedent). States the server's actual behavior rather than a comfortable simplification: EVERY row matching this tuple goes, including duplicates `discovery accept` can leave behind, and there is no edit — only delete and recreate.

## §13. ONE TILE PER SOURCE

ONE TILE PER SOURCE (owner rule, 2026-08-14: "each source and target must be in its own tile — commander and outposts alike"). This mirrors what the wave side already does — one StageCard per target, side by side under a wave label — so a lane reads as a chain of tiles at BOTH ends: N source tiles → build → registry → M target tiles per wave. Grouped by declared provenance (mirror-of-shared before domain-specific), each tile carrying its own provenance eyebrow, so three kinds of input read as three tiles rather than one list. §10.6 (owner, 2026-08-16): the eyebrow is READ off each mapping's own `scope`/`mirrorOfShared` and renders on EVERY site — the commander's included (it used to hide unless a commander input or a domain-local component was present, which left the commander's own global sources unlabelled). No site-role inference: an undeclared scope renders NO eyebrow anywhere.

## §14. THE COMMANDER AS AN OPAQUE INPUT

THE COMMANDER AS AN OPAQUE INPUT — its own tile, named from maintainedBy (name null = origin matches no known peer; say the id rather than guess). Deliberately NO repo, host, path or ref: this domain does not know them, and a tile that showed any would be an invention. Its own fan-in arrow too (owner, 2026-08-14: "each source should have its own arrow") — plain `pending`, since there is no per-mapping enable/disable concept for an input this domain does not own.

## §15. ONE SOURCE TILE

ONE SOURCE TILE — one repo rule, its own card, sitting beside its siblings in the source row, and (owner, 2026-08-14) its own downward arrow beneath it: `tile, then arrow` in one column, so N tiles read as N converging fan-in lines rather than one shared connector for the whole row. `provenance` is the declared kind — see `sourceProvenance` above (§10.6): "mirror" | "global" | "domain" | null (undeclared — no eyebrow, and the card's title says how to declare one). The row body below is the pre-existing per-mapping rendering, unchanged — every testid it carried still carries.

## §16. THE ARROW IS THE SWITCH

THE ARROW IS THE SWITCH (owner, 2026-08-14). The mapping's own fan-in arrow carries its enable/disable: click flips it, colour states it — green = open (a push matching this rule starts a release), shut slate = closed (declared, routes nothing). The mutation lives here so the arrow stays a dumb renderer; a server refusal renders as an Alert after the click, never as a pre-disabled control (M16.3's rule). NOT one click (owner, 2026-08-14: "it shouldn't be one-click to enable/disable"). The arrow OPENS A DIALOG. Closing offers a choice — for a period, or until re-opened by hand — and confirms; opening confirms too. Enabled is the default; a routing rule is not something to flip by a mis-click. The dialog owns the mutation; the arrow stays a dumb renderer.

## §17. THE OPEN/CLOSE DIALOG

THE OPEN/CLOSE DIALOG (owner, 2026-08-14) — the confirmation every flip goes through.

CLOSING asks two things: for how long (a period, after which the rule opens again automatically — evaluated at read time like a freeze window, no timer job — or until re-opened by hand), and then a confirm that names the consequence: while closed, a push matching this rule starts no release. OPENING is one confirm, naming what re-opens. Both are one deliberate click past the arrow, never zero. Server refusals render inside the dialog, at the point of action.

## §18. A BUILD NODE

A BUILD NODE — what turns the source into an artifact. Hoisted out of the deploy stages: a build happens once per release, not once per place, whatever scope its binding happens to hang off.

§9.3 (owner §7.2), narrowed by §10.1: ONE artifact fact hangs under the executor line — the SBOM, a BUILD-TIME fact: the reference the first-party change report carried (`sourceRef.sbom`; SCP never generates one and stores no bytes), or "no SBOM reported for this artifact" — or, when the projection STATES `sbom:unparseable`, "recorded but unreadable" (never an absence over an unreadable presence; `sbomUnparseable`).

THE PROMOTION MANIFEST IS NOT HERE (§10.1, owner). The code's export order is scan step → E6 gate → build manifest → sign manifest (promotion-repo.ts phases 1.5–3): the PM is created AFTER the scan and BEFORE the signature, so it is a Scan & sign fact and lives on that tile (`ScanSignCompact`, between the E6 line and the signed line). The tile is clickable ONLY when an SBOM exists (`buildHasReview`); the review dialog renders the SBOM alone.

## §19. A REGISTRY NODE

A REGISTRY NODE — where the built artifact lands, and what promotion advances by digest.

The HEADER names the registry this component publishes to AT THIS SITE, read off the response's `registry` (pipeline-substrate-registry-scan.md §9.2 — the component's `publishes_to` edge to a domain-local execution-system, never the `image` executor binding, whose Type says what BUILDS the artifact rather than where it lands). Three states, each STATED rather than chosen:

```text
- `declared`  — `name (kind) · repository`, the name a console link to the registry's base URL
                when the server knew one (base only: no registry deep-link shape is known here,
                and a guessed path is a lie);
- `ambiguous` — more than one `publishes_to` edge. The server does not pick, so neither does
                this node: it says how many, in the design system's amber "operator should
                notice" tone, and the tooltip says what to do about it;
- `none`      — "no registry declared for this component here". An absence, not an unknown —
                the node only appears in this state because the component BUILDS here.
```

A null/absent `registry` is an older server; the header then falls back to the pre-§9.2 sentence.

The BODY is the latest artifact digest (§9.3): the last digest the picked change's `sourceRef` lists, folded with the full value in `title`, and WHICH change it came from. Absent, it says so — "no artifact digest recorded yet" when the server projected `artifact` and found none (a stated absence), or the pre-§9.3 "not observed" when the field is not on the wire at all (an unknown).

## §20. THE GATE INTO A STAGE

THE GATE INTO A STAGE — what must pass before a release may move here.

A REQUIREMENT, not a verdict: it is resolved from durable `policy` objects, so it renders for a component with nothing in flight. A verdict belongs to a change and carries a `decision_id`; the change-scoped pipeline view owns that.

"No automated checks" is stated OUT LOUD rather than left blank. Measured 2026-08-10, every live policy has an empty `requireControls` and the estate holds 0 control bindings and 0 control runs — so a silent gate node would be indistinguishable from a view that cannot see checks, when the truth is that none are configured.

## §21. THE ENTRY GATE OF ONE STAGE

THE ENTRY GATE OF ONE STAGE — a SUBNODE of the stage, not a node of the pipeline.

A gate is not a step a release passes through on its way somewhere; it is a condition on ENTERING one place. Drawn as its own full-width node it doubled the length of every pipeline and implied the release stops somewhere between two stages, which is not where it stops — it stops at the door of the next one (owner, 2026-08-10). Attached to the stage it governs, it also stops needing to merge several placements' policies into one wave-level gate: each target keeps its own.

Resolved from the `policy` objects matching this placement (DESIGN §10.1) — the SAME resolution the wave-boundary gate runs, so this view cannot disagree with the engine about what is required. It is a REQUIREMENT, not a verdict: a verdict belongs to a change in flight and carries a `decision_id`.

"No automated check" is stated rather than left blank. Measured 2026-08-10: every live policy has an empty `requireControls`, and the estate holds 0 control bindings and 0 control runs — so a silent gate would be indistinguishable from a view that cannot see checks, when the truth is that none are configured.

## §22. THE ENTRY GATE AS ONE LINE

THE ENTRY GATE AS ONE LINE (§10.3) — the compact form of `GateSubnode`, which keeps the full per-check list under Details.

`entry gate: none — enters as soon as the previous stage succeeds` when no policy gates the stage; else `entry gate: N checks · <counts by status> [· approval required]`. The current UI has NO aggregate verdict for a gate (each check carries its own mark), so none is invented here: the line says how many checks and how many are in each state, coloured by the same precedence the per-check marks use (a failure red, a warning amber, all passed green, else quiet). "approval required" is appended whenever a policy asks for one, so an approval-only gate does not read as `0 checks` and nothing else.

## §23. THE PROVENANCE SENTENCE

THE PROVENANCE SENTENCE (owner decision, 2026-08-24) — server-composed facts, plain-English sentence, verbatim per the design system's copy rule. Reads `entry.correlatedVia` alone: the PRIMARY route decides the sentence even when `coupledKey` is also set (a change can match BOTH a place and a coupling — the place is the more specific fact, so it is the one said out loud).

## §24. THE CORRELATED-INFRASTRUCTURE SECTION

THE CORRELATED-INFRASTRUCTURE SECTION (owner decision, 2026-08-24) — infrastructure lane ONLY (never rendered on the software lane, and the caller below never mounts it there). Absent vs empty (design system §"honesty-copy rules"): `undefined` renders NO section at all (an older server never evaluated this); an evaluated `{ changes: [] }` renders the section with one quiet line, because "we looked and found none" is a different, honest fact from "we never looked".
