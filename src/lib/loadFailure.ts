/**
 * GH #1231: work out why a page's data request failed, so the page can show
 * the database hint instead of a bare "Failed to load…" followed by an empty
 * state ("No filaments found.", "No spools… add one") that invites the user
 * to create data while the database is down.
 *
 * A 503 from this API already says `{code: "db_unavailable", kind}`. Most
 * read routes still answer a generic 500, and a request that never got an
 * answer has no body at all, so in both cases `/api/health` is asked
 * instead. `dbConnect` replays a classified failure for a few seconds, so
 * that probe returns at once rather than waiting out another connection
 * timeout.
 */
import { dbErrorFromBody, type DbErrorInfo } from "./dbErrorKinds";

export interface LoadFailure {
  /** Why the database is unreachable; null when the failure isn't (known to
   *  be) a database problem, and the page shows its own generic message. */
  db: DbErrorInfo | null;
}

/**
 * `res` is the failed response, or null when the request threw. Pass the
 * page's AbortSignal so an aborted load doesn't keep probing; callers must
 * still check `signal.aborted` before using the result.
 */
export async function describeLoadFailure(
  res: Response | null,
  signal?: AbortSignal,
): Promise<LoadFailure> {
  if (res) {
    const fromBody = dbErrorFromBody(await res.json().catch(() => null));
    if (fromBody) return { db: fromBody };
  }
  try {
    const health = await fetch("/api/health", { signal, cache: "no-store" });
    if (!health.ok) {
      const fromHealth = dbErrorFromBody(await health.json().catch(() => null));
      if (fromHealth) return { db: fromHealth };
    }
  } catch {
    // The server itself is unreachable, or the load was aborted: there is
    // nothing more specific to say than the page's own message.
  }
  return { db: null };
}
