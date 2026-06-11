/**
 * GH #614 — resolve a filament's free-text `type` to a chapter of the
 * "FDM Polymers — A Technical Reference" (the project wiki, source of truth).
 *
 * Pure + DB-free (unit-tested like cssNamedColors.ts / filamentFinish.ts). The
 * detail page renders the resolved chapter's markdown from
 * `src/content/referenceContent.ts`; an unmapped type resolves to `null` and
 * the panel hides itself.
 *
 * Only the MATERIAL chapters (6–21) are reachable from a filament type. The
 * reference's foundations (1–5), cross-cutting workflows (22–28), and
 * appendices are general and not keyed to a single material.
 *
 * Note: this intentionally diverges from `mapToFilamentPayload`'s OPT mapper on
 * one type — IGLIDUR. The OPT mapper sends iglidur → POM, but the reference is
 * explicit that igus tribo-filaments are PA-based, so here IGLIDUR → ch13 (PA).
 * (Chapter 28, Tribological filaments, is the relevant "see also".)
 */

export interface ReferenceChapter {
  /** Stable id, e.g. "ch6" — the key into REFERENCE_CONTENT. */
  id: string;
  /** Chapter number in the reference (6–21 for material chapters). */
  number: number;
  /** Chapter title, e.g. "PLA family". */
  title: string;
  /** The Part this chapter lives under, for the panel's context line. */
  part: string;
}

/** Metadata for every material chapter a filament type can resolve to. */
export const REFERENCE_CHAPTERS: Record<string, ReferenceChapter> = {
  ch6: { id: "ch6", number: 6, title: "PLA family", part: "II — PLA Family" },
  ch7: { id: "ch7", number: 7, title: "PETG and the copolyester family", part: "III — Polyester Family" },
  ch8: { id: "ch8", number: 8, title: "PCTG", part: "III — Polyester Family" },
  ch9: { id: "ch9", number: 9, title: "PET and reinforced PET grades", part: "III — Polyester Family" },
  ch10: { id: "ch10", number: 10, title: "Styrenics: ABS, ASA, HIPS", part: "IV — Styrenics Family" },
  ch11: { id: "ch11", number: 11, title: "Polypropylene (PP)", part: "V — Polyolefins" },
  ch12: { id: "ch12", number: 12, title: "Polyethylene (PE) and other polyolefins", part: "V — Polyolefins" },
  ch13: { id: "ch13", number: 13, title: "Aliphatic nylons (PA6, PA66, PA12, PA612, PA11)", part: "VI — Polyamides" },
  ch14: { id: "ch14", number: 14, title: "PPA / semi-aromatic polyamides", part: "VI — Polyamides" },
  ch15: { id: "ch15", number: 15, title: "PC and PC blends", part: "VII — Polycarbonates" },
  ch16: { id: "ch16", number: 16, title: "TPU, TPEE, PEBA, and foaming elastomers", part: "VIII — Specialty and high-performance" },
  ch17: { id: "ch17", number: 17, title: "PMMA, POM, PVDF", part: "VIII — Specialty and high-performance" },
  ch18: { id: "ch18", number: 18, title: "PPS, PSU, PPSU, PEI", part: "VIII — Specialty and high-performance" },
  ch19: { id: "ch19", number: 19, title: "PAEK family (PEEK, PEKK)", part: "VIII — Specialty and high-performance" },
  ch20: { id: "ch20", number: 20, title: "Soluble support polymers (PVA, BVOH)", part: "VIII — Specialty and high-performance" },
  ch21: { id: "ch21", number: 21, title: "Niche biodegradables (PHA, PCL, PVB)", part: "VIII — Specialty and high-performance" },
};

/**
 * Normalized type key → chapter id. Keys are uppercased with whitespace, and
 * `/`, `+` stripped (so "PLA/PHA" → "PLAPHA", "PLA+" → "PLA"). Comprehensive on
 * purpose — resolution prefers exact hits over heuristics, so false matches
 * from a too-aggressive prefix scan can't happen.
 */
const TYPE_MAP: Record<string, string> = {
  // ── ch6 — PLA family ──
  PLA: "ch6", PLAPLUS: "ch6", TOUGHPLA: "ch6", HTPLA: "ch6", LWPLA: "ch6",
  PLAPHA: "ch6", PLAPHA2: "ch6", WOOD: "ch6", WOODFILL: "ch6", WOODFILLED: "ch6",
  // ── ch7 — PETG / copolyester ──
  PETG: "ch7", CPE: "ch7", NGEN: "ch7", TGLASE: "ch7", PCT: "ch7", COPOLYESTER: "ch7",
  // ── ch8 — PCTG ──
  PCTG: "ch8", TRITAN: "ch8",
  // ── ch9 — PET ──
  PET: "ch9", RPET: "ch9",
  // ── ch10 — styrenics ──
  ABS: "ch10", ASA: "ch10", HIPS: "ch10", ABSPLUS: "ch10",
  // ── ch11 — PP ──
  PP: "ch11", POLYPROPYLENE: "ch11",
  // ── ch12 — PE / polyolefins ──
  PE: "ch12", HDPE: "ch12", LDPE: "ch12", POLYETHYLENE: "ch12", EVA: "ch12", COC: "ch12", COP: "ch12",
  // ── ch13 — aliphatic nylons ──
  PA: "ch13", NYLON: "ch13", PA6: "ch13", PA66: "ch13", PA12: "ch13", PA11: "ch13",
  PA612: "ch13", PA610: "ch13", PA1010: "ch13", IGLIDUR: "ch13",
  // ── ch14 — PPA / semi-aromatic ──
  PPA: "ch14", PAHT: "ch14", HTN: "ch14", PARA: "ch14",
  // ── ch15 — PC ──
  PC: "ch15", POLYCARBONATE: "ch15", PCABS: "ch15", PCPTFE: "ch15",
  // ── ch16 — flexibles ──
  TPU: "ch16", TPE: "ch16", TPEE: "ch16", PEBA: "ch16", FLEX: "ch16", FLEXIBLE: "ch16", TPC: "ch16",
  // ── ch17 — PMMA / POM / PVDF ──
  PMMA: "ch17", ACRYLIC: "ch17", POM: "ch17", ACETAL: "ch17", DELRIN: "ch17", PVDF: "ch17",
  // ── ch18 — high-performance amorphous ──
  PPS: "ch18", PSU: "ch18", PPSU: "ch18", PEI: "ch18", ULTEM: "ch18",
  // ── ch19 — PAEK ──
  PAEK: "ch19", PEEK: "ch19", PEKK: "ch19",
  // ── ch20 — soluble supports ──
  PVA: "ch20", BVOH: "ch20",
  // ── ch21 — niche biodegradables ──
  PHA: "ch21", PCL: "ch21", PVB: "ch21",
};

/** Uppercase, drop whitespace and the cosmetic `-`, `/`, `+` separators, so
 *  "PA 6" → "PA6", "PLA/PHA" → "PLAPHA", "PLA+" → "PLA", and blend/compound
 *  spellings collapse: "PC-ABS" → "PCABS", "PET-CF" → "PETCF" (reinforcement
 *  stripping still recognizes the hyphen-free form). */
export function normalizeTypeKey(type: string | null | undefined): string {
  if (!type) return "";
  return type.toUpperCase().replace(/[-\s/+]+/g, "");
}

/**
 * Strip a trailing reinforcement designation (`-CF`, `GF`, `CF20`, `GF30`, …)
 * so a composite resolves to its base chemistry — "PET-CF" → "PET",
 * "PA6-CF20" → "PA6", "PETGCF" → "PETG". The reference files composites under
 * their base polymer's chapter, mirroring how the document is organized.
 */
function stripReinforcement(key: string): string {
  return key.replace(/-?(?:CF|GF)\d*$/, "");
}

const tryKey = (k: string): ReferenceChapter | null =>
  TYPE_MAP[k] ? REFERENCE_CHAPTERS[TYPE_MAP[k]] : null;

/**
 * Resolve a filament type to its reference chapter, or `null` when none maps
 * (the panel then hides). Order: exact → reinforcement-stripped exact →
 * leading-"R" (recycled, recursed through the full resolver so the heuristics
 * below also apply) → Shore-suffix elastomer → semi-aromatic / aliphatic nylon.
 * Deliberately NO blind prefix scan — it would mismap niche types that merely
 * share an initial (PCL≠PC, PVB≠PVA, PEI≠PE).
 */
export function resolveReferenceChapter(
  type: string | null | undefined,
): ReferenceChapter | null {
  return resolveNormalizedKey(normalizeTypeKey(type));
}

function resolveNormalizedKey(key: string): ReferenceChapter | null {
  if (!key) return null;

  // 1. exact
  let hit = tryKey(key);
  if (hit) return hit;

  // 2. drop the CF/GF reinforcement suffix and retry
  const base = stripReinforcement(key);
  if (base !== key) {
    hit = tryKey(base);
    if (hit) return hit;
  }

  // 3. drop a leading "R" (recycled) and re-resolve the remainder through the
  //    WHOLE resolver — so rPLA → PLA (exact) AND rTPU 95A / rNylon 6 / rPA6T
  //    (heuristic-only) resolve the same as their non-recycled forms. Each hop
  //    shortens the key, so it terminates.
  if (key.length > 1 && key.startsWith("R")) {
    hit = resolveNormalizedKey(key.slice(1));
    if (hit) return hit;
  }

  // 4. elastomers carry a Shore-hardness suffix far more often than not
  //    ("TPU 95A", "TPU98A", "TPU 64D", "TPE 85A") → ch16. Guarded to the
  //    elastomer prefixes so it can't swallow digits from other types.
  if (/^(?:TPU|TPE|TPC)\d{2,3}[AD]$/.test(base)) return REFERENCE_CHAPTERS.ch16;

  // 5. semi-aromatic ("T"-grade) nylons — PA6T / PA9T / PA10T / PA4T — are
  //    high-temp partially-aromatic polyamides covered by the PPA chapter, NOT
  //    the aliphatic one. Must precede the broad PA<n> rule below.
  if (/^PA\d+T/.test(base)) return REFERENCE_CHAPTERS.ch14;

  // 6. aliphatic-nylon subtypes: PA6 / PA66 / PA12 / PA612 / PA1010 (and the
  //    "Nylon 6" / "Nylon12" spellings) → ch13. PA guarded to a digit after
  //    "PA" so PAEK / PAHT / PPA never match here.
  if (/^PA\d/.test(base) || /^NYLON\d/.test(base)) return REFERENCE_CHAPTERS.ch13;

  return null;
}
