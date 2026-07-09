import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Web UI v1 (M2 stage 4, BUILD_AND_TEST.md §8 M2 item 2, DESIGN.md §14). Builds to static
 * assets served BY the Fastify server (apps/server/src/app.ts) — no dev-time proxy is needed
 * for `pnpm --filter @scp/web dev` against a local `pnpm --filter @scp/server dev` because both
 * halves speak the same-origin `/api/v1` path in production; for local dev-server iteration
 * (Vite's own port), same-origin cookie auth doesn't apply cross-port, so `pnpm dev` here is
 * useful for UI iteration on mocked/no-auth screens but the real login flow is exercised against
 * the built app served by apps/server (this is what `apps/web/e2e` drives, per its own README in
 * global-setup.ts) or via `vite preview` behind the server's static mount.
 *
 * CLAUDE.md air-gap requirement: zero external requests baked into the bundle — no CDN script
 * tags, no remote font `@import`s. `@tailwindcss/vite` needs no separate `tailwind.config.js`.
 *
 * Vitest's own config lives in the sibling vitest.config.ts, not here — merging `test` into this
 * file via `vitest/config`'s `defineConfig` pulls in a different bundled Vite version than the
 * project's pinned `vite`, which trips a plugin-type mismatch under `tsc` for
 * `@vitejs/plugin-react`/`@tailwindcss/vite`. Two small config files avoids that entirely.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
