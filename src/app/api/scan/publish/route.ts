import { NextRequest, NextResponse } from "next/server";
import {
  publishScan,
  type ScanEvent,
  type ScanEventDecoded,
  type ScanEventFilament,
  type ScanEventSpool,
} from "@/lib/scanBus";
import { errorResponse, getErrorMessage } from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

/**
 * Accept a decoded-and-matched NFC scan from the renderer and fan it out to
 * SSE subscribers (see /api/scan/stream). The renderer is the publisher
 * because the match step already happens there — re-doing it here would
 * double the DB roundtrip per tag.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickFilament(value: unknown): ScanEventFilament | null {
  if (!isObject(value)) return null;
  const id = value._id;
  const name = value.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    _id: id,
    name,
    vendor: typeof value.vendor === "string" ? value.vendor : "",
    type: typeof value.type === "string" ? value.type : "",
    color: typeof value.color === "string" ? value.color : "",
  };
}

/**
 * GH #271: cap the candidates array. The published event is retained in
 * `scanBus` as the "last scan" and replayed to every new SSE subscriber,
 * so an unauthenticated POST with a multi-megabyte `candidates` array
 * would otherwise be held in memory indefinitely and fanned out to every
 * connection. A real tag match produces a handful of candidates; 25 is a
 * generous bound.
 */
const MAX_CANDIDATES = 25;

function pickCandidates(value: unknown): ScanEventFilament[] {
  if (!Array.isArray(value)) return [];
  const out: ScanEventFilament[] = [];
  for (const entry of value) {
    if (out.length >= MAX_CANDIDATES) break;
    const f = pickFilament(entry);
    if (f) out.push(f);
  }
  return out;
}

/** #732: validate the matched-spool object (a renderer-supplied, same-origin
 * payload). Requires a string _id + instanceId; label bounded to a sane
 * length. Returns null for anything malformed. */
function pickMatchedSpool(value: unknown): ScanEventSpool | null {
  if (!isObject(value)) return null;
  const id = value._id;
  const instanceId = value.instanceId;
  if (typeof id !== "string" || typeof instanceId !== "string") return null;
  return {
    _id: id,
    instanceId,
    label: typeof value.label === "string" ? value.label.slice(0, 200) : "",
  };
}

const DECODED_STRING_FIELDS = [
  "materialName",
  "brandName",
  "materialType",
  "color",
  "spoolUid",
] as const;

function pickDecoded(value: unknown): ScanEventDecoded {
  if (!isObject(value)) return {};
  const out: ScanEventDecoded = {};
  for (const key of DECODED_STRING_FIELDS) {
    const v = value[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = v;
    }
  }
  if (value.tagSource === "openprinttag" || value.tagSource === "bambu") {
    out.tagSource = value.tagSource;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    return errorResponse("Invalid JSON body", 400, getErrorMessage(err));
  }

  if (!isObject(body)) {
    return errorResponse("Body must be an object", 400);
  }

  const filament = pickFilament(body.filament);
  const candidates = pickCandidates(body.candidates);
  const matchedSpool = pickMatchedSpool(body.matchedSpool);
  const decoded = pickDecoded(body.decoded);

  // Reject a scan with no useful content — without either a matched filament
  // or some decoded tag fields, the consumer has nothing to act on.
  if (!filament && Object.keys(decoded).length === 0) {
    return errorResponse(
      "Scan must include a filament match or decoded tag fields",
      400,
    );
  }

  const event: ScanEvent = {
    timestamp: Date.now(),
    filament,
    candidates,
    matchedSpool,
    decoded,
  };

  publishScan(event);
  return NextResponse.json({ ok: true, event }, { status: 202 });
}
