import { NextRequest, NextResponse } from "next/server";
import {
  publishScan,
  type ScanEvent,
  type ScanEventDecoded,
  type ScanEventFilament,
  type ScanEventSpool,
} from "@/lib/scanBus";
import {
  checkContentLength,
  errorResponse,
  getErrorMessage,
} from "@/lib/apiErrorHandler";
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

/**
 * GH #1076: per-field length bounds, belt-and-braces under the body byte
 * cap below — no single field can dominate the retained "last scan" even
 * if the body cap is ever loosened. `MAX_ID_CHARS` matches the app-wide
 * instanceId bound (128, like /filaments/match) so a legitimate legacy or
 * custom id is never corrupted.
 */
const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 256;

function pickFilament(value: unknown): ScanEventFilament | null {
  if (!isObject(value)) return null;
  const id = value._id;
  const name = value.name;
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    _id: id.slice(0, MAX_ID_CHARS),
    name: name.slice(0, MAX_TEXT_CHARS),
    vendor: typeof value.vendor === "string" ? value.vendor.slice(0, MAX_TEXT_CHARS) : "",
    type: typeof value.type === "string" ? value.type.slice(0, MAX_TEXT_CHARS) : "",
    color: typeof value.color === "string" ? value.color.slice(0, MAX_TEXT_CHARS) : "",
  };
}

/**
 * GH #271: cap the candidates array — the published event is retained in
 * `scanBus` as the "last scan" and replayed to every new SSE subscriber,
 * so an unauthenticated multi-megabyte `candidates` array would be held in
 * memory indefinitely and fanned out. GH #1076 completes the mitigation on
 * the BYTE axis (body cap + per-field slices), so neither the count nor
 * the bytes of a published event are attacker-controlled.
 */
const MAX_CANDIDATES = 25;

/**
 * GH #1076: request-body byte cap. Real scan events are under 2 KB; 64 KB
 * is generous.
 */
const MAX_PUBLISH_BODY = 64 * 1024;

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

/** #732: validate the matched-spool object. Requires a string _id +
 * instanceId; all fields length-bounded (#1076). Returns null for anything
 * malformed. */
function pickMatchedSpool(value: unknown): ScanEventSpool | null {
  if (!isObject(value)) return null;
  const id = value._id;
  const instanceId = value.instanceId;
  if (typeof id !== "string" || typeof instanceId !== "string") return null;
  return {
    _id: id.slice(0, MAX_ID_CHARS),
    instanceId: instanceId.slice(0, MAX_ID_CHARS),
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
      out[key] = v.slice(0, MAX_TEXT_CHARS);
    }
  }
  if (
    value.tagSource === "openprinttag" ||
    value.tagSource === "bambu" ||
    value.tagSource === "opentag3d"
  ) {
    out.tagSource = value.tagSource;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // GH #1076: cap the request body BEFORE buffering it. The published event
  // is retained as the last scan and re-serialized to every SSE subscriber,
  // so an unbounded body would be held + fanned out indefinitely.
  const tooLarge = checkContentLength(request, MAX_PUBLISH_BODY);
  if (tooLarge) return tooLarge;

  // Belt-and-suspenders: checkContentLength only inspects the header, so a
  // chunked / header-less / lying body slips past it. Enforce the cap WHILE
  // READING rather than after `request.text()` buffers everything — the
  // same-origin guard deliberately admits header-less non-browser clients,
  // so a lying client could otherwise stream an arbitrarily large body into
  // memory before the 413. The reader is cancelled at first overflow.
  const chunks: Uint8Array[] = [];
  let received = 0;
  const bodyStream = request.body;
  if (bodyStream) {
    const reader = bodyStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_PUBLISH_BODY) {
          await reader.cancel().catch(() => {});
          return errorResponse(
            `Request body too large. Maximum is ${(MAX_PUBLISH_BODY / 1024).toFixed(0)} KB.`,
            413,
          );
        }
        chunks.push(value);
      }
    }
  }
  // Fetch's request.json() strips a UTF-8 BOM during decoding, but
  // Buffer.toString("utf8") preserves it as U+FEFF — which would 400 a
  // BOM-prefixed payload the pre-streaming path accepted.
  let raw = Buffer.concat(chunks).toString("utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let body: unknown;
  try {
    body = JSON.parse(raw);
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
