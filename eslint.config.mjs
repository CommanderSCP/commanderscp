// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  crypto: "readonly",
  globalThis: "readonly",
  fetch: "readonly",
  __dirname: "readonly",
  __filename: "readonly"
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/drizzle/**",
      "packages/sdk/src/generated/**",
      "apps/web/dist/**",
      ".claude/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Type-aware linting for real package source only — standalone tool config files
    // (drizzle.config.ts, this file, etc.) aren't part of any package tsconfig's `include`.
    files: ["**/*.{ts,mts,cts}"],
    ignores: ["**/*.config.ts", "**/*.config.mts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: nodeGlobals
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ]
    }
  },
  {
    files: ["**/*.config.ts", "**/*.config.mts", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: nodeGlobals }
  },
  {
    // CommonJS, deliberately. `packages/source-census/test-support/spawn-observer-preload.cjs` is a
    // `node --require` preload and CANNOT be ESM: it has to mutate `node:child_process`'s exports
    // BEFORE any user module imports it, because Node copies a builtin's exports into its ESM facade
    // on first import — an `--import` preload that imported the module would already be too late,
    // and every "nothing was spawned" assertion built on it would silently watch nothing. So this is
    // the one place a `require()` is the correct construct rather than a legacy one.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...nodeGlobals, require: "readonly", module: "writable", exports: "writable" }
    },
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  // ---------------------------------------------------------------------------------------------
  // apps/web import boundary (BUILD_AND_TEST.md §8 M2 item 2 Part C, DESIGN.md §14): the SPA
  // "consumes only @scp/sdk" — it must never speak to the API via a raw fetch/XHR, never pull in
  // a third-party HTTP client, and never deep-import server/CLI/IaC source.
  //
  // `EventSource` used to carry a per-file exemption for src/lib/use-event-stream.ts, on the
  // grounds that SSE had no @scp/sdk equivalent. It has one now — `GET /events/stream` is declared
  // in the contract, so `client.events.stream()` is a generated operation like any other — and the
  // exemption block is DELETED rather than narrowed: the ban below applies to every file with no
  // exceptions.
  // ---------------------------------------------------------------------------------------------
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "apps/web talks to the API only via @scp/sdk's ScpClient — no raw fetch (CLAUDE.md, DESIGN.md §14)."
        },
        {
          name: "XMLHttpRequest",
          message:
            "apps/web talks to the API only via @scp/sdk's ScpClient — no raw XMLHttpRequest (CLAUDE.md, DESIGN.md §14)."
        },
        {
          name: "EventSource",
          message:
            "apps/web talks to the API only via @scp/sdk's ScpClient — the live stream included: use client.events.stream() (packages/sdk/src/event-stream.ts), never a raw EventSource."
        }
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "axios",
              message:
                "apps/web talks to the API only via @scp/sdk's ScpClient — no HTTP client libraries."
            },
            {
              name: "node-fetch",
              message:
                "apps/web talks to the API only via @scp/sdk's ScpClient — no HTTP client libraries."
            },
            {
              name: "ky",
              message:
                "apps/web talks to the API only via @scp/sdk's ScpClient — no HTTP client libraries."
            },
            {
              name: "superagent",
              message:
                "apps/web talks to the API only via @scp/sdk's ScpClient — no HTTP client libraries."
            },
            {
              name: "whatwg-fetch",
              message:
                "apps/web talks to the API only via @scp/sdk's ScpClient — no fetch polyfills."
            },
            {
              name: "@scp/server",
              message:
                "apps/web/src may import only @scp/sdk and @scp/schemas — never the server directly."
            },
            {
              name: "@scp/cli",
              message:
                "apps/web/src may import only @scp/sdk and @scp/schemas — never the CLI directly."
            },
            {
              name: "@scp/iac",
              message:
                "apps/web/src may import only @scp/sdk and @scp/schemas — never @scp/iac directly."
            }
          ],
          patterns: [
            {
              group: ["**/apps/server/**", "**/packages/cli/**", "**/packages/iac/**"],
              message:
                "apps/web/src may only import @scp/sdk and @scp/schemas for talking to the backend — no deep-relative imports into apps/server/packages/cli/packages/iac source."
            }
          ]
        }
      ]
    }
  }
);
