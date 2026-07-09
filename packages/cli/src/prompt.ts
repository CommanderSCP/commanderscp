import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Minimal interactive prompt fallback — automation should prefer flags/env instead. */
export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
