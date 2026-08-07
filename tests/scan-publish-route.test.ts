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

  it("#1076: rejects a body whose declared Content-Length exceeds 64 KB (413)", async () => {
    const req = new NextRequest("http://localhost/api/scan/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
      body: JSON.stringify({
        filament: { _id: "a", name: "n" },
        candidates: [],
        decoded: {},
      }),
    });
    const res = await publish(req);
    expect(res.status).toBe(413);
    // Codex P2 on PR #1090: the shared checkContentLength used to format the
    // limit in MB with toFixed(0), rendering this route's 64 KB cap as the
    // nonsensical "Maximum is 0 MB." — pin the corrected KB label.
    expect((await res.json()).error).toMatch(/Maximum is 64 KB\./);
    // Nothing published — the retained last scan stays empty.
    expect(getLastScan()).toBeNull();
  });

  it("#1076: rejects an oversized body even when Content-Length understates it (413)", async () => {
    // Post-buffer byteLength re-check: the preflight passes on the lying
    // header, then the buffered body trips the cap (#991 pattern).
    const body = JSON.stringify({
      filament: { _id: "a", name: "x".repeat(70_000) },
      candidates: [],
      decoded: {},
    });
    const req = new NextRequest("http://localhost/api/scan/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
      body,
    });
    const res = await publish(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(getLastScan()).toBeNull();
  });

  it("#1076: truncates every copied string field to its per-field bound", async () => {
    const long = "n".repeat(1_000);
    const longId = "i".repeat(1_000);
    const res = await publish(
      postJson({
        filament: {
          _id: longId,
          name: long,
          vendor: long,
          type: long,
          color: long,
        },
        candidates: [
          { _id: longId, name: long, vendor: long, type: long, color: long },
        ],
        matchedSpool: { _id: longId, instanceId: longId, label: long },
        decoded: {
          materialName: long,
          brandName: long,
          materialType: long,
          color: long,
          spoolUid: long,
          tagSource: "openprinttag",
        },
      }),
    );
    expect(res.status).toBe(202);
    const event = getLastScan()!;
    // ids → 128 (the app-wide instanceId bound, validateSpoolInstanceId);
    // text fields → 256; label keeps its pre-existing 200-char slice.
    expect(event.filament!._id).toHaveLength(128);
    expect(event.filament!.name).toHaveLength(256);
    expect(event.filament!.vendor).toHaveLength(256);
    expect(event.filament!.type).toHaveLength(256);
    expect(event.filament!.color).toHaveLength(256);
    expect(event.candidates[0]!._id).toHaveLength(128);
    expect(event.candidates[0]!.name).toHaveLength(256);
    expect(event.matchedSpool!._id).toHaveLength(128);
    expect(event.matchedSpool!.instanceId).toHaveLength(128);
    expect(event.matchedSpool!.label).toHaveLength(200);
    expect(event.decoded.materialName).toHaveLength(256);
    expect(event.decoded.brandName).toHaveLength(256);
    expect(event.decoded.materialType).toHaveLength(256);
    expect(event.decoded.color).toHaveLength(256);
    expect(event.decoded.spoolUid).toHaveLength(256);
    // Truncation must not disturb the non-string passthroughs.
    expect(event.decoded.tagSource).toBe("openprinttag");
  });

  it("#1076: a max-length legitimate instanceId (128 chars) rides through untruncated", async () => {
    // validateSpoolInstanceId accepts 1–128 chars — the bound must not
    // corrupt the longest legitimate spool id.
    const legit = "a".repeat(128);
    await publish(
      postJson({
        filament: { _id: "abc", name: "PLA", vendor: "V", type: "PLA", color: "#000" },
        candidates: [],
        matchedSpool: { _id: "sp1", instanceId: legit, label: "Box" },
        decoded: { materialName: "PLA" },
      }),
    );
    expect(getLastScan()!.matchedSpool!.instanceId).toBe(legit);
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
