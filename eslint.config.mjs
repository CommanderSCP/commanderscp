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
      "apps/web/dist/**"
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
  // ---------------------------------------------------------------------------------------------
  // apps/web import boundary (BUILD_AND_TEST.md §8 M2 item 2 Part C, DESIGN.md §14): the SPA
  // "consumes only @scp/sdk" — it must never speak to the API via a raw fetch/XHR, never pull in
  // a third-party HTTP client, and never deep-import server/CLI/IaC source. The ONE necessary
  // exception is `EventSource` (SSE has no @scp/sdk equivalent — a browser primitive with no
  // request-body/header story other than cookies), sanctioned ONLY in
  // apps/web/src/lib/use-event-stream.ts via the narrower override block below, which — because
  // flat config resolves each rule from the LAST matching block for a given file — structurally
  // re-permits just that one global for just that one file, rather than an inline
  // eslint-disable comment scattered wherever someone feels like reaching for `EventSource`.
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
            "EventSource has no @scp/sdk equivalent — it's sanctioned ONLY in src/lib/use-event-stream.ts, which has its own override block in eslint.config.mjs permitting it."
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
  },
  {
    // The one sanctioned EventSource file (module doc there explains why) — re-declaring
    // `no-restricted-globals` WITHOUT `EventSource` here wins over the block above for this file
    // only, because flat config takes the last matching block per rule key.
    files: ["apps/web/src/lib/use-event-stream.ts"],
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
        }
      ]
    }
  }
);
