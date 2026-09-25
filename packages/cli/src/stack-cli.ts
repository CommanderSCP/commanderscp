import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import {
  StackBackendSchema,
  StackSizeTierSchema,
  StackUpdatePolicySchema,
  type StackBackend,
  type StackBackendView,
  type StackSizeTier,
  type StackView
} from "@scp/schemas";
import { clientFromStoredCredentials } from "./client-factory.js";
import { printResult, type OutputFormat } from "./output.js";

/**
 * `scp stack …` — the Standard Stack (M29.4, ADR-0058). Reading is an ordinary session call.
 * Every change binds the whole deployment, so it also needs the operator credential
 * (`--operator-token` or `$SCP_OPERATOR_TOKEN`), exactly like the other instance-tier verbs.
 */

interface StackCliOpts {
  baseUrl?: string;
  output: OutputFormat;
  operatorToken?: string;
}

function operatorTokenOf(opts: { operatorToken?: string }, what: string): string {
  const token = opts.operatorToken ?? process.env.SCP_OPERATOR_TOKEN;
  if (!token) {
    throw new Error(
      `${what} changes the Standard Stack for every org on this deployment, so it needs the ` +
        "deployment operator credential: pass --operator-token or set SCP_OPERATOR_TOKEN."
    );
  }
  return token;
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
  console.log(stackControllerLine(view) + "\n");
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
      .option("--operator-token <token>", "defaults to $SCP_OPERATOR_TOKEN")
      .option("--base-url <url>", "API base URL override")
      .option("--output <format>", "json|table", "table");

  toggle("enable")
    .option("--size <tier>", `sizing tier: ${StackSizeTierSchema.options.join("|")}`)
    .action(async (raw: string, opts: StackCliOpts & { size?: string }) => {
      const backend = backendOf(raw);
      const sizeTier = tierOf(opts.size);
      const token = operatorTokenOf(opts, `enabling ${backend}`);
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
    const token = operatorTokenOf(opts, `disabling ${backend}`);
    const client = await clientFromStoredCredentials(opts);
    printStack(await client.stack.putBackend(backend, { enabled: false }, token), opts.output);
  });

  stack
    .command("upgrade")
    .description(
      "Roll every enabled backend onto the versions this SCP release carries — approves a held upgrade (manual updates) or retries one that was rolled back"
    )
    .option("--operator-token <token>", "defaults to $SCP_OPERATOR_TOKEN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (opts: StackCliOpts) => {
      const token = operatorTokenOf(opts, "an upgrade");
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.requestUpgrade(token), opts.output);
    });

  stack
    .command("updates <policy>")
    .description(
      `Whether a new release's stack versions roll out on their own: ${StackUpdatePolicySchema.options.join("|")}`
    )
    .option("--operator-token <token>", "defaults to $SCP_OPERATOR_TOKEN")
    .option("--base-url <url>", "API base URL override")
    .option("--output <format>", "json|table", "table")
    .action(async (raw: string, opts: StackCliOpts) => {
      const parsed = StackUpdatePolicySchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `policy must be one of ${StackUpdatePolicySchema.options.join("|")} (got '${raw}')`
        );
      }
      const token = operatorTokenOf(opts, "the update policy");
      const client = await clientFromStoredCredentials(opts);
      printStack(await client.stack.putSettings({ updatePolicy: parsed.data }, token), opts.output);
    });

  stack
    .command("diagnostics")
    .description(
      "Download the stack support bundle (the read model plus the controller's evidence)"
    )
    .option("--operator-token <token>", "defaults to $SCP_OPERATOR_TOKEN")
    .option("--base-url <url>", "API base URL override")
    .option("-o, --out <file>", "write to this file instead of stdout")
    .action(async (opts: { baseUrl?: string; operatorToken?: string; out?: string }) => {
      const token = operatorTokenOf(opts, "the diagnostics bundle");
      const client = await clientFromStoredCredentials(opts);
      const body = JSON.stringify(await client.stack.diagnostics(token), null, 2);
      if (opts.out) {
        await writeFile(opts.out, body + "\n", { mode: 0o600 });
        console.log(`wrote ${opts.out}`);
      } else {
        console.log(body);
      }
    });
}
