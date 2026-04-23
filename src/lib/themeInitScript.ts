/**
 * Returns the inline script that applies the stored theme preference to
 * <html> BEFORE the React tree mounts. Injected into <head> by the root
 * layout. Without it, dark-mode users see a light-flash on every cold
 * load while React hydrates.
 *
 * Kept in a non-client module so it can be called from the server layout.
 * The actual provider lives in src/components/ThemeProvider.tsx.
 */

export const THEME_STORAGE_KEY = "filamentdb-theme";

export function themeInitScript(): string {
  return `(() => {
    try {
      var p = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || "system";
      var sys = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var dark = p === "dark" || (p === "system" && sys);
      if (dark) document.documentElement.classList.add("dark");
    } catch (_) {}
  })();`;
}
