import { isLoopbackUrl } from "@/lib/loopbackHost";

/**
 * GH #780 — is a shared-catalog link built from this origin reachable only on
 * the local machine?
 *
 * On a packaged desktop install the embedded server is reached at
 * `http://localhost:3456`, so a `/share/<slug>` link built from
 * `window.location.origin` is loopback-only and isn't actually shareable. The
 * share page warns when that's the case (and points the user at the
 * Share-on-local-network toggle in Settings).
 *
 * We deliberately do NOT rewrite the link to the host's LAN IP: the
 * `/share/<slug>` page's "Import" action issues same-origin writes, so a
 * recipient opening a publisher-hosted LAN link would write into the
 * publisher's database rather than their own (Codex P2 on PR #784). Surfacing
 * the situation — not auto-generating a write-capable cross-instance link — is
 * the safe behaviour.
 *
 * A real (non-loopback) origin — e.g. a web/Docker deployment the user browsed
 * to via a LAN or public address — returns false and is never warned. An empty
 * origin (SSR, no `window`) returns false too.
 */
export function isShareLinkLocalOnly(origin: string): boolean {
  return origin !== "" && isLoopbackUrl(origin);
}
