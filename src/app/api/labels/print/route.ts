import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Location from "@/models/Location";
import { matchFilament } from "@/lib/matchFilament";
import { assertLocalPrintToken } from "@/lib/requestGuard";
import { errorResponse, errorResponseFromCaught, getErrorMessage } from "@/lib/apiErrorHandler";
import { renderLabelRaster } from "@/lib/labelBitmapServer";
import {
  DEFAULT_LABEL_FORMAT,
  LABEL_PRESETS,
  normalizeLabelFormat,
  type LabelFilament,
  type LabelFormat,
} from "@/lib/labelFormat";
import { encodeLabel, packGrayscaleBitmap, type TapeWidthMm } from "@/lib/labelEncoder";
import { printLabel } from "@/lib/labelTransport";
import { buildLocationDeepLink, buildFilamentDeepLink } from "@/lib/labelDeepLink";
import { isLoopbackHostname } from "@/lib/loopbackHost";

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
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

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
    const entry = LABEL_PRESETS[preset];
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

  let body: PrintBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  const instanceId = str(body.instanceId);
  const locationId = str(body.locationId);
  const printer = str(body.printer);

  if (!printer) {
    return errorResponse(
      "printer is required — a CUPS queue name (e.g. \"FilamentDB_Label\") or a usb:// device URI.",
      400,
    );
  }
  if (!!instanceId === !!locationId) {
    return errorResponse("Provide exactly one of instanceId or locationId.", 400);
  }

  const fmt = resolveFormat(body);
  if ("error" in fmt) return errorResponse(fmt.error as string, 400);
  const resolved = fmt as LabelFormat;

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

    await printLabel(printer, Buffer.from(bytes), "brother");

    return NextResponse.json({
      ok: true,
      printer,
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
    if (/not supported on platform/i.test(getErrorMessage(err))) {
      return errorResponse(getErrorMessage(err), 501);
    }
    return errorResponseFromCaught(err, "Failed to print label");
  }
}
