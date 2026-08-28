import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";
import { parseNdefRecordsAuto } from "@/lib/ndef";
import { decodeFromNdefRecords } from "@/lib/tagCodecs";
import { decodeOpenTag3DTag } from "@/lib/opentag3d-decode";
import { parseBambuBlocks, bambuToDecodedTag } from "@/lib/bambuTag";
import { matchFilament } from "@/lib/matchFilament";
import {
  errorResponse,
  errorResponseFromCaught,
  checkContentLength,
} from "@/lib/apiErrorHandler";

/**
 * POST /api/nfc/decode — decode raw NFC tag bytes server-side and attach a
 * DB match. The mobile scanner is a thin client (read bytes → POST here →
 * render); the decode logic lives server-side because Bambu decoding needs
 * Node crypto that won't run in React Native, and one tested code path
 * can't drift from the desktop reader.
 *
 * Request (application/json):
 *   { tagType: "openprinttag" | "opentag3d" | "bambu",
 *     payload?: base64,    // pre-parsed NDEF record payload — preferred
 *     tagMemory?: base64,  // raw tag memory — auto-sniffed
 *     blocks?: { [blockNumber: string]: base64 } }  // Bambu MIFARE
 *
 * Response 200: { decoded, match, candidates, matchedBy, matchedSpool }.
 * Errors: 400 invalid body / undecodable bytes; 415 unknown tagType.
 *
 * Intentionally NOT behind assertSameOriginRequest (like
 * GET /api/filaments/match): no mutation, and it must be reachable by the
 * cross-origin mobile app. When FILAMENTDB_API_KEY is set, src/proxy.ts
 * gates EVERY /api caller — the optional key, not the origin guard, gates
 * off-device access here.
 */

// Tag data is tiny (~320 B–1 KB; base64 inflates ~33%) — 64 KB is a
// generous ceiling that still bounds the parse work a hostile caller can
// trigger.
const MAX_DECODE_BODY = 64 * 1024;

function toBytes(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Bound a decoded string before it feeds matchFilament's regex queries. */
function boundedField(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

/**
 * Decode an NDEF-borne tag (OpenPrintTag or OpenTag3D, #864).
 * - `payload` (pre-parsed record payload, no framing to sniff): `tagType`
 *   selects the codec. Checked FIRST so it keeps precedence over
 *   `tagMemory` when both are sent.
 * - `tagMemory` (raw dump): AUTO-SNIFF by record MIME via the codec
 *   registry, regardless of the `tagType` hint; the CC position (Type-5 vs
 *   Type-2) is auto-detected.
 */
function decodeNdefTag(
  body: Record<string, unknown>,
  tagType: "openprinttag" | "opentag3d",
): DecodedOpenPrintTag {
  const payload = toBytes(body.payload);
  if (payload) {
    return tagType === "opentag3d"
      ? decodeOpenTag3DTag(payload)
      : decodeOpenPrintTagBinary(payload);
  }
  const tagMemory = toBytes(body.tagMemory);
  if (tagMemory) {
    const decoded = decodeFromNdefRecords(parseNdefRecordsAuto(tagMemory));
    if (!decoded) {
      throw new Error("No recognized NDEF record (OpenPrintTag or OpenTag3D) found on the tag");
    }
    return decoded;
  }
  throw new Error(
    "decode requires a base64 'payload' (NDEF record payload) or 'tagMemory' (raw tag memory)",
  );
}

function decodeBambu(body: Record<string, unknown>): DecodedOpenPrintTag {
  const blocks = body.blocks;
  if (blocks === null || typeof blocks !== "object" || Array.isArray(blocks)) {
    throw new Error("bambu decode requires a 'blocks' object mapping block number → base64");
  }
  // Sparse array indexed by absolute MIFARE block number (0–63).
  const blockArray: (Buffer | undefined)[] = new Array(64).fill(undefined);
  let populated = 0;
  for (const [key, value] of Object.entries(blocks as Record<string, unknown>)) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 0 || n > 63) continue;
    if (typeof value !== "string" || value.length === 0) continue;
    blockArray[n] = Buffer.from(value, "base64");
    populated++;
  }
  // An empty / all-invalid block map would parse into an all-zero array and
  // yield a fabricated tag returned as a 200 — a failed phone read
  // masquerading as a decoded tag. Require at least one usable block.
  if (populated === 0) {
    throw new Error("bambu decode requires at least one readable MIFARE block");
  }
  const parsed = parseBambuBlocks(blockArray);
  // A dump carrying none of the identity blocks has nothing to match or
  // create from — treat as undecodable rather than inventing a tag.
  if (!parsed.filamentType && !parsed.materialVariantId && !parsed.detailedFilamentType) {
    throw new Error("bambu blocks contained no readable filament identity (blocks 1/2/4)");
  }
  return bambuToDecodedTag(parsed);
}

export async function POST(request: NextRequest) {
  const tooLarge = checkContentLength(request, MAX_DECODE_BODY);
  if (tooLarge) return tooLarge;

  // Belt-and-suspenders: checkContentLength only inspects the header, so a
  // chunked / header-less body slips past it — re-check the buffered byte
  // length so this cross-origin-reachable endpoint has a real memory bound
  // (same pattern as the prusaslicer route).
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_DECODE_BODY) {
    return errorResponse(
      `Request body too large. Maximum is ${(MAX_DECODE_BODY / 1024).toFixed(0)} KB.`,
      413,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be an object", 400);
  }
  const b = body as Record<string, unknown>;

  const tagType = b.tagType;
  if (tagType !== "openprinttag" && tagType !== "opentag3d" && tagType !== "bambu") {
    return errorResponse(
      "tagType must be 'openprinttag', 'opentag3d', or 'bambu'",
      415,
    );
  }

  let decoded: DecodedOpenPrintTag;
  try {
    decoded = tagType === "bambu" ? decodeBambu(b) : decodeNdefTag(b, tagType);
  } catch (err) {
    // Bad bytes / wrong-format tag is client input, not a server fault → 400.
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse("Could not decode tag", 400, message);
  }

  try {
    await dbConnect();
    // A tag written by Filament DB carries the instanceId in its spool_uid
    // field — the strongest match signal, tried first. A Bambu tray UID or
    // community tag won't collide with a 10-char FDB instanceId, so it
    // harmlessly falls through to the name/vendor/type matching.
    const queriedInstanceId = boundedField(decoded.spoolUid);
    const { match, candidates, matchedSpool } = await matchFilament({
      instanceId: queriedInstanceId,
      name: boundedField(decoded.materialName),
      vendor: boundedField(decoded.brandName),
      type: boundedField(decoded.materialType),
    });
    // Tell the scanner HOW we matched. Only an instanceId match is a
    // confident "this exact physical tag is in the DB"; the weaker name /
    // vendor+type tiers stay "heuristic" so the scanner offers "create new"
    // alongside opening the match. instanceId is detected EITHER by a
    // spool-level hit (#732 — matchedSpool non-null) OR by the
    // filament-level fallback (top-level instanceId equals the queried
    // spool_uid, case-insensitively). The matchedSpool check must come
    // first: a spool hit's matched FILAMENT carries a DIFFERENT top-level
    // instanceId, so a genuine spool match would otherwise be mislabelled
    // "heuristic".
    let matchedBy: "instanceId" | "heuristic" | null = null;
    if (match) {
      const matchedInstanceId = (match as { instanceId?: unknown }).instanceId;
      const filamentIdHit =
        !!queriedInstanceId &&
        typeof matchedInstanceId === "string" &&
        matchedInstanceId.toLowerCase() === queriedInstanceId.toLowerCase();
      matchedBy = matchedSpool || filamentIdHit ? "instanceId" : "heuristic";
    }
    return NextResponse.json({ decoded, match, candidates, matchedBy, matchedSpool });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to match decoded tag");
  }
}
