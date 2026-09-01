import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import { matchFilament } from "@/lib/matchFilament";
import { assertLocalPrintToken } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught, getErrorMessage } from "@/lib/apiErrorHandler";
import {
  renderLabelRaster,
  LabelDoesNotFitError,
  RendererCapabilityError,
  RendererUnavailableError,
} from "@/lib/labelBitmapServer";
import {
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  normalizeLabelFormat,
  validateLabelFormatOverride,
  type LabelFilament,
  type LabelFormat,
} from "@/lib/labelFormat";
import { encodeLabel, packGrayscaleBitmap, type TapeWidthMm } from "@/lib/labelEncoder";
import { printLabel, rejectUnusablePrintTarget } from "@/lib/labelTransport";
import { buildLocationDeepLink, buildFilamentDeepLink } from "@/lib/labelDeepLink";
import { isLoopbackHostname } from "@/lib/loopbackHost";
import mongoose from "mongoose";

/**
 * POST /api/labels/print — print a Brother PT-P710BT label for a spool or a
 * storage location (GH #1195).
 *
 * The app's own dialogs render in the BROWSER (src/lib/labelBitmap.ts, an
 * HTMLCanvas pipeline) and print over Electron IPC. That path is unreachable
 * from a script or an agent, so this route renders the same label with the
 * Node-side twin (src/lib/labelBitmapServer.ts) and hands the bytes to the
 * same transport the IPC handler uses (src/lib/labelTransport.ts).
 *
 * AUTH is `assertLocalPrintToken`, not `assertSameOriginRequest`. The latter
 * deliberately passes non-browser clients (that is how curl and the slicer
 * forks reach the API), which is exactly this route's caller shape, so it
 * would gate nothing. See the guard's docblock for why a loopback check is
 * not implementable on Next 16.
 *
 * The 24mm tape label carries ONE text line plus a QR. It is deliberately
 * not the dry-box label: that is a 100x150mm TSPL document rendered from the
 * printer's font ROM (src/lib/dryBoxLabel.ts) and has its own path.
 */

const TAPE_WIDTH_MM: TapeWidthMm = 24;

interface PrintBody {
  /** Spool identity (#732) — the value NFC tags and QR labels carry. */
  instanceId?: unknown;
  /** Storage location to label. Mutually exclusive with instanceId. */
  locationId?: unknown;
  /** CUPS queue name or `usb://` device URI; Windows printer name. */
  printer?: unknown;
  /** Base for URL-mode QR payloads. Falls back to the request's own origin. */
  baseUrl?: unknown;
  /** Spool labels only. `url` deep-links; `instanceId` encodes the bare id. */
  qrMode?: unknown;
  /** Named layout preset, e.g. "vendorOverType" (vendor above the type). */
  preset?: unknown;
  /** Explicit LabelFormat overrides, applied over the preset and validated. */
  format?: unknown;
  /** Render and report, but send nothing to the printer. */
  dryRun?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * matchFilament's docblock states its inputs are "assumed already
 * trimmed/length-bounded by the caller" — it builds case-insensitive MongoDB
 * regexes from them, so an unbounded value would have the driver compile and
 * send a huge regex. `/api/filaments/match` applies this same 128-char cap
 * (GH #513); this route is the second caller and must too.
 */
const MAX_INSTANCE_ID_LENGTH = 128;

/** Resolve the base the QR should point at, preferring an explicit value. */
function resolveBaseUrl(explicit: string | null, request: NextRequest): string | null {
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch {
      return null;
    }
  }
  const host = request.headers.get("host");
  return host ? `http://${host}` : null;
}

/**
 * Resolve the LabelFormat for this print.
 *
 * The app's own saved format lives in electron-store, which the server
 * process cannot read, so the caller states what it wants: a named preset
 * (the same LABEL_PRESETS the Settings editor offers) plus optional explicit
 * overrides. Everything is put through `normalizeLabelFormat` so a bad field
 * id or font name cannot reach the renderer.
 */
function resolveFormat(body: PrintBody): LabelFormat | { error: string } {
  let merged: Record<string, unknown> = { ...DEFAULT_LABEL_FORMAT };
  const preset = str(body.preset);
  if (preset) {
    // hasOwnProperty, not a bare lookup: LABEL_PRESETS is an ordinary object,
    // so "constructor" / "toString" / "valueOf" resolve up the prototype chain
    // to a truthy value, slip past the unknown-preset 400, and then contribute
    // an undefined `patch` -- printing the DEFAULT layout for a preset the
    // caller never asked for. The repo has form here (GH #1026).
    const entry = Object.prototype.hasOwnProperty.call(LABEL_PRESETS, preset)
      ? LABEL_PRESETS[preset]
      : undefined;
    if (!entry) {
      return {
        error: `Unknown preset "${preset}". Valid presets: ${Object.keys(LABEL_PRESETS).join(", ")}.`,
      };
    }
    merged = { ...merged, ...entry.patch };
  }
  if (body.format && typeof body.format === "object" && !Array.isArray(body.format)) {
    merged = { ...merged, ...(body.format as Record<string, unknown>) };
  }
  return normalizeLabelFormat(merged);
}

export async function POST(request: NextRequest) {
  const gate = assertLocalPrintToken(request);
  if (gate) return gate;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }
  // `request.json()` returns null for a literal `null` body without throwing,
  // and an array/number/string parses fine too. Without this the field reads
  // below raise an uncaught TypeError OUTSIDE the try, so the caller gets an
  // empty framework 500 instead of the 400 the contract promises.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return errorResponse("Request body must be a JSON object", 400);
  }
  const body = parsed as PrintBody;

  const instanceId = str(body.instanceId);
  const locationId = str(body.locationId);
  const printer = str(body.printer);

  // STRUCTURAL VALIDATION, done once for the whole surface.
  //
  // Three review rounds each found another field that was silently coerced
  // rather than refused, because `str()` maps ANY non-string to null: the
  // field then reads as "omitted", the request succeeds, and a label prints
  // that the caller never asked for. Printing is irreversible, so this route
  // refuses malformed input rather than interpreting it. Adding a field means
  // adding it to one of these lists.

  // (a) Unknown top-level keys. This is what catches a misspelled
  // safety-critical field -- `dryrun: true` would otherwise leave dryRun
  // false and PRINT. Strict rather than lenient, deliberately.
  const KNOWN_FIELDS = new Set([
    "instanceId", "locationId", "printer", "preset", "format", "qrMode", "baseUrl", "dryRun",
  ]);
  const unknownFields = Object.keys(body).filter((k) => !KNOWN_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return errorResponse(
      `Unknown field(s): ${unknownFields.join(", ")}. Allowed: ${[...KNOWN_FIELDS].join(", ")}.`,
      400,
    );
  }

  // (b) Every optional STRING field, type-checked BEFORE str() can coerce it
  // away. Applies to all of them, not the subset a given review happened to
  // name.
  for (const field of ["instanceId", "locationId", "printer", "preset", "baseUrl"] as const) {
    const value = (body as Record<string, unknown>)[field];
    if (value !== undefined && typeof value !== "string") {
      return errorResponse(`${field} must be a string.`, 400);
    }
  }

  // (c) The nested format override, validated STRICTLY. normalizeLabelFormat
  // is a persistence normalizer -- it coerces anything unrecognised to a
  // default so an old stored format still loads -- which is wrong for a
  // request: `{ qr: { enabled: "false" } }` would silently become the default
  // `true` and PRINT a QR the caller tried to disable.
  const formatError = validateLabelFormatOverride(body.format);
  if (formatError) return errorResponse(formatError, 400);
  // Strict boolean: a caller that serialized dryRun as the STRING "true" would
  // otherwise fall through to false and physically print. Printing is
  // irreversible and the OpenAPI contract declares a boolean, so a present
  // non-boolean is a 400 rather than a silent real print.
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return errorResponse("dryRun must be a boolean.", 400);
  }
  const dryRun = body.dryRun === true;
  if (!printer && !dryRun) {
    return errorResponse(
      "printer is required — a CUPS queue name (e.g. \"FilamentDB_Label\") or a usb:// device URI. " +
        "Pass dryRun:true to render without printing.",
      400,
    );
  }
  if (printer) {
    // The transport THROWS on these, which the catch below would map to a 500 —
    // telling an automated caller to retry input that can never succeed.
    const bad = rejectUnusablePrintTarget(printer, "brother");
    if (bad) return errorResponse(bad, 400);
  }
  if (!!instanceId === !!locationId) {
    return errorResponse("Provide exactly one of instanceId or locationId.", 400);
  }
  if (instanceId && instanceId.length > MAX_INSTANCE_ID_LENGTH) {
    return errorResponse(
      `instanceId must be ${MAX_INSTANCE_ID_LENGTH} characters or fewer.`,
      400,
    );
  }
  // Anything other than the exact string "url" silently fell into the
  // instanceId branch -- including a "URL" typo -- so a non-dry run printed a
  // real label carrying the wrong QR payload. The OpenAPI schema declares an
  // enum; enforce it.
  if (body.qrMode !== undefined && body.qrMode !== "url" && body.qrMode !== "instanceId") {
    return errorResponse('qrMode must be "instanceId" or "url".', 400);
  }
  if (locationId && !mongoose.isValidObjectId(locationId)) {
    // Otherwise Mongoose raises a CastError from the findOne below and the
    // outer catch maps it to a 500 — telling an automated caller to retry a
    // permanently invalid id.
    return errorResponse("locationId is not a valid id.", 400);
  }

  const fmt = resolveFormat(body);
  if ("error" in fmt) return errorResponse(fmt.error as string, 400);
  const resolved = fmt as LabelFormat;
  if (resolved.orientation === "vertical") {
    // normalizeLabelFormat blesses it (it is a first-class LabelOrientation),
    // but the server renderer cannot do it. That is a capability gap, not a
    // malformed request, and not a server fault -- 501, like the platform case.
    return errorResponse(
      "Vertical text orientation is not implemented by the print API — print from the app, " +
        "or use a horizontal format.",
      501,
    );
  }

  try {
    await dbConnect();

    let labelFilament: LabelFilament;
    let qrPayload: string;
    let format = resolved;

    if (locationId) {
      const loc = await Location.findOne({ _id: locationId, _deletedAt: null }).lean();
      if (!loc) return errorResponse("Location not found", 404);
      const base = resolveBaseUrl(str(body.baseUrl), request);
      if (!base) return errorResponse("Could not resolve a base URL for the QR payload.", 400);
      // A location has no vendor/type/colorName, so any field-based preset
      // would compose to zero lines. Force the name-only layout and keep the
      // caller's font/QR choices.
      labelFilament = { name: (loc as { name: string }).name };
      format = { ...resolved, lines: ["name"] };
      qrPayload = buildLocationDeepLink(base, String((loc as { _id: unknown })._id));
    } else {
      const result = await matchFilament({ instanceId: instanceId! });
      const filament = result.match as
        | { _id?: unknown; name?: string; vendor?: string; type?: string; colorName?: string }
        | null;
      if (!filament) return errorResponse("No filament matched that instanceId", 404);
      labelFilament = {
        name: filament.name,
        vendor: filament.vendor,
        type: filament.type,
        colorName: filament.colorName,
      };
      // Default to the bare instanceId: it needs no reachable host, which is
      // the failure mode a printed URL label has when the server moves.
      if (str(body.qrMode) === "url") {
        const base = resolveBaseUrl(str(body.baseUrl), request);
        if (!base) return errorResponse("Could not resolve a base URL for the QR payload.", 400);
        const spool = result.matchedSpool as { _id?: unknown } | null;
        qrPayload = buildFilamentDeepLink(
          base,
          String(filament._id),
          spool?._id ? String(spool._id) : undefined,
        );
      } else {
        qrPayload = instanceId!;
      }
    }

    const { raster, rasterLines, lines } = await renderLabelRaster({
      filament: labelFilament,
      qrPayload,
      format,
    });
    const packed = packGrayscaleBitmap(new Uint8Array(raster), rasterLines);
    const bytes = encodeLabel({
      bitmap: packed,
      rasterLines,
      tapeWidthMm: TAPE_WIDTH_MM,
      autoCut: true,
    });

    if (!dryRun) await printLabel(printer!, Buffer.from(bytes), "brother");

    return NextResponse.json({
      ok: true,
      dryRun,
      printer: dryRun ? null : printer,
      lines,
      qrPayload,
      rasterLines,
      bytes: bytes.length,
      // Surfaced, not refused: a loopback QR still scans, it just will not
      // resolve from a phone. The caller may genuinely be labelling for a
      // machine that only ever reads it locally.
      warning: /^https?:\/\//.test(qrPayload) && isLoopbackHostname(new URL(qrPayload).hostname)
        ? "QR points at a loopback host and will not resolve from another device."
        : undefined,
    });
  } catch (err) {
    // 501 = "this build/platform cannot do it", which is true for both the
    // unsupported-OS case and a missing native image backend. Neither is a
    // server fault and neither is worth an automated caller retrying.
    if (err instanceof RendererUnavailableError) {
      return errorResponse(err.message, 501);
    }
    // The caller asked for more than 24mm tape can hold (too many fields/lines,
    // or a QR payload past the band budget). That is a bad request, not a
    // server fault — a 500 would tell an automated caller to retry it forever.
    if (err instanceof LabelDoesNotFitError) {
      return errorResponse(err.message, 400);
    }
    // A well-formed request for a feature the server renderer does not
    // implement (e.g. vertical text). The route pre-checks the known case, so
    // this is the backstop for any path that reaches the renderer directly.
    if (err instanceof RendererCapabilityError) {
      return errorResponse(err.message, 501);
    }
    if (/not supported on platform/i.test(getErrorMessage(err))) {
      return errorResponse(getErrorMessage(err), 501);
    }
    return errorResponseFromCaught(err, "Failed to print label");
  }
}
