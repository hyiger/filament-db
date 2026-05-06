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
    // Bumped from the 10s default. Several route-level test files use a
    // beforeEach that dynamically imports Mongoose models and re-registers
    // them on the connection (setup.ts wipes mongoose.models between
    // tests). On Windows the cold-import + ESM-resolution path can blow
    // past 10s on the first iteration of a file, which used to fail the
    // Windows release build (e.g. tests/locations-route.test.ts beforeEach
    // timed out in CI but passed locally on macOS / Linux). 30s gives
    // enough headroom for the slowest Windows runner without masking real
    // hangs — the testTimeout above still catches stuck tests at 15s.
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
