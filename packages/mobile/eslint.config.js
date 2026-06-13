// https://docs.expo.dev/guides/using-eslint/
// Local flat config so `expo lint` uses Expo's rules for this package instead
// of falling through to the repo-root config (which ignores `packages/**`).
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'ios/*', 'android/*', '.expo/*'],
  },
]);
