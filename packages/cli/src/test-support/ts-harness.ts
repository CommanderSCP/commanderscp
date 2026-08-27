import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TEST-ONLY. Compiles ONE generated TypeScript source file (`scp iac export --format ts`'s output,
 * or `scp iac scaffold`'s) against this repo's real strict tsconfig and the REAL `@scp/iac` package —
 * proving the emitter's stated guarantee ("emitted code must actually compile against the real
 * constructs", team-pipeline-iac.md §9) rather than assuming it.
 *
 * The temp project lives INSIDE `packages/cli`'s own directory tree (not `os.tmpdir()`) on purpose:
 * `packages/cli/node_modules/@scp/iac` is a real pnpm workspace symlink (`@scp/iac` is a dependency
 * of this package), so ordinary Node/TS module resolution finds it by walking UP from the compiled
 * file — no `paths` mapping, no dependency on where `os.tmpdir()` happens to point in CI.
 *
 * `emit: true` additionally writes JS to `outDir` so the round-trip test can `import()` and execute
 * it (`estate-program.test.ts`'s sibling in `@scp/iac` covers the same ground at the emitter-unit
 * level; this one proves it through the same compiler a real team's CI would run).
 */

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
