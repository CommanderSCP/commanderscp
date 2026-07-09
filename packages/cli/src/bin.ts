#!/usr/bin/env node
import { runCli } from "./cli.js";
import { ScpApiError } from "@scp/sdk";

runCli(process.argv).catch((err: unknown) => {
  if (err instanceof ScpApiError) {
    console.error(`error: ${err.message}${err.status ? ` (HTTP ${err.status})` : ""}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
});
