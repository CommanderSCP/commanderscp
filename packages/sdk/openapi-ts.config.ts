import { defineConfig } from "@hey-api/openapi-ts";

/**
 * Generates the SDK core from the committed OpenAPI 3.1 spec (BUILD_AND_TEST.md §3.2).
 * `@hey-api/client-fetch` is a required runtime dependency of the generated client code —
 * `@hey-api/openapi-ts` has no client-less mode — everything else here mirrors DESIGN.md §15.
 */
export default defineConfig({
  input: "../../tools/openapi/openapi.v1.json",
  output: "src/generated",
  plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"]
});
