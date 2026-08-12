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
 * Filtering that out is the PAGE's job, not this component's: the page owns
 * the record of what it last wrote, and it must CONSUME that record when it
 * matches. A marker left set makes a later external navigation to the same
 * query look like another page write — type `pla`, click the header link to
 * the bare route, press Back, and the URL returns to `?q=pla` while the list
 * stays unfiltered.
 */
export default function SearchParamsSync({
  onExternalChange,
  ownWrite,
}: {
  /** Called with the new query string (no leading `?`) whenever it changes
   *  after mount. The caller filters out its own writes. */
  onExternalChange: (search: string) => void;
  /**
   * The query string the PAGE currently intends the URL to have — i.e. what
   * its own filters serialize to.
   *
   * Needed because `useSearchParams` does NOT observe a manual
   * `history.replaceState`, so without this the "last seen" value goes stale
   * the moment the page writes the URL itself: at `/` it is `""`, the page
   * writes `?q=pla`, and a later navigation back to `/` then compares `""`
   * against `""` and reports nothing — leaving the list filtered under a bare
   * URL. Caught by a browser test, not by reasoning.
   */
  ownWrite: string;
}) {
  const params = useSearchParams();
  const search = params.toString();

  // The mount value is what the page already seeded from, so skip it — firing
  // on mount would re-run the seed with the same values for no reason, and on
  // the home page would re-trigger the filter fetch.
  const seen = useRef<string | null>(null);

  // Keep `seen` aligned with what the page itself put in the URL.
  useEffect(() => {
    seen.current = ownWrite;
  }, [ownWrite]);

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
