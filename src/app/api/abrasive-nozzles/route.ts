import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import Nozzle from "@/models/Nozzle";
import { resolveFilament } from "@/lib/resolveFilament";
import { auditAbrasiveNozzles, type AuditFilament } from "@/lib/abrasiveNozzleAudit";

/**
 * GET /api/abrasive-nozzles
 *
 * Data health: abrasive filaments that can reach a nozzle unfit for them, and
 * abrasive filaments whose `filament_abrasive` flag contradicts their material.
 *
 * Sibling of `/api/name-conflicts` — read-only, advisory, and reported rather
 * than repaired. Nothing here edits an assignment: whether a 4% cosmetic fibre
 * loading warrants a hardened nozzle is the user's call, not a migration's.
 *
 * Read-only GET → no `assertSameOriginRequest` (the #360 sweep covers mutating
 * verbs). The optional bearer gate in `src/proxy.ts` still applies.
 */
export async function GET() {
  try {
    await dbConnect();

    // `compatibleNozzles`, `optTags` and `settings` all inherit, so the audit
    // has to run on RESOLVED docs — a variant that inherits its nozzle set
    // stores an empty array, and auditing that would clear every variant of a
    // wrongly-assigned template.
    const filaments = await Filament.find({ _deletedAt: null, _purged: { $ne: true } })
      .select("name type parentId optTags settings compatibleNozzles")
      .lean();

    const parents = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) parents.set(String(f._id), f);
    }

    const resolved = filaments.map((f) => {
      const parent = f.parentId ? parents.get(String(f.parentId)) : undefined;
      return {
        doc: (parent ? resolveFilament(f, parent) : f) as unknown as AuditFilament,
        // A variant with an empty stored array is running on its template's
        // nozzles, so that is where the fix belongs. Naming it saves the user
        // from editing the variant and watching the value come straight back.
        via: parent && (f.compatibleNozzles ?? []).length === 0 ? (parent.name ?? null) : null,
      };
    });

    // Live nozzles only. A reference to a soft-deleted nozzle resolves to
    // nothing and is reported as unknown — which is what it is: a stale
    // assignment, and exactly the kind of drift this page exists to surface.
    const nozzles = await Nozzle.find({ _deletedAt: null })
      .select("name hardened")
      .lean();

    const viaById = new Map(resolved.map((r) => [String(r.doc._id), r.via]));
    const findings = auditAbrasiveNozzles(
      resolved.map((r) => r.doc),
      nozzles,
    ).map((f) => ({ ...f, inheritedFrom: viaById.get(f.filamentId) ?? null }));

    return NextResponse.json({ findings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to scan for abrasive nozzle mismatches", detail: message },
      { status: 500 },
    );
  }
}
