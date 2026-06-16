import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as decodeTag } from "@/app/api/nfc/decode/route";
import { generateOpenPrintTagBinary, type OpenPrintTagInput } from "@/lib/openprinttag";
import { wrapNdefForTag } from "@/lib/ndef";

/**
 * Route-level tests for POST /api/nfc/decode (GH: mobile-scanner Phase 0).
 *
 * The mobile scanner app reads raw NFC bytes on the phone and POSTs them here;
 * the server decodes (OpenPrintTag CBOR / Bambu MIFARE) and attaches a DB
 * match. These tests feed REAL byte streams (encoder output + MIFARE block
 * vectors) so the route is exercised end-to-end, not against a stub.
 */
describe("POST /api/nfc/decode", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function decodeReq(body: unknown) {
    return new NextRequest("http://localhost/api/nfc/decode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function b64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }

  const OPT_INPUT: OpenPrintTagInput = {
    materialName: "Prusament PLA Galaxy Black",
    brandName: "Prusament",
    materialType: "PLA",
    color: "#3d3e3dff",
    diameter: 1.75,
    nozzleTemp: 215,
    bedTemp: 60,
  };

  it("decodes an OpenPrintTag from a base64 CBOR payload", async () => {
    const cbor = generateOpenPrintTagBinary(OPT_INPUT);
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: b64(cbor) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decoded.materialName).toBe("Prusament PLA Galaxy Black");
    expect(body.decoded.brandName).toBe("Prusament");
    expect(body.decoded.materialType).toBe("PLA");
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it("decodes an OpenPrintTag from raw tag memory (runs the NDEF parser)", async () => {
    const cbor = generateOpenPrintTagBinary(OPT_INPUT);
    const tagMemory = wrapNdefForTag(cbor, 320);
    const res = await decodeTag(
      decodeReq({ tagType: "openprinttag", tagMemory: b64(tagMemory) }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decoded.materialName).toBe("Prusament PLA Galaxy Black");
  });

  it("attaches a confident DB match for a known filament", async () => {
    await Filament.create({
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
    });
    const cbor = generateOpenPrintTagBinary(OPT_INPUT);
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: b64(cbor) }));
    const body = await res.json();
    expect(body.match?.name).toBe("Prusament PLA Galaxy Black");
    // Matched by name (the tag carries no spool_uid), so the scanner treats it
    // as a heuristic match — not a confident "this exact tag is in the DB".
    expect(body.matchedBy).toBe("heuristic");
    expect(body.candidates).toEqual([]);
  });

  it("matches by instanceId carried in the tag's spoolUid (FDB-written tag)", async () => {
    // A Filament-DB-written OpenPrintTag stores the filament's instanceId in
    // spool_uid. Even when the on-tag name differs from the DB row, the decode
    // endpoint should resolve it by instanceId — the strongest signal.
    await Filament.create({
      name: "Renamed In DB",
      vendor: "Prusament",
      type: "PLA",
      instanceId: "abc1230000",
    });
    const cbor = generateOpenPrintTagBinary({
      materialName: "Old Tag Name",
      brandName: "Prusament",
      materialType: "PLA",
      spoolUid: "abc1230000",
    });
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: b64(cbor) }));
    const body = await res.json();
    expect(body.match?.name).toBe("Renamed In DB");
    expect(body.match?.instanceId).toBe("abc1230000");
    // The matched row's id equals the queried spool_uid → confident exact tag.
    expect(body.matchedBy).toBe("instanceId");
    expect(body.candidates).toEqual([]);
    // #732: this is a FILAMENT-level (fallback) hit, so no spool is reported.
    expect(body.matchedSpool).toBeNull();
  });

  it("#732: matches a tag's spoolUid against a spools[].instanceId and reports the spool", async () => {
    // A Phase-3-written tag stores the SPOOL's instanceId in spool_uid. The
    // decode endpoint resolves it to the spool, and matchedBy stays "instanceId"
    // even though the matched filament's top-level instanceId differs.
    const f = await Filament.create({
      name: "Spool Tag PLA",
      vendor: "Prusament",
      type: "PLA",
      spools: [{ label: "Drybox 3", totalWeight: 1000, instanceId: "5p001dcafe" }],
    });
    const cbor = generateOpenPrintTagBinary({
      materialName: "On-tag name",
      brandName: "Prusament",
      materialType: "PLA",
      spoolUid: "5p001dcafe",
    });
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: b64(cbor) }));
    const body = await res.json();
    expect(body.match?.name).toBe("Spool Tag PLA");
    expect(body.matchedBy).toBe("instanceId");
    expect(body.matchedSpool).toMatchObject({
      instanceId: "5p001dcafe",
      label: "Drybox 3",
      _id: String(f.spools[0]._id),
    });
  });

  it("returns candidates (no auto-match) on an ambiguous vendor+type", async () => {
    await Filament.create({ name: "Bambu PLA Black", vendor: "Bambu Lab", type: "PLA" });
    await Filament.create({ name: "Bambu PLA White", vendor: "Bambu Lab", type: "PLA" });
    // materialName won't exact-match either row, but vendor+type matches both.
    const cbor = generateOpenPrintTagBinary({
      materialName: "Some Bambu PLA",
      brandName: "Bambu Lab",
      materialType: "PLA",
    });
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: b64(cbor) }));
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.matchedBy).toBeNull();
    expect(
      body.candidates.map((c: { name: string }) => c.name).sort(),
    ).toEqual(["Bambu PLA Black", "Bambu PLA White"]);
  });

  it("decodes a Bambu MIFARE tag from base64 blocks", async () => {
    const block = (writer: (b: Buffer) => void): string => {
      const b = Buffer.alloc(16);
      writer(b);
      return b.toString("base64");
    };
    const res = await decodeTag(
      decodeReq({
        tagType: "bambu",
        blocks: {
          "1": block((b) => {
            b.write("A50-K0", 0, "ascii");
            b.write("GFA50", 8, "ascii");
          }),
          "2": block((b) => b.write("PLA Basic", 0, "ascii")),
          "5": block((b) => {
            b[0] = 0xff;
            b[1] = 0x00;
            b[2] = 0x00;
            b[3] = 0xff;
          }),
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decoded.brandName).toBe("Bambu Lab");
    expect(body.decoded.materialType).toBe("PLA");
    expect(body.decoded.color).toBe("#ff0000");
    expect(body.decoded.readOnly).toBe(true);
  });

  it("rejects an unknown tagType with 415", async () => {
    const res = await decodeTag(decodeReq({ tagType: "nfc-mystery" }));
    expect(res.status).toBe(415);
  });

  it("rejects an OpenPrintTag request with neither payload nor tagMemory (400)", async () => {
    const res = await decodeTag(decodeReq({ tagType: "openprinttag" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Could not decode tag");
  });

  it("rejects a Bambu request with no blocks object (400)", async () => {
    const res = await decodeTag(decodeReq({ tagType: "bambu" }));
    expect(res.status).toBe(400);
  });

  it("rejects a Bambu request whose blocks is an array, not an object (400)", async () => {
    const res = await decodeTag(decodeReq({ tagType: "bambu", blocks: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty Bambu blocks map rather than fabricating a tag (400)", async () => {
    // Codex P2 (PR #690): {} used to parse into an all-zero array and return
    // 200 with brandName "Bambu Lab" / black color — a failed read must 400.
    const res = await decodeTag(decodeReq({ tagType: "bambu", blocks: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Could not decode tag");
  });

  it("rejects Bambu blocks carrying no identity blocks (only an unread sector)", async () => {
    // A 16-byte block at an index the parser doesn't read for identity (e.g. a
    // sector trailer) leaves filamentType/variant/detailed all empty.
    const b3 = Buffer.alloc(16).toString("base64");
    const res = await decodeTag(decodeReq({ tagType: "bambu", blocks: { "3": b3 } }));
    expect(res.status).toBe(400);
  });

  it("rejects a body whose declared Content-Length exceeds the cap (413)", async () => {
    const req = new NextRequest("http://localhost/api/nfc/decode", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
      body: JSON.stringify({ tagType: "openprinttag", payload: "" }),
    });
    const res = await decodeTag(req);
    expect(res.status).toBe(413);
  });

  it("rejects undecodable bytes with 400", async () => {
    const garbage = b64(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff]));
    const res = await decodeTag(decodeReq({ tagType: "openprinttag", payload: garbage }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await decodeTag(decodeReq("this is not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON");
  });

  it("rejects a non-object JSON body with 400", async () => {
    const res = await decodeTag(decodeReq("123"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Request body must be an object");
  });
});
