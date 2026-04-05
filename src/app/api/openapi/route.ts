import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import path from "path";

export async function GET() {
  try {
    const specPath = path.join(process.cwd(), "public", "openapi.json");
    const spec = JSON.parse(readFileSync(specPath, "utf-8"));

    // Inject version from package.json so it stays in sync automatically
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
    );
    spec.info.version = pkg.version;

    return NextResponse.json(spec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to load OpenAPI spec", detail: message },
      { status: 500 },
    );
  }
}
