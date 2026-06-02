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
        // GH #526: labelBitmap is the same shape — its public surface
        // (renderQrForTape, renderLabelBitmap, renderLabelPreviewDataUrl)
        // all build HTMLCanvasElement bitmaps via the browser-only
        // CanvasRenderingContext2D API. The pure encoder it composes on
        // top of (src/lib/labelEncoder.ts) IS tested. A proper test
        // would need jsdom + node-canvas in the test env, which is too
        // heavy for the regression value vs the encoder tests we
        // already have. Pinned in CLAUDE.md so a future contributor
        // knows the trade-off.
        "src/lib/labelBitmap.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 90,
        branches: 75,
        statements: 80,
      },
    },
    // Bumped from the 15s prior cap. The v1.32.0 release build (run
    // 26624712937) hit three consecutive Windows x64 failures with
    // different tests timing out at 15s each time; every failure was a
    // route-level test running queries against mongodb-memory-server.
    // Same root cause as `hookTimeout` below (cold-import + ESM-resolve
    // is slow on Windows runners) — the slowness manifests inside the
    // test body too, not just the hook, because the first
    // `Filament.find()` after a model is freshly re-registered triggers
    // the slow path. 30s matches hookTimeout and still catches genuine
    // hangs; healthy tests run in <1s so the new ceiling is ~30× their
    // typical budget. Tests on mac/linux are unaffected — they finish
    // well under either cap.
    testTimeout: 30000,
    // Same root cause as the `testTimeout` above: route-level test files
    // use a beforeEach that dynamically imports Mongoose models and
    // re-registers them on the connection (setup.ts wipes
    // mongoose.models between tests). On Windows the cold-import +
    // ESM-resolution path can blow past 10s on the first iteration of a
    // file, which used to fail the Windows release build (e.g.
    // tests/locations-route.test.ts beforeEach timed out in CI but
    // passed locally on macOS / Linux).
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
