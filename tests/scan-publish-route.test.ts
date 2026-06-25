import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST as publish } from "@/app/api/scan/publish/route";
import {
  getLastScan,
  resetScanBusForTests,
  subscribeScans,
  type ScanEvent,
} from "@/lib/scanBus";

function postJson(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/scan/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/scan/publish", () => {
  beforeEach(() => {
    resetScanBusForTests();
  });

  it("emits a scan event to subscribers and caches it as last", async () => {
    const received: ScanEvent[] = [];
    subscribeScans((e) => received.push(e));

    const before = Date.now();
    const res = await publish(
      postJson({
        filament: {
          _id: "abc",
          name: "Prusament PLA Galaxy Black",
          vendor: "Prusament",
          type: "PLA",
          color: "#000000",
        },
        candidates: [],
        decoded: {
          materialName: "Prusament PLA Galaxy Black",
          brandName: "Prusament",
          materialType: "PLA",
          tagSource: "openprinttag",
        },
      }),
    );

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.filament?._id).toBe("abc");
    expect(received[0]!.decoded.tagSource).toBe("openprinttag");
    expect(received[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(getLastScan()).toEqual(received[0]);
  });

  it("#864: propagates an opentag3d tagSource through the scan bus", async () => {
    const received: ScanEvent[] = [];
    subscribeScans((e) => received.push(e));

    const res = await publish(
      postJson({
        filament: { _id: "ot3d1", name: "PETG Sky", vendor: "Polar Filament", type: "PETG" },
        candidates: [],
        decoded: { materialName: "PETG", brandName: "Polar Filament", tagSource: "opentag3d" },
      }),
    );

    expect(res.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0]!.decoded.tagSource).toBe("opentag3d");
  });

  it("round-trips a valid matchedSpool and drops a malformed one (#732)", async () => {
    const received: ScanEvent[] = [];
    subscribeScans((e) => received.push(e));

    // Valid matched spool → carried through to the event.
    await publish(
      postJson({
        filament: { _id: "abc", name: "PLA", vendor: "V", type: "PLA", color: "#000" },
        candidates: [],
        matchedSpool: { _id: "sp1", instanceId: "5p001dcafe", label: "Drybox" },
        decoded: { materialName: "PLA" },
      }),
    );
    expect(received[0]!.matchedSpool).toEqual({
      _id: "sp1",
      instanceId: "5p001dcafe",
      label: "Drybox",
    });

    // Malformed matchedSpool (missing instanceId) → dropped to null, scan still
    // accepted on its decoded fields.
    await publish(
      postJson({
        filament: null,
        candidates: [],
        matchedSpool: { _id: "sp2" },
        decoded: { materialName: "PLA" },
      }),
    );
    expect(received[1]!.matchedSpool).toBeNull();
  });

  it("accepts a no-match scan as long as decoded fields are present", async () => {
    const res = await publish(
      postJson({
        filament: null,
        candidates: [],
        decoded: { materialName: "Unknown ASA", brandName: "Generic" },
      }),
    );
    expect(res.status).toBe(202);
    expect(getLastScan()?.filament).toBeNull();
    expect(getLastScan()?.decoded.materialName).toBe("Unknown ASA");
  });

  it("rejects a body with no match and no decoded fields", async () => {
    const res = await publish(
      postJson({ filament: null, candidates: [], decoded: {} }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/scan/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await publish(req);
    expect(res.status).toBe(400);
  });

  it("strips unknown fields and ignores non-string candidate entries", async () => {
    const res = await publish(
      postJson({
        filament: {
          _id: "x",
          name: "n",
          vendor: "v",
          type: "t",
          color: "#ffffff",
          // Unknown field — must be dropped by the route's allow-list pick.
          maliciousScript: "<script>",
        },
        candidates: [
          { _id: "y", name: "y", vendor: "v", type: "t", color: "" },
          "not-an-object",
          { name: "no-id" },
          null,
        ],
        decoded: {
          materialName: "n",
          // unknown tagSource is dropped
          tagSource: "unknown",
        },
      }),
    );
    expect(res.status).toBe(202);
    const event = getLastScan()!;
    expect(event.filament).toEqual({
      _id: "x",
      name: "n",
      vendor: "v",
      type: "t",
      color: "#ffffff",
    });
    expect(event.candidates).toHaveLength(1);
    expect(event.candidates[0]!._id).toBe("y");
    expect(event.decoded.tagSource).toBeUndefined();
  });
});
