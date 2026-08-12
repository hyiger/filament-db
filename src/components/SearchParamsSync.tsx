"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Report query-string changes that this page did not make itself (GH #1141).
 *
 * ## Why it exists
 *
 * A list page seeds its filters from the URL once, on mount. That misses a
 * client-side navigation to the SAME route: clicking the persistent header's
 * `/` link while at `/?q=pla` reuses the mounted page, so the mount effect does
 * not run again — the URL goes bare while React state stays filtered, and the
 * next refresh then clears what the UI was still showing.
 *
 * ## Why it is a separate component
 *
 * `useSearchParams()` requires a Suspense boundary in a statically prerendered
 * client page, or the production build fails. Wrapping a whole list page would
 * ship an empty shell in the initial HTML. Isolating the subscription in a
 * render-nothing child means only THIS component suspends — the page around it
 * prerenders exactly as before.
 *
 * Mount it as:
 *
 * ```tsx
 * <Suspense fallback={null}>
 *   <SearchParamsSync onExternalChange={reseedFromUrl} />
 * </Suspense>
 * ```
 *
 * ## The feedback loop this must not create
 *
 * The page also WRITES the query string as its filters change. Those writes
 * come back through `useSearchParams`, so reporting them would re-seed the
 * state that just produced them — a loop, and one that would fight the user's
 * typing. The page therefore passes what it last wrote via `ownWrite`, and
 * anything matching it is ignored. Only a change from somewhere else — a link,
 * Back/Forward, an external `pushState` — is reported.
 */
export default function SearchParamsSync({
  onExternalChange,
  ownWrite,
}: {
  /** Called with the new query string (no leading `?`) when something OTHER
   *  than this page changed it. */
  onExternalChange: (search: string) => void;
  /** The query string this page most recently wrote, so its own writes can be
   *  distinguished from everyone else's. */
  ownWrite: React.RefObject<string | null>;
}) {
  const params = useSearchParams();
  const search = params.toString();

  // The mount value is what the page already seeded from, so skip it — firing
  // on mount would re-run the seed with the same values for no reason, and on
  // the home page would re-trigger the filter fetch.
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = search;
      return;
    }
    if (seen.current === search) return;
    seen.current = search;
    if (ownWrite.current === search) return; // our own replaceState came back
    onExternalChange(search);
  }, [search, onExternalChange, ownWrite]);

  return null;
}
