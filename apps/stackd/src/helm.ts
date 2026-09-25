import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * THE VENDORED, PINNED helm (M29.4, ADR-0058 E3). The controller renders `deploy/helm-bundled` with
 * `helm template` and nothing else — no release, no repo, no network. The binary is the one
 * `tools/helm/pin.env` names, and a binary reporting any other version is refused at startup, so a
 * base-image change or a stray PATH entry cannot silently change what the stack renders to.
 */

export interface HelmPin {
  version: string;
  tarballSha256: string;
  vendoredPath: string;
}

/** Parses the shell-sourceable pin file (KEY=value lines; `#` comments). */
export function parseHelmPin(text: string): HelmPin {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const need = (k: string): string => {
    const v = values.get(k);
    if (!v) throw new Error(`helm pin file has no ${k}`);
    return v;
  };
  return {
    version: need("HELM_PINNED_VERSION"),
    tarballSha256: need("HELM_TARBALL_SHA256"),
    vendoredPath: need("HELM_VENDORED_PATH")
  };
}

export interface HelmRenderer {
  readonly binary: string;
  readonly version: string;
  /** `helm template` of `chartDir` with exactly `values`, as one multi-document YAML string. */
  template(chartDir: string, values: unknown): Promise<string>;
}

/** Renders are up to ~11 MB (Argo Workflows' CRDs); the default 1 MB buffer would truncate. */
const MAX_RENDER_BYTES = 64 * 1024 * 1024;

/**
 * Resolves the renderer, asserting the binary IS the pin. `binary` defaults to the pin's vendored
 * path; a test or a dev box passes the helm it has, and the same version check applies to it.
 */
export async function resolveHelm(opts: {
  pinFile: string;
  binary?: string;
}): Promise<HelmRenderer> {
  const pin = parseHelmPin(await readFile(opts.pinFile, "utf8"));
  const binary = opts.binary ?? pin.vendoredPath;
  let reported: string;
  try {
    const { stdout } = await execFileAsync(binary, ["version", "--template", "{{.Version}}"], {
      timeout: 30_000
    });
    reported = stdout.trim();
  } catch (err) {
    throw new Error(
      `the pinned helm could not be run at ${binary}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (reported !== pin.version) {
    throw new Error(
      `refusing to render the Standard Stack with helm ${reported || "(no version)"} at ${binary}: ` +
        `the pin is ${pin.version} (tools/helm/pin.env). The stack's manifests are fixed per SCP ` +
        "release, and a different helm is a different render."
    );
  }
  return {
    binary,
    version: reported,
    async template(chartDir: string, values: unknown): Promise<string> {
      // A values FILE, never `--set`: helm's --set grammar gives meaning to commas, dots and
      // brackets inside a value, and nothing here should be parsed as anything but data.
      const dir = await mkdtemp(path.join(tmpdir(), "scp-stackd-render-"));
      try {
        const valuesFile = path.join(dir, "values.json");
        await writeFile(valuesFile, JSON.stringify(values), { mode: 0o600 });
        const { stdout } = await execFileAsync(
          binary,
          ["template", "scp-stack", chartDir, "--values", valuesFile],
          { maxBuffer: MAX_RENDER_BYTES, timeout: 120_000 }
        );
        return stdout;
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new Error(`helm template failed: ${(e.stderr || e.message || String(err)).trim()}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
