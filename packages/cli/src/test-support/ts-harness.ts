import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Compiles one generated file against this repo's real types. See docs/cli.md §149. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const TSC_BIN = path.join(REPO_ROOT, "node_modules/typescript/bin/tsc");
const BASE_TSCONFIG = path.join(REPO_ROOT, "tsconfig.base.json");
const CLI_PACKAGE_DIR = path.resolve(HERE, "..", "..");

export interface CompileResult {
  readonly ok: boolean;
  readonly output: string;
  readonly outDir?: string;
  readonly rootDir: string;
}

export function compileGeneratedTs(source: string, opts: { emit?: boolean } = {}): CompileResult {
  const rootDir = mkdtempSync(path.join(CLI_PACKAGE_DIR, ".tmp-ts-harness-"));
  const srcPath = path.join(rootDir, "generated.ts");
  writeFileSync(srcPath, source, "utf8");
  const outDir = path.join(rootDir, "out");
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      extends: BASE_TSCONFIG,
      compilerOptions: {
        composite: false,
        declaration: false,
        declarationMap: false,
        incremental: false,
        sourceMap: false,
        noEmit: opts.emit !== true,
        outDir,
        rootDir,
        module: "NodeNext",
        moduleResolution: "NodeNext"
      },
      include: ["generated.ts"]
    }),
    "utf8"
  );

  let output = "";
  let ok = true;
  try {
    output = execFileSync(process.execPath, [TSC_BIN, "-p", tsconfigPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    ok = false;
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return { ok, output, outDir: opts.emit === true ? outDir : undefined, rootDir };
}

export function cleanupCompile(result: CompileResult): void {
  rmSync(result.rootDir, { recursive: true, force: true });
}
