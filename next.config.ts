import type { NextConfig } from "next";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",").map(s => s.trim())
    : [],
  env: {
    APP_VERSION: pkg.version,
  },
  experimental: {
    // GH #878: `src/proxy.ts` runs on every `/api/*` request, and Next buffers
    // the request body so it can be read in both the proxy and the route. That
    // buffer defaults to 10MB — over which Next silently keeps only the first
    // 10MB and lets the request continue with a PARTIAL body (it does not error).
    // `POST /api/snapshot` accepts up to 50MB (MAX_SNAPSHOT_SIZE), so a valid
    // 10–50MB backup was truncated before the handler, parsed as partial JSON,
    // and rejected with a misleading "Invalid JSON in snapshot file" instead of
    // restoring (or returning the route's real 413). Raise the cap above the
    // largest accepted route body (50MB) with headroom for the multipart
    // envelope, so legitimate bodies reach the handler and the route's own size
    // guard stays authoritative. Keep this >= MAX_SNAPSHOT_SIZE.
    proxyClientMaxBodySize: "52mb",
  },
  async headers() {
    // GH #225 — Content-Security-Policy:
    //
    // Adds CSP alongside the existing X-Content-Type-Options /
    // X-Frame-Options / Referrer-Policy trio. Matters most for the
    // Docker / web deployment — Electron's contextIsolation already
    // sandboxes the renderer.
    //
    // Why `'unsafe-inline'` on `script-src` and `style-src`:
    //
    // - `script-src`: Next.js streams the React Server Components flight
    //   protocol via inline `<script>` payloads on first paint. There's no
    //   stable nonce we can plumb in without a per-request middleware
    //   layer (see #225 follow-up — move to nonce-based once we have a
    //   custom edge middleware). The anti-FOUC theme-init script in
    //   `src/lib/themeInitScript.ts` is also inline. Until both move to
    //   a nonce, `'unsafe-inline'` is the price of having CSP at all on
    //   this codebase.
    // - `style-src`: Tailwind emits inline `<style>` tags (its preflight
    //   and the JIT-compiled atomic classes) and swagger-ui-react injects
    //   per-component styles into the head. Both rely on `'unsafe-inline'`.
    //
    // `img-src` allows `data:` and `blob:` so the spool photo-data-URL
    // pipeline (`src/lib/validateSpoolBody.ts` accepts those MIMEs) keeps
    // working. `https:` covers TDS-extracted thumbnails and product
    // photos. `connect-src 'self'` limits fetch/XHR to same-origin —
    // the /api/embed-check + TDS extractor routes are server-side and
    // unaffected. `frame-ancestors 'none'` matches X-Frame-Options:
    // DENY.
    //
    // Tightening checklist for follow-up:
    //   - Per-request nonce middleware → drop 'unsafe-inline' on
    //     script-src and style-src (Tailwind v4 supports nonces via
    //     buildEsbuild).
    //   - Hash-pin the theme-init script.
    //   - Consider report-uri once we have an endpoint.
    // GH #344: React's RSC client uses `eval()` in development for
    // debugging features (callstack reconstruction from cross-environment
    // payloads). Without `'unsafe-eval'` in dev, the browser console logs
    // an error on every page and the Next.js devtools badge surfaces a
    // permanent "1 Issue", drowning real app errors during QA.
    //
    // Production builds never use eval(); keep the production CSP tight
    // by only adding `'unsafe-eval'` when NODE_ENV !== "production".
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";

    const csp = [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      // GH #250 — the filament detail page renders an embeddable vendor
      // TDS document in an <iframe> once /api/embed-check confirms the
      // vendor permits framing. Without an explicit frame-src that load
      // falls back to default-src 'self' and the browser blocks it, so
      // the "view TDS" feature silently fails. Restrict to https so only
      // TLS-served documents can be framed.
      "frame-src https:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
