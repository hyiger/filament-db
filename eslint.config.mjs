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
  ]),
]);

export default eslintConfig;
