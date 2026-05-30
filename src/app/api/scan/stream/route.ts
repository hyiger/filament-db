import { NextRequest } from "next/server";
import { getLastScan, subscribeScans, type ScanEvent } from "@/lib/scanBus";

/**
 * Server-Sent Events endpoint that emits each NFC scan as it's published.
 * Consumer of record is the PrusaSlicer / OrcaSlicer FilamentDB module,
 * which subscribes once at startup and reacts to each event by selecting
 * the matching filament preset by name (PrusaSlicer keys presets on the
 * name string).
 *
 * Event types:
 *   - `scan`   — fresh tag read, just decoded
 *   - `replay` — the most recent scan, sent once on connect so a slicer
 *                that opens just after a tag is read still picks it up.
 *                Skipped when `?replay=0` is set or no scan has happened
 *                yet this process lifetime.
 *
 * Heartbeats: a comment line (`: hb`) every 25s keeps proxies (and the
 * EventSource client) from idling the connection out.
 */

// Force the Node runtime so the EventEmitter-backed scanBus stays a real
// singleton — the Edge runtime would isolate per-request.
export const runtime = "nodejs";
// Streaming responses can't be statically rendered; opt out explicitly so
// future Next.js builds don't try to prerender this route.
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

/**
 * GH #428 — concurrent-subscriber cap. The bus uses
 * `EventEmitter.setMaxListeners(0)` to suppress Node's leak warning,
 * which means there's no upper bound on how many sub-processes can
 * attach. A misbehaving / hostile client on the LAN could open
 * thousands of long-lived SSE connections, each holding open a heart-
 * beat interval and a scan listener for the process lifetime.
 *
 * 100 concurrent is generously above any real workload — a typical
 * PrusaSlicer + Bambu Studio + browser-tab setup hits 3-5. Beyond
 * that we 429 the new connections; the existing ones keep working.
 * Cap is per-process (module-level counter), so this is local-only
 * mitigation; a multi-process deployment would need a shared limit.
 */
const MAX_CONCURRENT_SUBSCRIBERS = 100;
let activeSubscribers = 0;

function formatEvent(eventType: string, data: ScanEvent): Uint8Array {
  return encoder.encode(
    `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function GET(request: NextRequest) {
  // GH #428: enforce the concurrent-subscriber cap before allocating
  // any per-connection resources (listener, interval, ReadableStream).
  // 429 with a Retry-After signals the standard "back off, try again"
  // shape to EventSource consumers.
  if (activeSubscribers >= MAX_CONCURRENT_SUBSCRIBERS) {
    console.warn(
      `[scan/stream] Rejected SSE connection: ${activeSubscribers} active subscribers (cap=${MAX_CONCURRENT_SUBSCRIBERS})`,
    );
    return new Response("Too many active SSE subscribers", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }

  const replayParam = request.nextUrl.searchParams.get("replay");
  const replay = replayParam !== "0";

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let aborted = false;
  let counted = false;
  const release = () => {
    if (counted) {
      counted = false;
      activeSubscribers--;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      counted = true;
      activeSubscribers++;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (aborted) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Client gone — the cancel() path will tear down listeners.
        }
      };

      // SSE prelude: tell EventSource how long to wait before reconnecting
      // after a drop, and force a flush past any buffering proxy.
      safeEnqueue(encoder.encode("retry: 5000\n\n"));

      if (replay) {
        const last = getLastScan();
        if (last) safeEnqueue(formatEvent("replay", last));
      }

      unsubscribe = subscribeScans((event) => {
        safeEnqueue(formatEvent("scan", event));
      });

      heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(": hb\n\n"));
      }, HEARTBEAT_MS);

      // node-fetch / undici-style abort: when the client disconnects, the
      // request signal fires and we should tear down.
      request.signal.addEventListener("abort", () => {
        aborted = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        release();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      aborted = true;
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
      release();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defeat nginx-style response buffering — proxies otherwise hold the
      // stream until they have a "full" chunk, which never happens here.
      "x-accel-buffering": "no",
    },
  });
}
