import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as stream } from "@/app/api/scan/stream/route";
import {
  publishScan,
  resetScanBusForTests,
  subscribeScans,
  type ScanEvent,
} from "@/lib/scanBus";

function streamReq(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/scan/stream${query}`);
}

function sampleEvent(over: Partial<ScanEvent> = {}): ScanEvent {
  return {
    timestamp: 1,
    filament: {
      _id: "abc",
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
      color: "#000000",
    },
    candidates: [],
    decoded: { materialName: "Prusament PLA Galaxy Black" },
    ...over,
  };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const { value, done } = await reader.read();
  if (done || !value) return "";
  return new TextDecoder().decode(value);
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (acc: string) => boolean,
  budgetMs = 1000,
): Promise<string> {
  let acc = "";
  const deadline = Date.now() + budgetMs;
  while (!predicate(acc)) {
    if (Date.now() > deadline) {
      throw new Error(`readUntil timed out. Accumulated: ${JSON.stringify(acc)}`);
    }
    const chunk = await readChunk(reader);
    if (!chunk) break;
    acc += chunk;
  }
  return acc;
}

describe("GET /api/scan/stream", () => {
  beforeEach(() => {
    resetScanBusForTests();
  });

  it("sets SSE response headers", async () => {
    const res = await stream(streamReq());
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("sends the retry prelude immediately on connect", async () => {
    const res = await stream(streamReq());
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes("retry:"));
    expect(text).toContain("retry: 5000");
    await reader.cancel();
  });

  it("replays the last scan on connect when one exists", async () => {
    publishScan(sampleEvent({ timestamp: 42 }));
    const res = await stream(streamReq());
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes("event: replay"));
    expect(text).toContain("event: replay");
    // The replay payload should be a JSON object on a data: line.
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse(dataLine!.slice("data: ".length));
    expect(parsed.timestamp).toBe(42);
    await reader.cancel();
  });

  it("skips replay when ?replay=0 is set", async () => {
    publishScan(sampleEvent({ timestamp: 42 }));
    const res = await stream(streamReq("?replay=0"));
    const reader = res.body!.getReader();
    const text = await readUntil(reader, (t) => t.includes("retry:"));
    expect(text).not.toContain("event: replay");
    await reader.cancel();
  });

  it("forwards a freshly published scan to a connected subscriber", async () => {
    const res = await stream(streamReq("?replay=0"));
    const reader = res.body!.getReader();
    // Drain the prelude
    await readUntil(reader, (t) => t.includes("retry:"));

    publishScan(sampleEvent({ timestamp: 99 }));

    const text = await readUntil(reader, (t) => t.includes("event: scan"));
    expect(text).toContain("event: scan");
    const dataLine = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .at(-1);
    const parsed = JSON.parse(dataLine!.slice("data: ".length));
    expect(parsed.timestamp).toBe(99);
    await reader.cancel();
  });

  it("returns 429 when the concurrent-subscriber cap is exceeded (GH #428)", async () => {
    // Open subscriptions up to the cap and verify the next one is
    // rejected. 100 connections is the in-module cap; we just verify
    // the 101st gets the 429 + Retry-After contract.
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const res = await stream(streamReq("?replay=0"));
        expect(res.status).toBe(200);
        readers.push(res.body!.getReader());
      }
      const denied = await stream(streamReq("?replay=0"));
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe("60");
    } finally {
      for (const r of readers) await r.cancel().catch(() => {});
    }
    // After cancelling all opened streams, a fresh connection should
    // pass again — the cap is per-active-subscriber, not lifetime.
    const fresh = await stream(streamReq("?replay=0"));
    expect(fresh.status).toBe(200);
    await fresh.body!.getReader().cancel();
  });

  it("unsubscribes from the bus when the stream is cancelled", async () => {
    const res = await stream(streamReq("?replay=0"));
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes("retry:"));

    // Snapshot subscriber count by adding a sentinel and counting deliveries.
    let sentinelDeliveries = 0;
    subscribeScans(() => {
      sentinelDeliveries += 1;
    });

    // Cancel the SSE stream.
    await reader.cancel();

    // After cancel, publishing should only hit our sentinel, not the
    // already-cancelled SSE listener. If the cancel path leaked, the
    // bus would try to enqueue on a closed controller. Easiest signal:
    // no throw, and the sentinel still fires.
    publishScan(sampleEvent({ timestamp: 7 }));
    expect(sentinelDeliveries).toBe(1);
  });
});
