import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@blockshop/schema": src("schema"),
      "@blockshop/generator": src("generator"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
