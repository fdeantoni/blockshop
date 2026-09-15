import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@blockshop/schema": fileURLToPath(new URL("../schema/src/index.ts", import.meta.url)) },
  },
  server: {
    host: true,
    proxy: {
      "/api": "http://localhost:8080",
      "/p": "http://localhost:8080",
      "/java": "http://localhost:8080",
    },
  },
  // three.js is one large chunk by design; the editor is a single page. The licenses of everything bundled
  // (three.js, zod) are written next to it and linked from the footer.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200, license: { fileName: "third-party-licenses.txt" } },
});
