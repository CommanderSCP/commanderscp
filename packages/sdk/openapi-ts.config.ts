import { defineConfig } from "@hey-api/openapi-ts";

/** Generates the SDK core from the committed OpenAPI 3.1 spec. See docs/sdk.md §1. */
export default defineConfig({
  input: "../../tools/openapi/openapi.v1.json",
  output: "src/generated",
  plugins: [
    "@hey-api/client-fetch",
    "@hey-api/typescript",
    { name: "zod", requests: false, definitions: false, metadata: false },
    { name: "@hey-api/sdk", validator: { response: "zod" } }
  ]
});
