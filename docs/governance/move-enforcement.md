# move-enforcement

Reference for `apps/server/src/governance/move-enforcement.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 6 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE INSTANCE RUNG

THE INSTANCE RUNG — no row means DISABLED, decided here and nowhere else.

Byte-for-byte the reasoning `dependencies/subscription-resolution.ts`'s `readInstanceSubscriptionUnlock` carries: re-deriving "absent = off" in a route is how the API and the doors come to disagree about a deployment nobody has configured — the loudest possible bug in the safest-sounding line of code.

## §2. THE DOOR CHECK

THE DOOR CHECK. Fail-closed, called AFTER the door's own `object:write`/`relationship:write` pair, and a no-op — one cheap singleton read plus at most two chain walks — on every deployment with no rung set, which is all of them until an operator sets one.

ORs enforcement over the MOVED object's chain and the DESTINATION's chain (the monotone rule), then demands `governance:move` at BOTH ends. The org root is NOT exempt at either end — see the module header for why the custody exemption in `containment-parent-authz.ts` does not transfer.

## §3. The rung write verbs

The rung write verbs. Authorization and the Decision/audit pair live one module over (`governance/move-rung-write.ts`, shared by the HTTP door and the IaC apply door — the follow-up named in proposal §9.6 Q4, now built); what lives HERE is the SHAPE of an enablement and the monotone refusal, so no door can disagree with another about either.
