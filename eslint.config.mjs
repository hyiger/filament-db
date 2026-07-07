import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated / build output
    "coverage/**",
    "dist/**",
    "dist-electron/**",
    "electron-dist/**",
    "standalone/**",
    // Self-contained sub-packages with their own toolchain/lint (e.g. the
    // Expo mobile app) — linted from within packages/mobile, not by the
    // web/Electron root config.
    "packages/**",
    // Local Codex/Claude tooling + metadata (skills, launch.json,
    // settings.local.json, and generated worktree checkouts under
    // .claude/worktrees/). None of it is root-app source; a nested worktree
    // ships its own packages/mobile with CommonJS require() files that trip
    // the root rules (GH #990). ESLint flat config doesn't auto-ignore
    // dot-dirs (only node_modules/.git) and the `packages/**` entry above is
    // root-anchored, so it wouldn't catch `.claude/worktrees/*/packages/**`.
    // Mirrors vitest.config.ts's tests/-only scoping against the same class.
    ".claude/**",
  ]),
]);

export default eslintConfig;
