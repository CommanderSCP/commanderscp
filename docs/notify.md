# notify

Long-form reference for the **notify** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 3 of 3 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/notify/dispatch.ts`](#apps-server-src-notify-dispatch-ts) — §1–§1
- [`apps/server/src/notify/notification-bindings-repo.ts`](#apps-server-src-notify-notification-bindings-repo-ts) — §2–§3

## `apps/server/src/notify/dispatch.ts`

### §1. Fans a message to every channel meeting its own minSeverity

Fans `msg` out to every one of `orgId`'s configured notification channels that meets its own `minSeverity` threshold (`notification_bindings`) — the concrete implementation behind the seam `coordination/watchdog.ts`'s "escalation" doc comment and `governance/gate-orchestrator.ts`'s freeze-block path have named as "M7" since M3/M4. Best-effort per channel: one channel's misconfiguration or downstream failure is caught and logged, never allowed to propagate — a notification is inherently side-channel (DESIGN §11's `DeliveryResult` already models "did it send" as data, not a thrown error), and the engine action that triggered this (a watchdog flag, a freeze block) must never fail BECAUSE a notification channel is down.

## `apps/server/src/notify/notification-bindings-repo.ts`

### §2. An org's notification channels: a list, not a 1:1 binding

`notification_bindings` (DESIGN §11 `NotificationPlugin`, BUILD_AND_TEST.md §8 M7 item 4) — an org's configured notification channels. Unlike `executor_bindings`/`control_bindings` (1:1 binding per graph object), this is a plain org-scoped LIST: an org may wire up more than one channel (e.g. a webhook AND an SMTP relay), and every configured channel receives every dispatched message independently (`notify/dispatch.ts`).

### §3. CENSUSED, NOT ASSUMED

CENSUSED, NOT ASSUMED. `PUT /notifications/{instanceId}` calls the same `validatePluginConfig` the executor door does, so it carried the identical fail-open: an allowlisted module with no manifest would have had its tenant config stored unread. Measured on shipped main, both modules here DO have manifests, so this allowlist happened to be clean — but "happened to be" is the whole defect being fixed, and the executor allowlist was clean once too. The assertion is what makes it stay true, so a third notification channel cannot land without a config schema.
