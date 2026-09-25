import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  StackBackendSchema,
  StackSizeTierSchema,
  StackUpdatePolicySchema,
  type StackBackend,
  type StackBackendView,
  type StackServedOrg,
  type StackServedOrgList,
  type StackSizeTier,
  type StackView
} from "@scp/schemas";
import { clientFromStoredCredentials } from "./client-factory.js";
import { printResult, type OutputFormat } from "./output.js";
import { registerStackCredentialCommands } from "./stack-credentials-cli.js";

/**
 * `scp stack …` — the Standard Stack (M29.4, ADR-0058). Reading is an ordinary session call.
 * Every change binds the whole deployment, so it needs INSTANCE AUTHORITY: the instance-operator
 * role on your login (`scp instance-operator grant`), or — for a script — a deployment operator
 * credential (`--operator-token` / `$SCP_OPERATOR_TOKEN`). The server decides; the CLI only
 * forwards a credential when one is given.
 */

interface StackCliOpts {
  baseUrl?: string;
  output: OutputFormat;
  operatorToken?: string;
}

/** The credential to forward, if any; without one the session's role is what is checked. */
function operatorTokenOf(opts: { operatorToken?: string }): string | undefined {
  return opts.operatorToken ?? process.env.SCP_OPERATOR_TOKEN ?? undefined;
}

/** Parsed against the SCHEMA's vocabulary, never a copied list. */
function backendOf(raw: string): StackBackend {
  const parsed = StackBackendSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `backend must be one of ${StackBackendSchema.options.join("|")} (got '${raw}')`
    );
  }
  return parsed.data;
}

function tierOf(raw: string | undefined): StackSizeTier | undefined {
  if (raw === undefined) return undefined;
  const parsed = StackSizeTierSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `--size must be one of ${StackSizeTierSchema.options.join("|")} (got '${raw}')`
    );
  }
  return parsed.data;
}

/** One table row per backend. `phase` reads `(pending)` for an enabled backend the controller has
 *  not reported yet, so "enabled" is never mistaken for "installed". */
export function stackBackendRow(b: StackBackendView): Record<string, string> {
  const s = b.status;
  return {
    backend: b.backend,
    enabled: b.enabled ? "yes" : "no",
    size: b.sizeTier,
    phase: s ? s.phase : b.enabled ? "(pending)" : "-",
    running: s?.runningVersion ?? "-",
    target: s?.targetVersion ?? "-",
    needs: s && s.needs.length > 0 ? s.needs.map((n) => n.code).join(",") : "-",
    // M29.2: whether it is wired into SCP (registered, token, TLS trust, egress) and where.
    wired: b.wiring === null ? "n/a" : b.wiring.wired ? (b.wiring.serverUrl ?? "yes") : "no",
    error: s?.lastError ?? "-"
  };
}

/** The line above the table: whether anyone is actually acting on the spec. */
export function stackControllerLine(view: StackView): string {
  const c = view.controller;
  if (c.lastSeenAt === null) {
    return "stack controller: has never reported — nothing below is being acted on yet";
  }
  const state = c.reporting ? "reporting" : "NOT REPORTING (stale)";
  return (
    `stack controller: ${state}, release ${c.release ?? "?"}, last seen ${c.lastSeenAt}; ` +
    `updates ${view.settings.updatePolicy}, upgrade generation ${view.settings.upgradeGeneration}` +
    ` (observed ${c.observedUpgradeGeneration ?? "-"})`
  );
}

function printStack(view: StackView, output: OutputFormat): void {
  if (output === "json") {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  console.log(stackControllerLine(view));
  if (view.servesThisOrg !== null) {
    console.log(
      view.servesThisOrg
        ? "this organization is served: every wired backend is registered here as an execution system"
        : "this organization is NOT served by the Standard Stack (an instance operator can: `scp stack attach`)"
    );
  }
  console.log("");
  printResult(view.backends, output, (item) => stackBackendRow(item as StackBackendView));
  for (const b of view.backends) {
    for (const need of b.status?.needs ?? []) {
      console.log(`  needs (${b.backend}): ${need.message}`);
    }
  }
}

export function registerStackCommands(program: Command): void {
  const stack = program
    .command("stack")
    .description(
      "The Standard Stack SCP installs and operates for you (Argo CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea)"
    );

  stack
    .command("status")
    .description("Each backend's desired state, phase, versions and what it still needs")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.get(), opts.output);
    });

  const toggle = (verb: "enable" | "disable") =>
    stack
      .command(`${verb} <backend>`)
      .description(
        verb === "enable"
          ? "Install a backend (the stack controller stands it up and reports when it is ready)"
          : "Remove a backend (its workloads and namespace; CustomResourceDefinitions are kept)"
      )
      .option(
        "--operator-token <token>",
        "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
      )
      .option("--base-url <url>", "API base URL override")
      .option("--output <format>", "json|table", "table");

  toggle("enable")
    .option("--size <tier>", `sizing tier: ${StackSizeTierSchema.options.join("|")}`)
    .action(async (raw: string, opts: StackCliOpts & { size?: string }) => {
      const backend = backendOf(raw);
      const sizeTier = tierOf(opts.size);
      const token = operatorTokenOf(opts);
      const client = await clientFromStoredCredentials(opts);
      const view = await client.stack.putBackend(
        backend,
        { enabled: true, ...(sizeTier ? { sizeTier } : {}) },
        token
      );
      printStack(view, opts.output);
    });

  toggle("disable").action(async (raw: string, opts: StackCliOpts) => {
    const backend = backendOf(raw);
    const token = operatorTokenOf(opts);
    const client = await clientFromStoredCredentials(opts);
    printStack(await client.stack.putBackend(backend, { enabled: false }, token), opts.output);
  });

  stack
    .command("purge <backend>")
    .description(
      "DELETE a disabled backend's retained data — its volumes and generate-once secrets (e.g. every Gitea repository). Irreversible."
    )
    .option("--i-understand-data-loss", "required: confirms the data is deleted for good")
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (raw: string, opts: StackCliOpts & { iUnderstandDataLoss?: boolean }) => {
      const backend = backendOf(raw);
      if (!opts.iUnderstandDataLoss) {
        throw new Error(
          `purging ${backend} deletes its data for good (volumes, generated secrets); re-run with --i-understand-data-loss`
        );
      }
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.purge(backend, operatorTokenOf(opts)), opts.output);
    });

  stack
    .command("upgrade")
    .description(
      "Roll every enabled backend onto the versions this SCP release carries — approves a held upgrade (manual updates) or retries one that was rolled back"
    )
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const token = operatorTokenOf(opts);
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.requestUpgrade(token), opts.output);
    });

  stack
    .command("updates <policy>")
    .description(
      `Whether a new release's stack versions roll out on their own: ${StackUpdatePolicySchema.options.join("|")}`
    )
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (raw: string, opts: StackCliOpts) => {
      const parsed = StackUpdatePolicySchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `policy must be one of ${StackUpdatePolicySchema.options.join("|")} (got '${raw}')`
        );
      }
      const token = operatorTokenOf(opts);
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.putSettings({ updatePolicy: parsed.data }, token), opts.output);
    });

  stack
    .command("rotate <backend>")
    .description(
      "Rotate a wired backend's credentials: the stack controller mints a new scoped token (for Argo Workflows also a new server certificate), hands it to SCP and revokes the old one"
    )
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (raw: string, opts: StackCliOpts) => {
      const backend = backendOf(raw);
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.rotate(backend, operatorTokenOf(opts)), opts.output);
    });

  const printOrgs = (list: StackServedOrgList, output: OutputFormat) =>
    printResult(list.items, output, (raw) => {
      const o = raw as StackServedOrg;
      return {
        org: o.orgName,
        id: o.orgId,
        attachedBy: o.attachedBy.username ?? o.attachedBy.mechanism,
        attachedAt: o.attachedAt
      };
    });

  stack
    .command("orgs")
    .description(
      "The organizations the Standard Stack serves — its wired backends are registered in each, all driving the same scoped accounts"
    )
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      printOrgs(await client.stack.orgs(operatorTokenOf(opts)), opts.output);
    });

  for (const verb of ["attach", "detach"] as const) {
    stack
      .command(`${verb} <orgId>`)
      .description(
        verb === "attach"
          ? "Serve another organization with the Standard Stack (its tenants then drive the same scoped backend accounts as every served org)"
          : "Stop serving an organization (its registrations stay, with their bindings, and refuse to resolve)"
      )
      .option(
        "--operator-token <token>",
        "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
      )
      .option("--base-url <url>", "API base URL override")
      .option("--output <format>", "json|table", "table")
      .action(async (orgId: string, opts: StackCliOpts) => {
        const client = await clientFromStoredCredentials(opts);
        const token = operatorTokenOf(opts);
        printOrgs(
          verb === "attach"
            ? await client.stack.attachOrg(orgId, token)
            : await client.stack.detachOrg(orgId, token),
          opts.output
        );
      });
  }

  stack
    .command("diagnostics")
    .description(
      "Download the stack support bundle (the read model plus the controller's evidence)"
    )
    .option(
      "--operator-token <token>",
      "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
    )
    .option("--base-url <url>", "API base URL override")
    .option("-o, --out <file>", "write to this file instead of stdout")
    .action(async (opts: { baseUrl?: string; operatorToken?: string; out?: string }) => {
      const token = operatorTokenOf(opts);
      const client = await clientFromStoredCredentials(opts);
      const body = JSON.stringify(await client.stack.diagnostics(token), null, 2);
      if (opts.out) {
        await writeFile(opts.out, body + "\n", { mode: 0o600 });
        console.log(`wrote ${opts.out}`);
      } else {
        console.log(body);
      }
    });

  // M29.5 (ADR-0063): `scp stack credential …` and `scp stack workload-identity …`.
  registerStackCredentialCommands(stack);
}

/** `scp instance-operator …` — the instance-operator role (owner decision 2026-09-25). */
export function registerInstanceOperatorCommands(program: Command): void {
  const cmd = program
    .command("instance-operator")
    .description(
      "Grant, list and revoke the instance-operator role — the authority to change the Standard Stack for every org on this deployment"
    );
  const tokenOpt = [
    "--operator-token <token>",
    "a deployment operator credential (else $SCP_OPERATOR_TOKEN; else your login's instance-operator role)"
  ] as const;

  cmd
    .command("list")
    .description("Every grant, live and revoked")
    .option(...tokenOpt)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const list = await client.instanceOperators.list(operatorTokenOf(opts));
      printResult(list.items, opts.output, (raw) => {
        const g = raw as (typeof list.items)[number];
        return {
          id: g.id,
          user: g.username || g.userId,
          org: g.orgId,
          grantedBy: g.grantedBy.username ?? g.grantedBy.mechanism,
          grantedAt: g.grantedAt,
          revokedAt: g.revokedAt ?? "-"
        };
      });
    });

  cmd
    .command("grant")
    .description("Grant the role to a user (the first grant needs an operator credential)")
    .requiredOption("--org <orgId>", "the user's org id")
    .requiredOption("--user <userId>", "the user's id (`scp whoami` prints yours)")
    .option(...tokenOpt)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts & { org: string; user: string }) => {
      const client = await clientFromStoredCredentials(opts);
      const g = await client.instanceOperators.grant(
        { orgId: opts.org, userId: opts.user },
        operatorTokenOf(opts)
      );
      printResult(g, opts.output, () => ({ id: g.id, user: g.username, grantedAt: g.grantedAt }));
    });

  cmd
    .command("revoke <grantId>")
    .description("Revoke a grant (stamps revoked_at; the history remains)")
    .option(...tokenOpt)
    .option("--base-url <url>", "API base URL override")
    .action(async (grantId: string, opts: StackCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      await client.instanceOperators.revoke(grantId, operatorTokenOf(opts));
      console.log(`instance-operator grant ${grantId} revoked`);
    });

  cmd
    .command("audit")
    .description("The instance audit chain (stack changes, grants), re-verified by the server")
    .option(...tokenOpt)
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const client = await clientFromStoredCredentials(opts);
      const list = await client.instanceOperators.auditEvents(operatorTokenOf(opts));
      if (opts.output !== "json") {
        console.log(list.chainValid ? "chain verified" : `CHAIN BROKEN at ${list.brokenAt}`);
      }
      printResult(list.items, opts.output, (raw) => {
        const e = raw as (typeof list.items)[number];
        return {
          seq: String(e.seq),
          action: e.action,
          subject: e.subject ?? "-",
          actor: e.actor.username ?? e.actor.mechanism,
          at: e.occurredAt
        };
      });
    });
}
