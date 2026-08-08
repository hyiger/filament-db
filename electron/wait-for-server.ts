import http from "http";

/**
 * Poll the embedded Next.js server until it answers an HTTP request.
 *
 * Extracted from electron/main.ts so the probe's failure modes can be
 * unit-tested in isolation — main.ts executes Electron app setup at
 * import time and isn't importable from tests/ (same extraction pattern
 * as electron/csp-scope.ts).
 *
 * GH #1077: the original inline version read its 30s deadline ONLY
 * inside `req.on("error")` and set no socket timeout. Node's HTTP client
 * has no default response timeout, so a listener that completed the TCP
 * handshake and never wrote a response — the embedded server accepting
 * connections before it can serve, a wedged standalone server, or a
 * foreign process squatting the port — left the promise permanently
 * unsettled: the app hung at startup with no window and no error. Two
 * bounds close that:
 *
 *   1. a per-attempt socket timeout (`req.setTimeout` → `req.destroy()`)
 *      so an accepted-but-silent socket fails THAT attempt and retries
 *      (destroy() surfaces as the request's "error" event), and
 *   2. one overall deadline timer that settles the promise regardless of
 *      socket state.
 *
 * Every timer is cleared on settle, so nothing leaks after a successful
 * startup: the deadline is cleared on resolve, the retry timer only
 * exists between failed attempts, and the deadline path clears the retry
 * timer + destroys any in-flight request before rejecting.
 */
export function waitForServer(
  port: number,
  timeoutMs = 30000,
  attemptTimeoutMs = 2000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeReq: http.ClientRequest | null = null;
    let retryTimer: NodeJS.Timeout | null = null;

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      activeReq?.destroy();
      reject(new Error("Server startup timed out"));
    }, timeoutMs);

    function check() {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        res.resume();
        activeReq = null;
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve();
      });
      activeReq = req;
      // An accepted-but-silent socket must fail this attempt, not wait
      // forever. destroy() lands in the "error" handler below → retry.
      req.setTimeout(attemptTimeoutMs, () => req.destroy());
      req.on("error", () => {
        activeReq = null;
        if (settled) return;
        retryTimer = setTimeout(check, 500);
      });
    }
    check();
  });
}
