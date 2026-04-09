import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      all: true,
      include: [
        "src/lib/**",
        "src/models/**",
        "packages/shared/src/openprinttag/**",
        "packages/shared/src/logic/**",
        "packages/shared/src/ndef/**",
      ],
      exclude: [
        "src/lib/openprinttag.ts",
        "src/lib/openprinttag-decode.ts",
        "src/lib/resolveFilament.ts",
        "**/index.ts",
        "packages/shared/src/logic/spoolCheck.ts",
        "packages/shared/src/logic/validation.ts",
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
      "@filament-db/shared": path.resolve(__dirname, "./packages/shared/src"),
    },
  },
});
