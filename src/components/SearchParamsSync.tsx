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
 * ## The feedback loop the CALLER must not create
 *
 * The page also WRITES the query string as its filters change, and those
 * writes come back through `useSearchParams`. Re-seeding from them would
 * re-run the state that produced them — a loop that fights the user's typing.
 *
 * Filtering that out is the PAGE's job: it owns the record of what it last
 * wrote, and CONSUMES that record when it matches. This component reports
 * every post-mount change and makes no judgement about who caused it.
 *
 * An earlier version took an `ownWrite` prop and advanced its own "last seen"
 * value to it, to compensate for a raw `history.replaceState` that the router
 * never observed. That is now unnecessary — the page writes through
 * `router.replace`, so `useSearchParams` sees it — and it was actively
 * harmful: advancing `seen` ahead of the router update meant the page's own
 * write never came back through here, so the marker was never consumed and
 * went stale, which is exactly the Back-restores-nothing bug it was meant to
 * prevent.
 */
export default function SearchParamsSync({
  onExternalChange,
}: {
  /** Called with the new query string (no leading `?`) whenever it changes
   *  after mount. The caller filters out its own writes. */
  onExternalChange: (search: string) => void;
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
    onExternalChange(search);
  }, [search, onExternalChange]);

  return null;
}
