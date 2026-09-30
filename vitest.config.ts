import { defineConfig } from "vitest/config";
import { transformWithOxc } from "vite";
import path from "path";

// packages/mobile sources, imported by the tests/mobile-*.test.ts suites.
// Vite's default transform loads the NEAREST tsconfig — for these,
// packages/mobile/tsconfig.json, which extends `expo/tsconfig.base` from
// packages/mobile/node_modules. Root CI never installs that, so the transform
// failed there. They are plain TypeScript (the mobile package type-checks them
// with its own config), so transform them with no tsconfig instead; every
// other file keeps the default transform and the root tsconfig.
const MOBILE_SOURCE = /\/packages\/mobile\/src\/.*\.tsx?$/;

export default defineConfig({
  oxc: { exclude: [/\.js$/, MOBILE_SOURCE] },
  plugins: [
    {
      name: "mobile-sources-without-expo-tsconfig",
      enforce: "pre",
      async transform(code, id) {
        const file = id.split("?")[0];
        if (!MOBILE_SOURCE.test(file)) return null;
        const result = await transformWithOxc(code, file, { lang: "ts", tsconfig: false });
        return { code: result.code, map: result.map };
      },
    },
  ],
  test: {
    globals: true,
    environment: "node",
    // The repo's entire suite lives in tests/. Scope discovery there so a
    // nested git worktree under .claude/worktrees/ (or any other checkout in
    // the tree) can't get its stale test copies swept into the run.
    include: ["tests/**/*.test.ts"],
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
        // The include globs also match packages/mobile/src/lib/**, which the
        // tests/mobile-*.test.ts suites import. The mobile package is its own
        // project, outside this gate.
        "packages/**",
      ],
      // The v1.61 coverage sweep drove src/lib + src/models to ~99% lines /
      // ~99% statements / ~97% functions / ~98% branches. The residual
      // uncovered branches are provably
      // unreachable defensive guards (Mongoose always materialises array
      // schema fields as [] and rejects invalid Dates at cast; the WHATWG URL
      // parser mandates a host for http(s); regexes that only capture finite
      // numerics; internal-consistency asserts). Thresholds sit just below the
      // achieved numbers so a genuine coverage regression trips CI while
      // normal churn (a new defensive branch here and there) doesn't.
      thresholds: {
        lines: 99,
        functions: 96,
        branches: 96,
        statements: 98,
      },
    },
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
    // file.
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // packages/mobile's write queue imports this React Native native
      // module; its tests run against an in-memory stand-in.
      "@react-native-async-storage/async-storage": path.resolve(
        __dirname,
        "./tests/stubs/asyncStorage.ts",
      ),
    },
  },
});
