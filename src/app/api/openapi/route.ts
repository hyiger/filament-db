import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";

/**
 * GH #270: the spec and package.json are static for the process lifetime —
 * read + parse once and memoise. Memoising after the first successful read
 * (rather than at module load) keeps a missing file from crashing the
 * whole route module; the GET's try/catch still turns it into a clean 500.
 */
let cachedSpec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (cachedSpec) return cachedSpec;

  const specPath = path.join(process.cwd(), "public", "openapi.json");
  const spec = JSON.parse(readFileSync(specPath, "utf-8")) as Record<
    string,
    unknown
  >;

  // Inject version from package.json so it stays in sync automatically.
  const pkg = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
  ) as { version?: string };
  (spec.info as { version?: string }).version = pkg.version;

  cachedSpec = spec;
  return spec;
}

export async function GET() {
  try {
    return NextResponse.json(loadSpec());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to load OpenAPI spec", detail: message },
      { status: 500 },
    );
  }
}
