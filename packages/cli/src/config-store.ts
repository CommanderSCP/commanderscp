import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface StoredCredentials {
  baseUrl: string;
  token: string;
  org: string;
  expiresAt: string;
}

/** Overridable so the e2e script (and tests) don't touch a developer's real `~/.scp`. */
function configDir(): string {
  return process.env.SCP_CONFIG_DIR ?? path.join(os.homedir(), ".scp");
}

function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

export async function clearCredentials(): Promise<void> {
  await rm(credentialsPath(), { force: true });
}
