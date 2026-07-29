/**
 * KNAON Y813BT (TSPL) bring-up CLI — the TSPL sibling of print-label.ts.
 *
 * Two job sources:
 *   --file <path.prn>   send a raw TSPL job unchanged (the fixture ladder:
 *                       tests/fixtures/tspl/01…05). Validated for CRLF
 *                       framing first — an LF-only job is SILENTLY ignored
 *                       by the firmware (no error, no output, no paper
 *                       movement), which presents exactly like a dead
 *                       printer and costs real debugging time.
 *   --demo              render a sample dry-box label through the REAL
 *                       pipeline (dryBoxLabel → render), so layout changes
 *                       can be proofed on paper without the app.
 *
 * Two sinks:
 *   default             write the byte stream to --out (default
 *                       /tmp/label.prn) and echo the TSPL text for
 *                       inspection.
 *   --printer <target>  print for real via the Electron app's OS-print
 *                       transport (electron/label-printer.ts, kind "tspl" →
 *                       its own managed CUPS queue). Target is a CUPS queue
 *                       name (e.g. Knaon_Y813BT), a usb:// device URI from
 *                       `lpinfo -v`, or a Windows printer name.
 *
 * USAGE
 *   npx tsx scripts/print-tspl.ts --file tests/fixtures/tspl/03_probe_full.prn \
 *     --printer Knaon_Y813BT
 *   npx tsx scripts/print-tspl.ts --demo             # writes /tmp/label.prn
 *   npx tsx scripts/print-tspl.ts --demo --printer Knaon_Y813BT
 *
 * Hardware notes that cost a printed label each — do not re-derive:
 *   - `lp -o raw` reaches the print head UNTOUCHED even through a queue
 *     with the vendor PPD attached (probed 2026-07-28).
 *   - There is no usable CODEPAGE: a byte >= 0x80 inside a TEXT literal
 *     truncates the line. The emitter folds to ASCII for exactly this
 *     reason; --file jobs are your own responsibility.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { render, assertCrlfFramed } from "@/lib/tsplEncoder";
import { dryBoxLabel, DEFAULT_DRY_BOX_STRINGS } from "@/lib/dryBoxLabel";

interface Args {
  file?: string;
  demo?: boolean;
  printer?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: "/tmp/label.prn" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--file":
        args.file = argv[++i];
        break;
      case "--demo":
        args.demo = true;
        break;
      case "--printer":
        args.printer = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--help":
      case "-h":
        console.log(
          "usage: print-tspl (--file <path.prn> | --demo) [--printer <queue|usb://uri>] [--out <path>]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a} (try --help)`);
    }
  }
  if (!args.file && !args.demo) {
    throw new Error("Provide a job: --file <path.prn> or --demo (try --help)");
  }
  if (args.file && args.demo) {
    throw new Error("--file and --demo are mutually exclusive");
  }
  return args;
}

function demoJob(): Uint8Array {
  return render(
    dryBoxLabel(
      {
        location: {
          name: "BOX-07",
          humidity: 14,
          desiccantChangedAt: "2026-07-12T00:00:00.000Z",
        },
        items: [
          { filamentName: "PA6-CF20", filamentVendor: "Fiberon" },
          { filamentName: "PPA-CF", filamentVendor: "Siraya" },
          { filamentName: "PC Blend", filamentVendor: "Prusament" },
          { filamentName: "Galaxy Black", filamentVendor: "Prusa", filamentType: "PLA" },
        ],
        qrPayload: "https://filament-db.example/inventory?location=demo",
        asOf: new Date(),
      },
      DEFAULT_DRY_BOX_STRINGS,
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let bytes: Uint8Array;
  if (args.demo) {
    bytes = demoJob();
    console.log("job      : demo dry-box label (dryBoxLabel → render)");
  } else {
    bytes = new Uint8Array(readFileSync(args.file!));
    console.log(`job      : ${args.file} (raw)`);
    // Fail loudly on the one mistake with no printer-side diagnostic.
    // Only valid for bitmap-free jobs — every fixture in the ladder is.
    assertCrlfFramed(bytes);
  }
  console.log(`bytes    : ${bytes.length}`);

  if (args.printer) {
    // Same transport the app uses; "tspl" keeps a raw usb:// target off the
    // Brother printer's managed queue (they rebind independently).
    const { printLabel } = await import("../electron/label-printer");
    console.log(`printer  : ${args.printer}`);
    await printLabel(args.printer, bytes, "tspl");
    console.log("sent.");
    return;
  }

  writeFileSync(args.out, bytes);
  console.log(`wrote    : ${args.out}`);
  console.log("--- job text ---");
  console.log(new TextDecoder("latin1").decode(bytes).replace(/\r\n/g, "\n").trimEnd());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
