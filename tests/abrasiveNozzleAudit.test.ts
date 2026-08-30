import { describe, it, expect } from "vitest";
import {
  abrasiveReasons,
  auditAbrasiveNozzles,
  OPT_TAG_ABRASIVE,
  type AuditFilament,
  type AuditNozzle,
} from "@/lib/abrasiveNozzleAudit";

const SOFT: AuditNozzle = { _id: "indx", name: "INDX 0.4 HF", hardened: false };
const HARD: AuditNozzle = { _id: "wc04", name: "WC HF 0.4", hardened: true };
const NOZZLES = [SOFT, HARD];

/** An abrasive filament restricted to hardened nozzles and flagged correctly. */
const CLEAN: AuditFilament = {
  _id: "f-clean",
  name: "Fiberon PA6-CF20",
  type: "PA6-CF",
  settings: { filament_abrasive: "1" },
  compatibleNozzles: [HARD._id],
};

describe("abrasiveReasons", () => {
  it("reads the explicit flag", () => {
    expect(abrasiveReasons({ _id: "x", type: "PLA", settings: { filament_abrasive: "1" } }))
      .toEqual(["flagged"]);
  });

  it("reads the OPT abrasive tag", () => {
    expect(abrasiveReasons({ _id: "x", type: "PLA", optTags: [OPT_TAG_ABRASIVE] }))
      .toEqual(["tagged"]);
  });

  it("reads fibre reinforcement out of the type", () => {
    for (const type of ["PA6-CF20", "PET-CF", "PPS-CF10", "HT-PLA-GF", "PP CF", "PA_GF"]) {
      expect(abrasiveReasons({ _id: "x", type }), type).toContain("fibre");
    }
  });

  it("does not read CF out of a word that merely contains those letters", () => {
    // "PCTG" contains no CF token; neither does a colour named "Buff".
    expect(abrasiveReasons({ _id: "x", type: "PCTG", name: "Scaffold Buff" })).toEqual([]);
  });

  it("reads glow and metal fill out of the name", () => {
    expect(abrasiveReasons({ _id: "x", type: "PLA", name: "Glow in the Dark Green" }))
      .toEqual(["filled"]);
    expect(abrasiveReasons({ _id: "x", type: "PLA", name: "Bronze Fill" })).toEqual(["filled"]);
  });

  it("returns nothing for an ordinary filament", () => {
    expect(abrasiveReasons({ _id: "x", type: "PETG", name: "Prusament PETG Orange" }))
      .toEqual([]);
  });

  it("lets an explicit 0 suppress ONLY the weak name heuristic", () => {
    const off = { filament_abrasive: "0" };
    // "Metallic Grey" is a pigment, not metal fill — the user saying so wins.
    expect(abrasiveReasons({ _id: "x", type: "PLA", name: "Metallic Grey", settings: off }))
      .toEqual([]);
  });

  it("does NOT let an explicit 0 suppress a fibre type or the OPT tag", () => {
    // This is the crux. `FilamentForm` writes `form.abrasive ? "1" : "0"`
    // while its own predicate is `form.abrasive || optTags.includes(4)`, so a
    // tag-marked abrasive is PERSISTED as "0". Trusting that "0" would make
    // the audit blind to exactly the filaments most likely to be misfiled.
    const off = { filament_abrasive: "0" };
    expect(abrasiveReasons({ _id: "x", type: "PA6-CF20", settings: off })).toEqual(["fibre"]);
    expect(abrasiveReasons({ _id: "x", type: "PLA", optTags: [4], settings: off }))
      .toEqual(["tagged"]);
  });

  it("accepts the flag as a boolean or a number, not just a string", () => {
    expect(abrasiveReasons({ _id: "x", type: "PLA", settings: { filament_abrasive: true } }))
      .toEqual(["flagged"]);
    expect(abrasiveReasons({ _id: "x", type: "PLA", settings: { filament_abrasive: 1 } }))
      .toEqual(["flagged"]);
    expect(abrasiveReasons({ _id: "x", type: "PLA", name: "Sparkle", settings: { filament_abrasive: 0 } }))
      .toEqual([]);
  });
});

describe("auditAbrasiveNozzles", () => {
  it("reports an abrasive filament that can reach a soft nozzle", () => {
    const f: AuditFilament = { ...CLEAN, _id: "f1", compatibleNozzles: [HARD._id, SOFT._id] };
    const [finding] = auditAbrasiveNozzles([f], NOZZLES);
    expect(finding.filamentId).toBe("f1");
    expect(finding.softNozzles).toEqual([{ id: "indx", name: "INDX 0.4 HF" }]);
    expect(finding.reasons).toContain("fibre");
  });

  it("stays silent on an abrasive filament that is correctly restricted AND flagged", () => {
    expect(auditAbrasiveNozzles([CLEAN], NOZZLES)).toEqual([]);
  });

  it("stays silent on a non-abrasive filament however it is assigned", () => {
    const pla: AuditFilament = {
      _id: "f2", name: "Prusament PLA", type: "PLA", compatibleNozzles: [SOFT._id],
    };
    expect(auditAbrasiveNozzles([pla], NOZZLES)).toEqual([]);
  });

  it("reports an abrasive filament with no nozzles assigned", () => {
    // Not benign: an empty list reads as "no restriction" wherever it is
    // consumed, so nothing holds the filament back from a soft nozzle.
    const f: AuditFilament = { ...CLEAN, _id: "f3", compatibleNozzles: [] };
    const [finding] = auditAbrasiveNozzles([f], NOZZLES);
    expect(finding.unassigned).toBe(true);
    expect(finding.softNozzles).toEqual([]);
  });

  it("treats a nozzle ref missing from the catalogue as unsafe", () => {
    // A dangling ref is not evidence of hardness. Assuming hardened would
    // make a stale assignment disappear from the report that exists to find
    // stale assignments.
    const f: AuditFilament = { ...CLEAN, _id: "f4", compatibleNozzles: ["ghost"] };
    const [finding] = auditAbrasiveNozzles([f], NOZZLES);
    expect(finding.softNozzles).toEqual([{ id: "ghost", name: "(unknown nozzle)" }]);
  });

  it("reports a flag that contradicts the material even when nozzles are right", () => {
    // The 7 real presets that export `filament_abrasive = 0`: the slicer and
    // the INDX firmware's M862.1 check are both told the filament is safe.
    const f: AuditFilament = { ...CLEAN, _id: "f5", settings: { filament_abrasive: "0" } };
    const [finding] = auditAbrasiveNozzles([f], NOZZLES);
    expect(finding.flagMismatch).toBe(true);
    expect(finding.softNozzles).toEqual([]);
    expect(finding.unassigned).toBe(false);
  });

  it("reports a missing flag, not only a wrong one", () => {
    const f: AuditFilament = { ...CLEAN, _id: "f6", settings: {} };
    expect(auditAbrasiveNozzles([f], NOZZLES)[0].flagMismatch).toBe(true);
  });

  it("reads populated nozzle docs as well as raw ids", () => {
    const f: AuditFilament = { ...CLEAN, _id: "f7", compatibleNozzles: [{ _id: "indx" }] };
    expect(auditAbrasiveNozzles([f], NOZZLES)[0].softNozzles).toHaveLength(1);
  });

  it("orders soft-nozzle findings before unassigned before flag-only", () => {
    const soft: AuditFilament = { ...CLEAN, _id: "a", name: "Zeta", compatibleNozzles: [SOFT._id] };
    const none: AuditFilament = { ...CLEAN, _id: "b", name: "Alpha", compatibleNozzles: [] };
    const flag: AuditFilament = { ...CLEAN, _id: "c", name: "Alpha", settings: {} };
    const out = auditAbrasiveNozzles([flag, none, soft], NOZZLES);
    expect(out.map((f) => f.filamentId)).toEqual(["a", "b", "c"]);
  });

  it("tolerates a record carrying no name, type or nozzle array", () => {
    // Rows arrive from CSV import, hybrid sync and snapshot restore, not only
    // from the form — every field this reads has to survive being absent.
    const bare: AuditFilament = { _id: "f9", optTags: [OPT_TAG_ABRASIVE] };
    const [finding] = auditAbrasiveNozzles([bare], NOZZLES);
    expect(finding).toMatchObject({
      filamentName: "",
      filamentType: null,
      reasons: ["tagged"],
      unassigned: true,
    });
  });

  it("skips junk nozzle references instead of counting them as nozzles", () => {
    // A null ref is absence, not an unnamed nozzle — counting it would report
    // a soft nozzle that does not exist and hide the real "unassigned" state.
    const f: AuditFilament = { ...CLEAN, _id: "f10", compatibleNozzles: [null, { _id: null }] };
    const [finding] = auditAbrasiveNozzles([f], [...NOZZLES, { _id: null, name: "junk" }]);
    expect(finding.softNozzles).toEqual([]);
    expect(finding.unassigned).toBe(true);
  });

  it("tolerates an empty catalogue and empty input", () => {
    expect(auditAbrasiveNozzles([], NOZZLES)).toEqual([]);
    // With no nozzle catalogue every ref is unresolvable — reported, not hidden.
    expect(auditAbrasiveNozzles([{ ...CLEAN, _id: "f8" }], [])[0].softNozzles).toHaveLength(1);
  });
});
