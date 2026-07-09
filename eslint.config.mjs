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
  }
);
