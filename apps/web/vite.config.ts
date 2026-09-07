import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** The web build, and what it emits. See docs/web.md §514. */
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
