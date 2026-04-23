import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ all: true } as any),
      include: [
        "src/lib/**",
        "src/models/**",
        "packages/shared/src/openprinttag/**",
        "packages/shared/src/logic/**",
        "packages/shared/src/ndef/**",
      ],
      exclude: [
        // Web-side files superseded by the shared package — the re-exports
        // live at src/lib/*.ts but the covered implementation is in
        // packages/shared/src/*.
        "src/lib/openprinttag.ts",
        "src/lib/openprinttag-decode.ts",
        "src/lib/resolveFilament.ts",
        // DOM-only helper: uses Image, canvas, URL.createObjectURL — can't
        // run in the Node test env. The pure helpers it exports
        // (dataUrlSizeBytes) are still tested; excluded here only to keep
        // function-coverage meaningful.
        "src/lib/compressImage.ts",
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
