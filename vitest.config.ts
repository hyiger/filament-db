import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/lib/**", "src/models/**"],
      exclude: [
        // DOM-only helper: uses Image, canvas, URL.createObjectURL — can't
        // run in the Node test env. The pure helpers it exports
        // (dataUrlSizeBytes) are still tested; excluded here only to keep
        // function-coverage meaningful.
        "src/lib/compressImage.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 90,
        branches: 75,
        statements: 80,
      },
    },
    testTimeout: 15000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
