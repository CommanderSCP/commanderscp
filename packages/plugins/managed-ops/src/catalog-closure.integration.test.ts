import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveRunnerImage } from "@scp/plugin-testkit";

/**
 * M27.3 — the closed, cosign-signed task catalog, asked of the built image.
 *
 * Four refusals, each a different attack:
 *   - no signature at all
 *   - the MANIFEST rewritten (signature no longer matches)
 *   - a ROLE rewritten while the signed manifest is untouched — the one a manifest signature alone
 *     does not catch, and the reason each role's content digest is pinned inside the signed bytes
 *   - a role declaring a charter class the amendment does not enumerate
 */

const execFileAsync = promisify(execFile);

/**
 * Make a whole tree writable by the image's non-root user.
 *
 * RECURSIVE, and that is the fix rather than a flourish: chmod-ing only the mount root left
 * `catalog/` at its copied mode, and cosign writes `catalog/catalog.json.sig` INSIDE it. The first
 * attempt at this fix opened the door and not the room behind it.
 */
async function makeWritableByContainer(dir: string): Promise<void> {
  await execFileAsync("chmod", ["-R", "a+rwX", dir]);
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_OPS_CONTEXT = resolve(__dirname, "../../../../apps/runner-ops");
const IMAGE_TAG = "scp-runner-ops:m27-3-catalog-test";

let dockerReady = false;
let imageRef = "";
/** A signed catalog + keypair, made once and copied per case. */
let signedFixture: string;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function runInImage(catalogDir: string, keysDir: string, role: string): Promise<string> {
  const args = [
    "run",
    "--rm",
    "-v",
    `${catalogDir}:/catalog:ro`,
    ...(keysDir
      ? ["-v", `${keysDir}:/keys:ro`, "-e", "SCP_OPS_CATALOG_PUBKEY=/keys/cosign.pub"]
      : []),
    "-e",
    `SCP_OPS_ROLE=${role}`,
    imageRef
  ];
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 180_000 });
    return stdout + stderr;
  } catch (err) {
    // A refusal exits non-zero — that IS the expected outcome here, so the message is the result.
    const e = err as { stdout?: string; stderr?: string };
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
}

/** A fresh copy of the signed fixture, so each case can tamper without affecting the others. */
async function freshCatalog(): Promise<{ dir: string; catalog: string; keys: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scp-catalog-"));
  await cp(signedFixture, dir, { recursive: true });
  // See the note in ssti-closure: the image is non-root and the mount is owned by the suite's user.
  await makeWritableByContainer(dir);
  return { dir, catalog: join(dir, "catalog"), keys: dir };
}

beforeAll(async () => {
  dockerReady = await dockerAvailable();
  if (!dockerReady) return;
  // PUBLISHED IN CI, BUILT LOCALLY. CI job 4c builds and pushes the runner images and the
  // integration jobs pull them — building here instead failed outright, because this Dockerfile's
  // `# syntax=docker/dockerfile:1.7` directive makes BuildKit fetch a frontend from Docker Hub and
  // CI blackholes egress. `resolveRunnerImage` uses the published ref when one is set and otherwise
  // builds with DOCKER_BUILDKIT=0, which ignores the directive.
  imageRef = await resolveRunnerImage({
    refEnvVar: "SCP_RUNNER_OPS_IMAGE_REF",
    localTag: IMAGE_TAG,
    context: RUNNER_OPS_CONTEXT
  });
  signedFixture = await mkdtemp(join(tmpdir(), "scp-catalog-signed-"));
  await cp(join(RUNNER_OPS_CONTEXT, "catalog"), join(signedFixture, "catalog"), {
    recursive: true
  });
  // AFTER the copy, not before. `cp` recreates the tree at its SOURCE modes, so chmod-ing first is
  // undone by the very next line — which is what actually happened: the keypair landed at the
  // writable root while `catalog/catalog.json.sig` was refused inside the freshly-copied subtree.
  await makeWritableByContainer(signedFixture);
  // Sign with the SAME flag set as packages/cosign/src/cosign.ts `signBlobFlags` — detached,
  // legacy format, nothing uploaded to Rekor. `--use-signing-config=false` is the flag that makes
  // `--tlog-upload=false` legal on cosign 3.x; without it cosign refuses and demands a signing
  // config fetched over the network, which an air-gapped signer cannot do.
  await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${signedFixture}:/w`,
      "-w",
      "/w",
      "--entrypoint",
      "sh",
      imageRef,
      "-c",
      'export COSIGN_PASSWORD=""; cosign generate-key-pair && ' +
        "cosign sign-blob --key cosign.key --tlog-upload=false --new-bundle-format=false " +
        "--use-signing-config=false --output-signature catalog/catalog.json.sig --yes " +
        "catalog/catalog.json && [ -s catalog/catalog.json.sig ]"
    ],
    { timeout: 180_000 }
  );
}, 900_000);

describe("scp-runner-ops catalog closure (M27.3)", () => {
  it("a correctly signed catalog VERIFIES and the run proceeds past catalog admission", async () => {
    if (!dockerReady) return expectSkipped();
    const { dir, catalog, keys } = await freshCatalog();
    try {
      const out = await runInImage(catalog, keys, "os_package");
      // POSITIVE CONTROL. Every other case asserts a refusal, and a refusal is also what a
      // completely broken image produces — so one case has to get PAST verification. It stops at
      // the next gate (no parameters), which proves signature + digests + class admission all
      // passed rather than that nothing ran.
      expect(out).toContain("no parameters at /work/in/params.json");
      expect(out).not.toContain("signature does not verify");
      expect(out).not.toContain("pinned digest");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("refuses an unsigned catalog", async () => {
    if (!dockerReady) return expectSkipped();
    const { dir, catalog, keys } = await freshCatalog();
    try {
      await rm(join(catalog, "catalog.json.sig"), { force: true });
      expect(await runInImage(catalog, keys, "os_package")).toContain("catalog is unsigned");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("refuses a rewritten MANIFEST", async () => {
    if (!dockerReady) return expectSkipped();
    const { dir, catalog, keys } = await freshCatalog();
    try {
      const path = join(catalog, "catalog.json");
      await writeFile(
        path,
        (await readFile(path, "utf8")).replace('"catalogVersion": "1"', '"catalogVersion": "9"')
      );
      expect(await runInImage(catalog, keys, "os_package")).toContain("signature does not verify");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("refuses a rewritten ROLE even though the signed manifest is untouched", async () => {
    if (!dockerReady) return expectSkipped();
    const { dir, catalog, keys } = await freshCatalog();
    try {
      // THE ATTACK A MANIFEST SIGNATURE ALONE MISSES. cosign signs a few hundred bytes of manifest;
      // the bytes that actually execute live in roles/**. Only the pinned per-role digest catches
      // this, which is why the digest lives inside the signed manifest.
      const tasks = join(catalog, "roles/os_package/tasks/main.yml");
      await writeFile(tasks, (await readFile(tasks, "utf8")) + "\n- name: pwn\n");
      const out = await runInImage(catalog, keys, "os_package");
      expect(out).toContain("does not match its pinned digest");
      expect(out).not.toContain("signature does not verify"); // the manifest is still valid
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("refuses a role that is not in the catalog", async () => {
    if (!dockerReady) return expectSkipped();
    const { dir, catalog, keys } = await freshCatalog();
    try {
      expect(await runInImage(catalog, keys, "definitely_not_a_role")).toContain(
        "is not in the catalog"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("every shipped role declares a charter-enumerated class", async () => {
    const raw = JSON.parse(
      await readFile(join(RUNNER_OPS_CONTEXT, "catalog/catalog.json"), "utf8")
    ) as {
      charterClasses: string[];
      roles: { name: string; charterClass: string; digest?: string }[];
    };
    // The three classes of the 2026-07-12 host-reaching amendment. Written as a LITERAL here rather
    // than read from the file under test: reading it would assert the file agrees with itself.
    expect([...raw.charterClasses].sort()).toEqual(
      ["configRenderPush", "cronSystemd", "osPackage"].sort()
    );
    for (const role of raw.roles) {
      expect(raw.charterClasses, `role '${role.name}' declares an unenumerated class`).toContain(
        role.charterClass
      );
      expect(role.digest, `role '${role.name}' is not digest-pinned`).toMatch(
        /^sha256:[0-9a-f]{64}$/
      );
    }
  });
});

/** See lockdown.integration.test.ts — `it.runIf` is evaluated at collection time. */
function expectSkipped(): void {
  console.warn(
    "[catalog-closure.integration] no reachable Docker daemon — the M27.3 catalog proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}
