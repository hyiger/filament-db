"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { settingFlagIsOn } from "@/lib/slicerSettings";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useNfcContext } from "@/components/NfcProvider";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { encodeOpenTag3D } from "@/lib/opentag3d";
import { filamentToOpenTag3DFields, wrapOpenTag3DType2 } from "@/lib/opentag3d-encode";
import { NTAG_NAME_TO_NDEF_BYTES, type NtagSizeName } from "@/lib/ntagVersion";
import { useNtagDefaultSize } from "@/hooks/useNtagDefaultSize";
import { selectSpoolForWrite } from "@/lib/selectSpoolForWrite";
import { safeHttpUrl } from "@/lib/safeRenderUrl";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useCurrency } from "@/hooks/useCurrency";
import PrusamentImportDialog from "@/components/PrusamentImportDialog";
import PrintLabelDialog from "@/components/PrintLabelDialog";
import OptResyncDialog from "@/components/OptResyncDialog";
import OptLinkDialog from "@/components/OptLinkDialog";
import TechnicalReferencePanel from "@/components/TechnicalReferencePanel";
import CopyButton from "@/components/CopyButton";
import FilamentSwatch from "@/components/FilamentSwatch";
import FinishChip from "@/components/FinishChip";
import { deriveFinish } from "@/lib/filamentFinish";
import { deriveArrangement } from "@/lib/filamentColors";
import { parentPromotionState } from "@/lib/promoteParent";
import { getRemainingGrams, getRemainingPct, getSpoolCount } from "@/lib/inventoryStats";
import { decideSpoolDeepLink, healedSpoolDeepLinkHref } from "@/lib/spoolDeepLink";
import type { FilamentDetail, FilamentCalibration, FilamentSpool } from "@/types/filament";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";

type Filament = FilamentDetail;

/** Today's date as a `YYYY-MM-DD` string in the user's LOCAL timezone, for
 *  seeding a native `<input type="date">` (#941). `toISOString()` would use
 *  UTC and show "tomorrow" for users east of UTC late in the day. */
function localTodayInput(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

/** True when the stored value is exactly UTC midnight — the shape a
 *  date-only usage entry takes (the picker sends a bare `YYYY-MM-DD`,
 *  stored as `00:00:00.000Z`). Real "now" timestamps are effectively
 *  never exactly midnight UTC, so this cleanly separates calendar-day
 *  values from instants (#941). */
function isUtcMidnight(value: string | Date): boolean {
  const d = value instanceof Date ? value : new Date(value);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

function computeRemaining(filament: Filament, overrideTotalWeight?: number | null) {
  const { spoolWeight, netFilamentWeight, density, diameter } = filament;
  const totalWeight = overrideTotalWeight !== undefined ? overrideTotalWeight : filament.totalWeight;
  if (totalWeight == null || spoolWeight == null) return null;

  const remainingWeight = Math.max(0, totalWeight - spoolWeight);
  const pct = netFilamentWeight && netFilamentWeight > 0
    ? Math.min(100, Math.round((remainingWeight / netFilamentWeight) * 100))
    : null;

  let lengthMeters: number | null = null;
  if (density && density > 0 && diameter && diameter > 0) {
    // Volume in cm³ = weight(g) / density(g/cm³)
    const volumeCm3 = remainingWeight / density;
    // Cross-section area in cm² = π * (diameter_mm / 20)²
    const radiusCm = diameter / 20;
    const areaCm2 = Math.PI * radiusCm * radiusCm;
    // Length in cm, convert to meters
    lengthMeters = volumeCm3 / areaCm2 / 100;
  }

  return { remainingWeight, pct, lengthMeters };
}

/**
 * GH #402: same-route navigation (`/filaments/A` → `/filaments/B`)
 * triggers a params change without an unmount, so the inner
 * component's state would otherwise leak into the next filament.
 * `key={params.id}` unmounts/remounts on every id change so the whole
 * state graph resets without per-field reset boilerplate.
 */
export default function FilamentDetailPage() {
  const params = useParams();
  const keyId = Array.isArray(params.id) ? params.id[0] : params.id ?? "";
  return <FilamentDetail key={String(keyId)} />;
}

function FilamentDetail() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
  const { formatGrams, formatNumber } = useNumberFormat();
  const params = useParams();
  const router = useRouter();
  const [filament, setFilament] = useState<Filament | null>(null);
  // "Check for OpenPrintTag updates" dialog.
  const [resyncOpen, setResyncOpen] = useState(false);
  // "Link to OpenPrintTag" dialog.
  const [linkOpen, setLinkOpen] = useState(false);
  /**
   * Both `previewOpenFor` and `embedCheck` are keyed to the tdsUrl they
   * apply to, so the *derived* `showTdsPreview` and `tdsEmbedState` below
   * naturally reset when the loaded filament changes, instead of leaking a
   * previous filament's "allowed"/"blocked" verdict to the new one.
   *
   * Done as derived state (not useEffect) because React Compiler's lint
   * rule discourages calling setState inside an effect on a state-dep
   * cycle — a cascading-render anti-pattern.
   */
  const [previewOpenFor, setPreviewOpenFor] = useState<string | null>(null);
  const [embedCheck, setEmbedCheck] = useState<
    | { tdsUrl: string; state: "checking" | "allowed" | "blocked" | "error" }
    | null
  >(null);

  const showTdsPreview =
    !!filament?.tdsUrl && previewOpenFor === filament.tdsUrl;
  const tdsEmbedState: "idle" | "checking" | "allowed" | "blocked" | "error" =
    filament?.tdsUrl && embedCheck?.tdsUrl === filament.tdsUrl
      ? embedCheck.state
      : "idle";
  /** Lookup result for the current filament's `inherits` PrusaSlicer-style
   *  parent name — see the stamp rationale on the lookup effect below. */
  const [inheritsLookup, setInheritsLookup] = useState<
    { inheritsName: string; targetId: string | null } | null
  >(null);
  const inheritsTargetId =
    filament?.inherits && inheritsLookup?.inheritsName === filament.inherits
      ? inheritsLookup.targetId
      : null;
  /** AbortController for the in-flight embed-check fetch. */
  const embedCheckAbortRef = useRef<AbortController | null>(null);
  /** Inline "+ Add Spool" form state — used for both the regular and the
   * first-spool entry points. */
  const [addSpoolForm, setAddSpoolForm] = useState<
    { open: boolean; label: string; totalWeight: string }
  >({ open: false, label: "", totalWeight: "" });
  // GH #440: double-submit guard for the Add Spool Create button.
  // Component-level state because BOTH create buttons (the regular flow
  // and the empty-state fallback) share the same in-flight flag.
  const [addSpoolSubmitting, setAddSpoolSubmitting] = useState(false);
  const { isElectron, status: nfcStatus, writing: nfcWriting, writeTag, notifyTagWritten } = useNfcContext();
  const [nfcWriteSuccess, setNfcWriteSuccess] = useState<boolean | null>(null);
  const nfcWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  // GH #973: NTAG size picker — a promise-based modal used when a reader can't
  // auto-detect the chip size (GET_VERSION rejected). Resolves to the chosen size
  // + whether to remember it as the default, or null when cancelled. The pending
  // resolver lives in a ref (not state) so an unmount mid-prompt can settle the
  // awaiting write chain with null instead of leaking a hung promise.
  type NtagPickResult = { size: NtagSizeName; remember: boolean };
  const { defaultSize: ntagDefaultSize, setDefaultSize: setNtagDefaultSize } = useNtagDefaultSize();
  const [ntagSizePromptOpen, setNtagSizePromptOpen] = useState(false);
  const [ntagRemember, setNtagRemember] = useState(false);
  const ntagRememberRef = useRef(false); // read synchronously in resolveNtagSize (avoids stale closure)
  const ntagSizeResolverRef = useRef<((v: NtagPickResult | null) => void) | null>(null);
  const ntagDialogRef = useRef<HTMLDivElement>(null);
  const setNtagRememberChecked = useCallback((v: boolean) => {
    ntagRememberRef.current = v;
    setNtagRemember(v);
  }, []);
  const promptNtagSize = useCallback(
    () =>
      new Promise<NtagPickResult | null>((resolve) => {
        ntagSizeResolverRef.current = resolve;
        setNtagRememberChecked(false); // reset the checkbox each time the picker opens
        setNtagSizePromptOpen(true);
      }),
    [setNtagRememberChecked],
  );
  // Called by the size buttons (with a size) or cancel/Escape/backdrop (null).
  const resolveNtagSize = useCallback((size: NtagSizeName | null) => {
    setNtagSizePromptOpen(false);
    ntagSizeResolverRef.current?.(
      size == null ? null : { size, remember: ntagRememberRef.current },
    );
    ntagSizeResolverRef.current = null;
  }, []);
  // Settle any pending prompt on unmount so `await promptNtagSize()` can't hang.
  useEffect(
    () => () => {
      ntagSizeResolverRef.current?.(null);
      ntagSizeResolverRef.current = null;
    },
    [],
  );

  const [notFound, setNotFound] = useState(false);

  // Legacy single-spool inline weight update
  const [weightInput, setWeightInput] = useState("");
  const [weightSaving, setWeightSaving] = useState(false);

  // GH #405: store the error TYPE rather than the translated string.
  // With `t` removed from the fetch effect's dep array (intentional —
  // see the comment there), capturing the translated string at fetch
  // time would freeze the message in whichever locale was active when
  // the request failed. Render-time translation picks up the current
  // locale on every re-render.
  type FetchErrorKey = "loadFailed" | "connectionFailed" | null;
  const [fetchError, setFetchError] = useState<FetchErrorKey>(null);
  const [showPrusamentImport, setShowPrusamentImport] = useState(false);
  const [locations, setLocations] = useState<{ _id: string; name: string; kind: string }[]>([]);
  const [printers, setPrinters] = useState<PrinterLite[]>([]);

  // Three action-menu dropdowns (Export / Sync / Variants). Refs let us
  // close them after a click and on an outside click — a bare <details>
  // doesn't collapse on outside click on its own.
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const syncMenuRef = useRef<HTMLDetailsElement>(null);
  const variantsMenuRef = useRef<HTMLDetailsElement>(null);

  const [printLabelOpen, setPrintLabelOpen] = useState(false);

  // GH #595: when arrived via a spool deep-link QR (`?spool=<id>`), scroll to
  // and briefly highlight that spool. Read from window.location (not
  // useSearchParams) to avoid forcing a Suspense boundary on this page; the
  // highlight is a progressive enhancement that only runs client-side.
  const [highlightSpoolId, setHighlightSpoolId] = useState<string | null>(null);
  const deepLinkHandledRef = useRef(false);

  // "Sync from Bambu Studio" file input + in-flight flag. Pinned to this
  // filament's id so the user updates exactly the record they're looking
  // at, regardless of the file's filament_settings_id.
  const bambuSyncRef = useRef<HTMLInputElement>(null);
  const [bambuSyncing, setBambuSyncing] = useState(false);

  const handleBambuSync = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!filament) return;
      const file = e.target.files?.[0];
      if (!file) return;
      setBambuSyncing(true);
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch(`/api/filaments/${filament._id}/bambustudio`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) {
          toast(t("filaments.importFailed", { error: data.error }), "error");
          return;
        }
        toast(t("bambuImport.success", { verb: t("bambuImport.updated"), name: data.name }));
        if (data.calibrationApplied && data.calibrationContext) {
          toast(
            t("bambuImport.calibrationApplied", {
              printer: data.calibrationContext.printerName,
              diameter: data.calibrationContext.nozzleDiameter,
            }),
          );
        } else if (data.calibrationUnresolved) {
          toast(t("bambuImport.calibrationUnresolved"), "info");
        }
        const refreshed = await fetch(`/api/filaments/${filament._id}`);
        if (refreshed.ok) setFilament(await refreshed.json());
      } catch {
        toast(t("filaments.importNetworkError"), "error");
      } finally {
        setBambuSyncing(false);
        if (bambuSyncRef.current) bambuSyncRef.current.value = "";
      }
    },
    [filament, t, toast],
  );

  useEffect(() => {
    return () => { if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current); };
  }, []);

  // Single outside-click listener covers all three menus so they also
  // auto-close each other.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      for (const ref of [exportMenuRef, syncMenuRef, variantsMenuRef]) {
        const el = ref.current;
        if (el && el.open && !el.contains(e.target as Node)) {
          el.removeAttribute("open");
        }
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // GH #405: `t` is intentionally NOT in the dep array — the payload is
    // locale-independent, so re-fetching on every `setLocale` is wasted.
    // Errors are stored as TYPE KEYS and resolved through `t(...)` at
    // render time. Same-route state reset is handled by `key={params.id}`
    // on the wrapper (GH #402), so no per-field clearing here.
    fetch(`/api/filaments/${params.id}`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError("loadFailed"); return null; }
        return r.json();
      })
      .then((data) => { if (data) setFilament(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError("connectionFailed"); });
    return () => controller.abort();
  }, [params.id]);

  // GH #640: never throws — a failed refresh keeps the current data
  // rather than surfacing an unhandled rejection from fire-and-forget
  // callers.
  const refetchFilament = useCallback(async () => {
    try {
      const r = await fetch(`/api/filaments/${params.id}`);
      if (r.ok) setFilament(await r.json());
    } catch {
      // keep the current (stale) filament
    }
  }, [params.id]);

  // GH #595: spool deep-link — once the filament has loaded, if `?spool=<id>`
  // matches a spool, scroll to it and highlight it briefly. The ref makes
  // this fire once (not on every later spool edit that re-sets `filament`).
  //
  // SELF-HEALING stale labels: a printed QR encodes
  // `/filaments/<id>?spool=<spoolId>` permanently, but a spool can move to a
  // different document while its subdoc id stays valid (e.g. a GH #605
  // parent promotion preserves spool _ids verbatim). When the addressed
  // filament doesn't carry the spool, resolve the TRUE owner globally by
  // spool id and router.replace to the owner's page with the full query
  // string intact — the keyed remount then runs this effect again on the
  // owner and highlights the spool. A spool that exists nowhere keeps the
  // quiet posture (stay on the addressed page). Decision logic is pure +
  // unit-tested in src/lib/spoolDeepLink.ts.
  useEffect(() => {
    if (deepLinkHandledRef.current || !filament || typeof window === "undefined") return;
    deepLinkHandledRef.current = true;
    const decision = decideSpoolDeepLink(
      window.location.search,
      (filament.spools ?? []).map((s) => String(s._id)),
    );
    if (decision.action === "none") return;
    if (decision.action === "resolve") {
      let cancelled = false;
      fetch(`/api/spools/${encodeURIComponent(decision.spoolId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data?.filament?._id) return;
          const href = healedSpoolDeepLinkHref(
            String(params.id),
            String(data.filament._id),
            window.location.search,
          );
          if (href) router.replace(href);
        })
        .catch(() => {
          /* offline / resolver error — keep the addressed page as-is */
        });
      return () => { cancelled = true; };
    }
    const spoolId = decision.spoolId;
    // Wait a frame so the SpoolCard element is in the DOM, then scroll/flag.
    const raf = requestAnimationFrame(() => {
      document.getElementById(`spool-${spoolId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightSpoolId(spoolId);
    });
    const clear = setTimeout(() => setHighlightSpoolId(null), 2600);
    return () => { cancelAnimationFrame(raf); clearTimeout(clear); };
  }, [filament, params.id, router]);

  // Load locations once so the spool cards can show a picker without each
  // spool re-fetching.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/locations", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Load printers once — the response carries every amsSlots[].spoolId,
  // so a spool's current slot is derived client-side (GH #242).
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/printers", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setPrinters)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Resolve the `inherits` PrusaSlicer-style parent name to a filament id.
  // The result is stamped with the inheritsName it was for, and the derived
  // `inheritsTargetId` above only returns it when the stamp matches the
  // *current* filament's inherits — so a same-route navigation can't render
  // a stale link to the previous filament's parent.
  useEffect(() => {
    if (!filament?.inherits) return;
    const inheritsName = filament.inherits;
    const ac = new AbortController();
    fetch(`/api/filaments?search=${encodeURIComponent(inheritsName)}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { _id: string; name: string }[]) => {
        const match = rows.find((row) => row.name === inheritsName);
        setInheritsLookup({ inheritsName, targetId: match?._id ?? null });
      })
      .catch(() => {});
    return () => ac.abort();
  }, [filament?.inherits]);

  // Probe whether the TDS URL allows iframe embedding. Done in a click
  // handler (not an effect) because the "set state to 'checking' then
  // fetch" pattern in an effect would re-fire the effect on the very
  // state change it just made, aborting its own request.
  // Plain function (no useCallback) so React Compiler can memoize it.
  const handleToggleTdsPreview = async () => {
    if (!filament?.tdsUrl) return;
    const tdsUrl = filament.tdsUrl;
    if (showTdsPreview) {
      setPreviewOpenFor(null);
      return;
    }
    setPreviewOpenFor(tdsUrl);
    // Skip if we already have a verdict for this exact tdsUrl this session.
    if (embedCheck?.tdsUrl === tdsUrl) return;

    // Cancel any in-flight probe so a late response from the *previous*
    // toggle (different tdsUrl) can't overwrite this one's verdict.
    embedCheckAbortRef.current?.abort();
    const ac = new AbortController();
    embedCheckAbortRef.current = ac;

    setEmbedCheck({ tdsUrl, state: "checking" });
    try {
      const res = await fetch(`/api/embed-check?url=${encodeURIComponent(tdsUrl)}`, {
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { embeddable: boolean } = await res.json();
      // Defence in depth: even if the abort raced and we read the body,
      // skip the write if our controller is no longer the latest one.
      if (embedCheckAbortRef.current !== ac) return;
      setEmbedCheck({ tdsUrl, state: data.embeddable ? "allowed" : "blocked" });
    } catch (err) {
      // Aborted requests are intentional, not errors — just drop them.
      if ((err as { name?: string })?.name === "AbortError") return;
      if (embedCheckAbortRef.current !== ac) return;
      setEmbedCheck({ tdsUrl, state: "error" });
    }
  };

  // GH #583: probe the tag before any write entry point clobbers it. Shared
  // by the explicit "Write NFC" button and the "Update NFC" weight path so a
  // Bambu (read-only) tag is refused consistently.
  //  • Bambu Lab tag → read-only, refuse with a friendly toast
  //  • non-blank tag + confirmOverwrite → confirm before clobbering
  //  • genuinely blank/unformatted tag → allow, write straight through
  //  • unknown read error (transient PC/SC, decode failure on a non-blank tag)
  //    → fail CLOSED: don't silently overwrite a tag we couldn't read.
  //    Mirrors the blank-tag signals raised in electron/ndef.ts + the
  //    auto-read classifier in electron/main.ts.
  // Returns true if the caller should proceed with the write.
  const ensureTagWritable = useCallback(
    async ({ confirmOverwrite = false, targetInstanceId }: { confirmOverwrite?: boolean; targetInstanceId?: string } = {}): Promise<boolean> => {
      type ProbedTag = {
        tagSource?: string;
        materialName?: string;
        brandName?: string;
        spoolUid?: string;
        readOnly?: boolean;
        aux?: { opentag3d_serial?: string } | null;
      };
      let existing: ProbedTag | null | undefined;
      // The tag carries a valid NDEF message but no OpenPrintTag record (e.g.
      // a URL/text/contact tag) — it's NOT blank, just not ours.
      let foreignNdef = false;

      try {
        existing = (await window.electronAPI?.nfcReadTag?.()) as ProbedTag | null | undefined;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Only a GENUINELY blank/erased tag (no NDEF data at all) bypasses the
        // overwrite prompt. "No NDEF record" is NOT blank — it's also thrown by
        // electron/ndef.ts for a valid NDEF message that simply isn't an
        // OpenPrintTag, so it must NOT fail open.
        if (msg.includes("Blank or unformatted") || msg.includes("No NDEF TLV")) {
          return true;
        }
        if (msg.includes("No NDEF record")) {
          foreignNdef = true;
        } else {
          // Transient PC/SC / decode error on an unreadable tag → fail closed
          // so we don't clobber it. The user can reseat and retry.
          toast(t("detail.nfc.probeFailed"), "error");
          return false;
        }
      }

      // Bambu Lab tags are read-only — refuse on every write path. (An
      // OpenTag3D tag is writable on the NTAG path, so it is NOT refused
      // here — it flows through the own-tag / overwrite logic below.)
      if (existing?.tagSource === "bambu") {
        toast(t("detail.nfc.bambuReadOnly"), "error");
        return false;
      }

      // GH #583: honor a soft read-only OpenPrintTag — refuse the write and
      // point the user at Erase / Make Writable.
      if (existing?.readOnly) {
        toast(t("detail.nfc.readOnlyRefuse"), "error");
        return false;
      }

      // The tag already holds data (our OpenPrintTag, or a foreign NDEF tag).
      if (existing || foreignNdef) {
        // Does this decoded OpenPrintTag belong to the CURRENT filament? Match
        // on instance id (most precise) or name+vendor. Only the weight-update
        // path (confirmOverwrite=false) trusts this to skip the prompt.
        const norm = (s?: string | null) => (s ?? "").trim().toLowerCase();
        // #864: an OpenTag3D tag carries its spool serial in
        // aux.opentag3d_serial (no spoolUid slot); fall back to it so an
        // own-OpenTag3D-tag weight update re-writes silently like an OPT tag.
        const tagInstance = norm(existing?.spoolUid ?? existing?.aux?.opentag3d_serial);
        // #732: the SILENT (weight-update) re-write may only accept a tag that
        // positively identifies as THIS write's target spool. The
        // filament-level id is NOT a blanket pass: backfillSpoolInstanceIds
        // carries the filament id onto the FIRST spool, so accepting any tag
        // bearing the filament id would let spool[0]'s tag be silently
        // rewritten while updating a sibling. When the target IS spool[0] (or a
        // spool-less filament), its own id equals the filament id, so the
        // exact-target check still accepts it; a sibling falls through to the
        // overwrite prompt.
        const targetId = norm(targetInstanceId);
        const sameInstance = tagInstance !== "" && targetId !== "" && tagInstance === targetId;
        // A tag with NO spool id but matching name+vendor is a legacy
        // (pre-spool-id) tag of this filament — safe to upgrade silently ONLY
        // when the filament has at most one spool. With multiple spools it's
        // ambiguous which roll the unscoped tag is, so it could clobber a
        // sibling → fall through to the prompt.
        const singleSpool = (filament?.spools?.length ?? 0) <= 1;
        const sameNameVendor =
          tagInstance === "" &&
          singleSpool &&
          norm(existing?.materialName) !== "" &&
          norm(existing?.materialName) === norm(filament?.name) &&
          norm(existing?.brandName) === norm(filament?.vendor);
        const isOwnTag = !foreignNdef && !!existing && (sameInstance || sameNameVendor);

        // Weight-update path silently re-writes THIS filament's own tag (the
        // common case). Any OTHER tag must not be clobbered silently: a
        // foreign NDEF tag fails closed; a different filament's OpenPrintTag
        // falls through to the confirm below.
        if (!confirmOverwrite && isOwnTag) {
          return true;
        }
        if (foreignNdef && !confirmOverwrite) {
          toast(t("detail.nfc.probeFailed"), "error");
          return false;
        }

        // Confirm before clobbering. A foreign NDEF tag has no name to show, so
        // fall back to the generic label.
        const name = existing?.materialName || existing?.brandName || t("detail.nfc.overwriteUnknown");
        return confirm({
          title: t("detail.nfc.overwriteTitle"),
          message: t("detail.nfc.overwriteConfirm", { name }),
          confirmLabel: t("detail.nfc.overwriteConfirmBtn"),
          destructive: true,
        });
      }

      // Blank/unformatted tag → write straight through.
      return true;
    },
    [toast, t, confirm, filament],
  );

  // #864: build the standard's native binary for the loaded chip. Probes via
  // nfcDetectTag — NTAG ⇒ OpenTag3D fixed-binary image, SLIX2/blank ⇒
  // OpenPrintTag CBOR. Returns null (with a toast already shown) when the
  // write should be aborted — e.g. a Bambu tag (read-only).
  const buildTagWritePayload = useCallback(
    async ({
      spoolInstanceId,
      actualWeightGrams,
      requireExtended = false,
    }: {
      spoolInstanceId: string | null;
      actualWeightGrams: number | null;
      /** When true, refuse (rather than silently succeed) if the chip can't hold
       * the OpenTag3D Extended image — the weight-update path's remaining weight
       * (`measured_filament_weight`) + spool id (`serial`) are Extended-only, so
       * a Core-only fallback on a tiny NTAG213 would drop them (#927). */
      requireExtended?: boolean;
    }): Promise<
      | {
          payload: Uint8Array;
          standard: "openprinttag" | "opentag3d";
          productUrl?: string;
          ntagSize?: NtagSizeName;
        }
      | null
    > => {
      if (!filament) return null;

      // Detect which chip is in the field so we encode the right format. If the
      // detect IPC isn't available (older app), fall back to OpenPrintTag — the
      // historical behaviour.
      let detected: Awaited<ReturnType<NonNullable<typeof window.electronAPI>["nfcDetectTag"]>> | null = null;
      try {
        detected = (await window.electronAPI?.nfcDetectTag?.()) ?? null;
      } catch {
        detected = null;
      }

      // A Bambu tag is read-only — refuse with the friendly message (mirrors
      // ensureTagWritable, but the detect probe is the authoritative chip read).
      if (detected?.family === "bambu") {
        toast(t("detail.nfc.bambuReadOnly"), "error");
        return null;
      }

      if (detected?.family === "ntag") {
        const { fields, notices } = filamentToOpenTag3DFields(
          {
            type: filament.type,
            vendor: filament.vendor,
            colorName: filament.colorName,
            color: filament.color,
            secondaryColors: filament.secondaryColors,
            diameter: filament.diameter,
            netFilamentWeight: filament.netFilamentWeight,
            density: filament.density,
            temperatures: {
              nozzle: filament.temperatures?.nozzle,
              bed: filament.temperatures?.bed,
              nozzleRangeMin: filament.temperatures?.nozzleRangeMin,
              nozzleRangeMax: filament.temperatures?.nozzleRangeMax,
            },
            dryingTemperature: filament.dryingTemperature,
            dryingTime: filament.dryingTime,
            maxVolumetricSpeed: filament.maxVolumetricSpeed,
            spoolWeight: filament.spoolWeight,
          },
          { spoolInstanceId, actualWeightGrams },
        );
        if (notices.length > 0) {
          console.warn("[nfc] OpenTag3D lossy mapping:", notices);
          toast(t("detail.nfc.opentag3dNotice"), "info");
        }
        // #927: pick the Core (112B) vs Extended (187B) image by the detected
        // NDEF capacity — the Extended TLV (~214B) overflows a small NTAG213
        // (144B), so fall back to Core-only there instead of letting the
        // write fail with TAG_TOO_SMALL.
        let effectiveCapacity =
          typeof detected?.ndefCapacity === "number" && detected.ndefCapacity > 0
            ? detected.ndefCapacity
            : null;
        // GH #973: an NTAG whose size GET_VERSION couldn't auto-detect reports a
        // null capacity (some readers — e.g. the ACR1552U — reject GET_VERSION
        // outright, so this is the NORMAL case there). Rather than silently
        // downgrade to a 144-byte NTAG213 (dropping the spool id + weight),
        // ask the user which NTAG it is. The chosen size is authoritative on
        // the write side (it rewrites the CC), so this also corrects a tag an
        // earlier failed write mis-formatted.
        let ntagSize: NtagSizeName | undefined;
        if (effectiveCapacity == null) {
          if (ntagDefaultSize !== "ask") {
            // A saved default → skip the prompt so a batch of same-type tags
            // writes without re-picking each time.
            ntagSize = ntagDefaultSize;
          } else {
            const picked = await promptNtagSize();
            if (!picked) return null; // user cancelled the write
            ntagSize = picked.size;
            if (picked.remember) setNtagDefaultSize(picked.size); // "don't ask again"
          }
          effectiveCapacity = NTAG_NAME_TO_NDEF_BYTES[ntagSize];
        }
        let includeExtended = true;
        if (effectiveCapacity != null) {
          const ext = wrapOpenTag3DType2(fields, { includeExtended: true });
          if (ext.tlv.length > effectiveCapacity) includeExtended = false;
        }
        if (!includeExtended) {
          // Refuse rather than report a "successful" update that silently
          // dropped the Extended-only fields (see requireExtended above).
          if (requireExtended) {
            toast(t("detail.nfc.opentag3dTooSmallForUpdate"), "error");
            return null;
          }
          // Write path: Core-only is allowed, but it drops the Extended-only
          // fields (serial/spool id, remaining weight) — tell the user so a
          // later scan that doesn't match the spool isn't a surprise.
          toast(t("detail.nfc.opentag3dCoreOnly"), "info");
        }
        return { payload: encodeOpenTag3D(fields, { includeExtended }), standard: "opentag3d", ntagSize };
      }

      // Default / SLIX2 / blank → OpenPrintTag CBOR.
      const payload = generateOpenPrintTagBinary({
        materialName: filament.name,
        brandName: filament.vendor,
        materialType: filament.type,
        // GH #477: nullable color → omit key 19 from CBOR.
        color: filament.color ?? undefined,
        // The encoder caps secondaryColors at 5 to match the spec (keys 20–24).
        secondaryColors: filament.secondaryColors,
        density: filament.density,
        diameter: filament.diameter,
        nozzleTemp: filament.temperatures?.nozzle,
        nozzleTempFirstLayer: filament.temperatures?.nozzleFirstLayer,
        bedTemp: filament.temperatures?.bed,
        bedTempFirstLayer: filament.temperatures?.bedFirstLayer,
        chamberTemp: filament.settings?.chamber_temperature
          ? Number(filament.settings.chamber_temperature)
          : null,
        weightGrams: filament.netFilamentWeight ?? null,
        actualWeightGrams,
        emptySpoolWeight: filament.spoolWeight ?? null,
        spoolUid: spoolInstanceId,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        abrasive: settingFlagIsOn(filament.settings?.filament_abrasive),
        soluble: settingFlagIsOn(filament.settings?.filament_soluble),
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
      });
      // Include a URI record for Prusa app compatibility.
      const productUrl = filament.tdsUrl
        || `https://filamentdb.app/filament/${encodeURIComponent(filament.vendor)}/${encodeURIComponent(filament.name)}`;
      return { payload, standard: "openprinttag", productUrl };
    },
    [filament, toast, t, promptNtagSize, ntagDefaultSize, setNtagDefaultSize],
  );

  const handleNfcWrite = async () => {
    if (!filament) return;

    // Explicit Write button → confirm before overwriting a tag that holds data.
    if (!(await ensureTagWritable({ confirmOverwrite: true }))) return;

    setNfcWriteSuccess(null);
    try {
      // #732: encode the SELECTED spool's instanceId (default = first
      // non-retired spool; filament-level id only for a spool-less filament),
      // and read the remaining weight from that SAME spool so the tag's id and
      // weight agree — an all-retired filament selects a retired spool for
      // the id, and its weight must come from that spool too, not be dropped.
      // Filament-level fallback uses the legacy top-level weight.
      const writeSel = selectSpoolForWrite(filament);
      const spools = filament.spools ?? [];
      const selectedSpool =
        writeSel.ok && writeSel.source === "spool" && writeSel.spoolId
          ? spools.find((s) => String(s._id) === writeSel.spoolId)
          : null;
      const grossWeight = selectedSpool
        ? selectedSpool.totalWeight
        : writeSel.ok && writeSel.source === "filament"
          ? filament.totalWeight
          : null;
      let actualWeightGrams: number | null = null;
      if (grossWeight != null && filament.spoolWeight != null) {
        actualWeightGrams = Math.max(0, grossWeight - filament.spoolWeight);
      }

      const built = await buildTagWritePayload({
        spoolInstanceId: writeSel.ok ? writeSel.instanceId : null,
        actualWeightGrams,
      });
      if (!built) return; // detection refused (e.g. Bambu) — toast already shown
      await writeTag(built.payload, { standard: built.standard, productUrl: built.productUrl, ntagSize: built.ntagSize });
      notifyTagWritten({
        _id: String(filament._id),
        name: filament.name,
        vendor: filament.vendor,
        type: filament.type,
        color: filament.color ?? "",
      });
      setNfcWriteSuccess(true);
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 3000);
    } catch {
      setNfcWriteSuccess(false);
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 5000);
    }
  };

  const handleNfcWeightUpdate = useCallback(async (scaleWeight: number, spoolId?: string) => {
    if (!filament || filament.spoolWeight == null) return;
    const actualRemaining = Math.max(0, scaleWeight - filament.spoolWeight);
    // #732: write the id of the SPOOL being updated — a spool card passes its
    // own id (so updating spool B's weight writes spool B's id, not the default
    // spool A's); the filament-level NFC-tools button passes none → the
    // active-roll default. Falls back to the filament id for a spool-less row.
    const writeSel = selectSpoolForWrite(filament, spoolId);
    // Pass the TARGET spool id so the silent re-write only accepts a tag for
    // THIS spool (or a legacy filament-level tag); a sibling spool's tag falls
    // through to the overwrite prompt instead of being silently relabeled.
    if (!(await ensureTagWritable({ targetInstanceId: writeSel.ok ? writeSel.instanceId : undefined }))) return;
    setNfcWriteSuccess(null);
    try {
      const built = await buildTagWritePayload({
        spoolInstanceId: writeSel.ok ? writeSel.instanceId : null,
        actualWeightGrams: actualRemaining,
        requireExtended: true, // remaining weight is Extended-only
      });
      if (!built) return; // detection refused — toast already shown
      await writeTag(built.payload, { standard: built.standard, productUrl: built.productUrl, ntagSize: built.ntagSize });
      notifyTagWritten({
        _id: String(filament._id),
        name: filament.name,
        vendor: filament.vendor,
        type: filament.type,
        color: filament.color ?? "",
      });
      setNfcWriteSuccess(true);
      toast(t("detail.nfc.updated", { weight: String(Math.round(actualRemaining)) }));
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 3000);
    } catch {
      setNfcWriteSuccess(false);
      toast(t("detail.nfc.writeFailed"), "error");
      if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current);
      nfcWriteTimerRef.current = setTimeout(() => setNfcWriteSuccess(null), 5000);
    }
  }, [filament, writeTag, notifyTagWritten, toast, t, ensureTagWritable, buildTagWritePayload]);

  const handleWeightUpdate = async () => {
    if (!filament) return;
    const val = parseFloat(weightInput);
    if (isNaN(val) || val < 0) {
      toast(t("detail.weight.invalidInput"), "error");
      return;
    }
    setWeightSaving(true);
    try {
      const res = await fetch(`/api/filaments/${filament._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWeight: val }),
      });
      if (res.ok) {
        setFilament(prev => prev ? { ...prev, totalWeight: val } : prev);
        toast(t("detail.weight.updated"));
        setWeightInput("");
      } else {
        toast(t("detail.weight.updateFailed"), "error");
      }
    } catch {
      toast(t("detail.weight.updateFailed"), "error");
    } finally {
      setWeightSaving(false);
    }
  };

  // GH #1027: the spool-mutation endpoints are called with ?shape=spool, so
  // the response carries only the AFFECTED spool — merge it into local state
  // instead of wholesale-replacing the spools array. Keeps every sibling
  // spool's photo blob + usage ledger off the wire for a one-field write.
  const mergeSpoolIntoState = (spool: FilamentSpool) => {
    setFilament(prev =>
      prev
        ? {
            ...prev,
            spools: (prev.spools ?? []).map(s =>
              s._id.toString() === spool._id.toString() ? spool : s,
            ),
          }
        : prev,
    );
  };

  // GH #1060: "Next #" pre-fills the label with the next roll number —
  // max(numeric labels across ALL spools, incl. retired + trashed) + 1.
  // Suggestion only: nothing is reserved. ONE handler shared by both
  // duplicated Add Spool render sites so the behavior can't drift.
  const [nextLabelLoading, setNextLabelLoading] = useState(false);
  const handleSuggestNextLabel = useCallback(async () => {
    // Snapshot the label at click time: if the fetch is slow and the user
    // types or pastes meanwhile, the response must NOT clobber their newer
    // input. The field stays enabled during the fetch on purpose; disabling
    // it would trade the race for input lockout.
    const labelAtClick = addSpoolForm.label;
    setNextLabelLoading(true);
    try {
      const res = await fetch("/api/spools/next-label");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { next } = (await res.json()) as { next: number };
      setAddSpoolForm((s) =>
        s.label === labelAtClick ? { ...s, label: String(next) } : s,
      );
    } catch {
      toast(t("detail.spool.nextLabelFailed"), "error");
    } finally {
      setNextLabelLoading(false);
    }
  }, [addSpoolForm.label, t, toast]);

  // GH #1080: returns whether the create succeeded so the caller can gate
  // the form reset on it — a failed create must NOT close the form and
  // discard the typed label/weight.
  const handleAddSpool = async (label = "", totalWeight: number | null = null): Promise<boolean> => {
    if (!filament) return false;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools?shape=spool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, totalWeight }),
      });
      if (res.ok) {
        // shape=spool: the body is the created spool (server-minted _id +
        // instanceId) — append it rather than replacing the whole array.
        const created = await res.json();
        setFilament(prev =>
          prev ? { ...prev, spools: [...(prev.spools ?? []), created.spool] } : prev,
        );
        toast(t("detail.spool.added"));
        return true;
      }
      toast(t("detail.spool.addFailed"), "error");
      return false;
    } catch {
      toast(t("detail.spool.addFailed"), "error");
      return false;
    }
  };

  // GH #1080: ONE submit handler shared by BOTH duplicated Add Spool render
  // sites so the success-gated reset can't drift between them. On failure
  // the form stays open with the typed input intact for a retry.
  const handleAddSpoolSubmit = async () => {
    if (addSpoolSubmitting) return;
    const weight = addSpoolForm.totalWeight
      ? Number(addSpoolForm.totalWeight)
      : null;
    setAddSpoolSubmitting(true);
    try {
      const ok = await handleAddSpool(addSpoolForm.label.trim(), weight);
      if (ok) setAddSpoolForm({ open: false, label: "", totalWeight: "" });
    } finally {
      setAddSpoolSubmitting(false);
    }
  };

  // Re-pull printers so every spool card's *derived* AMS-slot assignment
  // reflects server state after any write that may have reconciled slots
  // (#558). GH #640: never throws — the write that triggered the refresh
  // already succeeded, so a failed refresh keeps the stale printers list
  // rather than letting the callers' catch blocks mis-report the whole
  // operation as failed.
  const refreshPrinters = async () => {
    try {
      const pr = await fetch("/api/printers");
      if (pr.ok) setPrinters(await pr.json());
    } catch {
      // keep the current (stale) printers list
    }
  };

  const handleUpdateSpool = async (
    spoolId: string,
    data: {
      totalWeight?: number;
      label?: string;
      locationId?: string | null;
      photoDataUrl?: string | null;
      retired?: boolean;
      // Provenance fields (accepted by the PUT handler + validateSpoolBody).
      lotNumber?: string | null;
      purchaseDate?: string | null;
      openedDate?: string | null;
      // Edit the spool's id, or regenerate a fresh one.
      instanceId?: string;
      regenerate?: boolean;
    },
  ) => {
    if (!filament) return;

    // When the user zeroes the remaining weight on a non-retired spool,
    // offer to retire it in the same write — retiring preserves the spool's
    // history while excluding it from inventory totals (inventoryStats.ts
    // gates on `retired`). Skipped when:
    //   - the caller already passed `retired` (don't clobber an explicit
    //     choice from the SpoolCard's own retire toggle);
    //   - the spool was already retired (the prompt would be a no-op);
    //   - the prior weight was already 0 (no real transition to mark).
    if (data.totalWeight === 0 && data.retired === undefined) {
      const current = filament.spools?.find(
        (s: { _id: { toString(): string } }) => s._id.toString() === spoolId,
      ) as { retired?: boolean; totalWeight?: number | null } | undefined;
      if (current && !current.retired && current.totalWeight !== 0) {
        const retire = await confirm({
          message: t("detail.spool.confirmRetireOnZero"),
          confirmLabel: t("detail.spool.retire"),
        });
        if (retire) {
          data = { ...data, retired: true };
        }
      }
    }

    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}?shape=spool`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated = await res.json();
        mergeSpoolIntoState(updated.spool);
        // #558: retiring a loaded spool clears its printer AMS slot
        // server-side. The card's slot text is derived from `printers`, so
        // refresh it or the stale slot text lingers until reload.
        if (data.retired === true) {
          await refreshPrinters();
        }
        toast(
          data.instanceId !== undefined || data.regenerate
            ? t("detail.spool.instanceIdUpdated")
            : t("detail.spool.updated"),
        );
      } else if (data.instanceId !== undefined || data.regenerate) {
        // Surface the specific id-edit failure (409 duplicate / 400 invalid
        // charset) rather than the generic update error.
        toast(
          res.status === 409
            ? t("detail.spool.instanceIdDuplicate")
            : res.status === 400
              ? t("detail.spool.instanceIdInvalid")
              : t("detail.spool.updateFailed"),
          "error",
        );
      } else {
        toast(t("detail.spool.updateFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.updateFailed"), "error");
    }
  };

  // GH #242 — assign or clear a spool's printer AMS slot. Writes only
  // Printer documents (never the spool's locationId), then re-fetches
  // printers — moving a spool into a slot must visibly clear it from its
  // previous slot.
  const handleAssignSlot = async (
    spoolId: string,
    target: { printerId: string; slotId: string } | null,
  ) => {
    try {
      const res = await fetch(`/api/spools/${spoolId}/assignment`, {
        method: target ? "PUT" : "DELETE",
        headers: target ? { "Content-Type": "application/json" } : undefined,
        body: target ? JSON.stringify(target) : undefined,
      });
      if (res.ok) {
        await refreshPrinters();
        toast(t(target ? "detail.spool.slotAssigned" : "detail.spool.slotCleared"));
      } else {
        toast(t(target ? "detail.spool.slotAssignFailed" : "detail.spool.slotClearFailed"), "error");
      }
    } catch {
      toast(t(target ? "detail.spool.slotAssignFailed" : "detail.spool.slotClearFailed"), "error");
    }
  };

  const handleLogDryCycle = async (
    spoolId: string,
    entry: { tempC?: number | null; durationMin?: number | null; notes?: string },
  ) => {
    if (!filament) return;
    try {
      const res = await fetch(
        `/api/filaments/${filament._id}/spools/${spoolId}/dry-cycles?shape=spool`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (res.ok) {
        const updated = await res.json();
        mergeSpoolIntoState(updated.spool);
        toast(t("detail.spool.dryLogged"));
      } else {
        toast(t("detail.spool.dryLogFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.dryLogFailed"), "error");
    }
  };

  const handleLogUsage = async (
    spoolId: string,
    entry: { grams: number; jobLabel?: string; date?: string },
  ) => {
    if (!filament) return;
    try {
      const res = await fetch(
        `/api/filaments/${filament._id}/spools/${spoolId}/usage?shape=spool`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (res.ok) {
        const updated = await res.json();
        mergeSpoolIntoState(updated.spool);
        toast(t("detail.spool.usageLogged", { grams: entry.grams }));
      } else {
        toast(t("detail.spool.usageLogFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.usageLogFailed"), "error");
    }
  };

  const handleRemoveSpool = async (spoolId: string) => {
    if (!filament) return;
    if (!(await confirm({ message: t("detail.spool.confirmRemove"), destructive: true, confirmLabel: t("common.delete") }))) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}?shape=spool`, {
        method: "DELETE",
      });
      if (res.ok) {
        // shape=spool: the DELETE body is just a deleted-marker — drop the
        // spool from local state by the id we already hold.
        setFilament(prev =>
          prev
            ? {
                ...prev,
                spools: (prev.spools ?? []).filter(s => s._id.toString() !== spoolId),
              }
            : prev,
        );
        toast(t("detail.spool.removed"));
        // Re-focus the document body after confirm() dialog steals focus,
        // so subsequent input fields remain clickable/typeable (#97)
        requestAnimationFrame(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        });
      } else {
        toast(t("detail.spool.removeFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.removeFailed"), "error");
    }
  };

  /**
   * Soft-delete this filament — moves it to the trash (`/trash` restores
   * or purges). Parents-with-live-variants are gated server-side (400
   * with a clear message); no pre-check here — the button stays enabled
   * even for parents so the user gets the API's specific error, which is
   * more helpful than silently disabling the button without saying why.
   */
  const handleDeleteFilament = async () => {
    if (!filament) return;
    const ok = await confirm({
      message: t("detail.delete.confirm", { name: filament.name }),
      destructive: true,
      confirmLabel: t("common.delete"),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}`, { method: "DELETE" });
      if (res.ok) {
        toast(t("detail.delete.success", { name: filament.name }));
        router.push("/");
        return;
      }
      const body = await res.json().catch(() => null);
      toast(body?.error || t("detail.delete.failed"), "error");
    } catch {
      toast(t("detail.delete.failed"), "error");
    }
  };

  const handleMigrateToSpools = async () => {
    if (!filament || filament.totalWeight == null) return;
    try {
      const addRes = await fetch(`/api/filaments/${filament._id}/spools?shape=spool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "", totalWeight: filament.totalWeight }),
      });
      if (!addRes.ok) { toast(t("detail.spool.migrateFailed"), "error"); return; }
      const clearRes = await fetch(`/api/filaments/${filament._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWeight: null }),
      });
      if (clearRes.ok) {
        // Deliberately parsed only after the clear PUT succeeds
        // (partial-failure posture).
        const added = await addRes.json();
        setFilament(prev =>
          prev
            ? { ...prev, spools: [...(prev.spools ?? []), added.spool], totalWeight: null }
            : prev,
        );
        toast(t("detail.spool.migrated"));
      }
    } catch {
      toast(t("detail.spool.migrateFailed"), "error");
    }
  };

  // GH #605: "Convert to template" — a legacy parent that still carries its
  // own color/spools moves that state onto a NEW variant via POST /promote
  // (server-side copy-first / clear-last), leaving the template colorless
  // and inventory-free.
  const handleConvertToTemplate = async () => {
    if (!filament) return;
    const ok = await confirm({
      title: t("detail.template.convertTitle"),
      // GH #1103: this is the ONE prompt before a family is restructured —
      // the message must name every field /promote actually moves, so it's
      // accurate for every gating shape without composing i18n fragments
      // client-side.
      message: t("detail.template.convertConfirm", {
        count: filament.spools?.length ?? 0,
      }),
      confirmLabel: t("detail.template.convertAction"),
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/promote`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.message || body?.error || t("detail.template.convertFailed"), "error");
        return;
      }
      toast(t("detail.template.converted"));
      refetchFilament();
    } catch {
      toast(t("detail.template.convertFailed"), "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("detail.error.notFound")}</p>
      <Link href="/" className="text-blue-600 hover:underline text-sm">&larr; {t("detail.backToFilaments")}</Link>
    </div>
  );
  if (fetchError) return <p className="p-8 text-red-500">{t(`detail.error.${fetchError}`)}</p>;
  if (!filament) return <p className="p-8 text-gray-500">{t("common.loading")}</p>;

  const inherited = new Set(filament._inherited || []);
  const isVariant = !!filament.parentId;
  const isParent = (filament._variants?.length ?? 0) > 0;
  // The single Orca/Bambu .json export bakes only ONE representative
  // calibration (the any-printer/any-bed default); warn whenever ≥1 is
  // dropped. Mirrors droppedCalibrationCount in src/lib/orcaSlicerBundle.ts
  // (kept inline to avoid pulling the export lib into the client bundle).
  const droppedCalibrations = Math.max(0, (filament.calibrations?.length ?? 0) - 1);
  // GH #1102: the Calibrations section must appear whenever there are rows to
  // show, not only when the tick list is non-empty.
  const calibrationSectionVisible =
    (filament.compatibleNozzles?.length ?? 0) > 0 ||
    (filament.calibrations?.length ?? 0) > 0;
  // Parents are finish-agnostic — only variants/standalones carry a
  // texture treatment + chip. resolveFilament() doesn't inherit optTags,
  // so a variant only shows a finish when its own optTags include one
  // of the FINISH_TAG_IDS.
  const finish = !isParent ? deriveFinish(filament.optTags) : null;
  // `<FilamentSwatch isParent>` ignores `arrangement`.
  const arrangement = !isParent ? deriveArrangement(filament.optTags) : "solid";

  return (
    <main id="main-content" className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("detail.back")}
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <FilamentSwatch
          color={filament.color}
          secondaryColors={filament.secondaryColors}
          arrangement={arrangement}
          isParent={isParent}
          variantColors={filament._variants?.flatMap((v) => [
            v.color,
            ...(v.secondaryColors ?? []),
          ])}
          finish={finish}
          size={40}
          className="border-2"
          // Parents: let FilamentSwatch compute the richer "Color group:
          // #… / #…" label from the composite colors so screen-reader users
          // get the same color info sighted users see.
          ariaLabel={isParent ? undefined : t("swatch.colorSwatch", { color: filament.color ?? "#808080" })}
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{filament.name}</h1>
          <p className="text-gray-500">
            <span>
              {filament.vendor}
              {isVariant && inherited.has("vendor") && <InheritedMark />}
            </span>
            {" "}&middot;{" "}
            <span>
              {filament.type}
              {isVariant && inherited.has("type") && <InheritedMark />}
            </span>
            {filament.instanceId && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-mono text-gray-400">
                {filament.instanceId}
                <CopyButton value={filament.instanceId} />
              </span>
            )}
            {isVariant && (
              <span className="ml-2 text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded">
                {t("detail.variant")}
              </span>
            )}
            {isParent && (
              <span className="ml-2 text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded">
                {t("detail.colorCount", { count: filament._variants!.length })}
              </span>
            )}
            {finish && <FinishChip finish={finish} size="sm" className="ml-2" />}
            {finish && isVariant && inherited.has("optTags") && <InheritedMark />}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {/* No NFC status pill here — the global one in AppHeader already
              shows reader/loaded state. */}
          {isElectron && nfcStatus.tagPresent && (
            <button
              onClick={handleNfcWrite}
              disabled={nfcWriting}
              className={`px-4 py-2 text-sm text-white rounded inline-flex items-center gap-1.5 ${
                nfcWriteSuccess === true
                  ? "bg-green-600"
                  : nfcWriteSuccess === false
                    ? "bg-red-600"
                    : "bg-purple-600 hover:bg-purple-700"
              } disabled:opacity-50`}
              title={t("detail.nfc.writeTitle")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
              </svg>
              {nfcWriting
                ? t("detail.nfc.writing")
                : nfcWriteSuccess === true
                  ? t("detail.nfc.success")
                  : nfcWriteSuccess === false
                    ? t("detail.nfc.failed")
                    : t("detail.nfc.write")}
            </button>
          )}
          {/* Export ▾ — anything that emits filament data: label-printer
              output, NFC tag binary, and slicer config files. */}
          <details ref={exportMenuRef} className="relative inline-block">
            <summary
              className="px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-700 text-sm inline-flex items-center gap-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              title={t("detail.exportMenu.title")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {t("detail.exportMenu")}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1">
              {/* Label printer — opens the PrintLabelDialog. On web (no
                  Electron) it falls back to downloading the .bin file so the
                  simulator at scripts/print-label-sim.ts can decode it. */}
              <button
                type="button"
                onClick={() => {
                  setPrintLabelOpen(true);
                  exportMenuRef.current?.removeAttribute("open");
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                title={t("detail.printLabel.title")}
              >
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                <span>{t("detail.printLabel")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = `/api/filaments/${filament._id}/openprinttag`;
                  a.download = "";
                  a.click();
                  exportMenuRef.current?.removeAttribute("open");
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between gap-3"
                title={t("detail.exportOpt.title")}
              >
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
                  </svg>
                  {t("detail.exportOpt")}
                </span>
                <span className="text-xs text-gray-400 font-mono">.bin</span>
              </button>
              {/* Slicer-format exports below the divider. Multi-color warning
                  surfaces here — slicer presets only carry one color,
                  secondary colors are dropped on export (GH #477). */}
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
              <p className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {t("detail.exportMenu.slicerSection")}
              </p>
              {(filament.secondaryColors && filament.secondaryColors.length > 0) && (
                <p className="px-3 py-2 my-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-y border-amber-200 dark:border-amber-800">
                  {t("detail.slicerExport.multiColorNotice")}
                </p>
              )}
              {droppedCalibrations > 0 && (
                <p className="px-3 py-2 my-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-y border-amber-200 dark:border-amber-800">
                  {t("detail.slicerExport.multiCalibrationNotice")}
                </p>
              )}
              {/* GH #1066: a settings-bag printer restriction exports verbatim
                  and hides the preset on every non-matching printer. Surface
                  it so "my filament doesn't show up in PrusaSlicer" has a
                  visible cause; it's editable on the form's Slicer tab. */}
              {(() => {
                const rawRestriction =
                  filament.settings?.compatible_printers_condition ||
                  filament.settings?.compatible_printers;
                // GH #678: compatible_printers may be a multi-valued ARRAY
                // now — render it joined the way PrusaSlicer lists read.
                const restriction = Array.isArray(rawRestriction)
                  ? rawRestriction.join("; ")
                  : rawRestriction;
                // On a VARIANT the detail doc's settings are parent-resolved,
                // so the restriction may live in the PARENT's bag — the raw
                // edit form then can't see or clear it. Point at the parent
                // too.
                return restriction ? (
                  <p className="px-3 py-2 my-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-y border-amber-200 dark:border-amber-800">
                    {t("detail.slicerExport.compatRestrictionNotice", {
                      value: restriction,
                    })}
                    {filament.parentId
                      ? " " + t("detail.slicerExport.compatRestrictionNotice.parentHint")
                      : null}
                  </p>
                ) : null;
              })()}
              {([
                ["prusaslicer", t("detail.slicerExport.prusa"), ".ini"],
                ["orcaslicer", t("detail.slicerExport.orca"), ".json"],
                ["bambustudio", t("detail.slicerExport.bambu"), ".json"],
              ] as const).map(([target, label, ext]) => (
                <button
                  key={target}
                  type="button"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = `/api/filaments/${filament._id}/${target}`;
                    a.download = "";
                    a.click();
                    exportMenuRef.current?.removeAttribute("open");
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between gap-3"
                >
                  <span>{label}</span>
                  <span className="text-xs text-gray-400 font-mono">{ext}</span>
                </button>
              ))}
            </div>
          </details>
          {/* Sync ▾ — pulls calibration data INTO this filament from
              external tools. Hidden file input stays out-of-flow next to the
              <details> so the keyboard tab order doesn't change. */}
          <details ref={syncMenuRef} className="relative inline-block">
            <summary
              className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm inline-flex items-center gap-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              title={t("detail.syncMenu.title")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 12l-4-4m0 0l-4 4m4-4v12" />
              </svg>
              {bambuSyncing ? t("bambuImport.importing") : t("detail.syncMenu")}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1">
              <button
                type="button"
                onClick={() => {
                  bambuSyncRef.current?.click();
                  syncMenuRef.current?.removeAttribute("open");
                }}
                disabled={bambuSyncing}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 flex items-center justify-between gap-3"
                title={t("bambuImport.syncFromBambuTitle")}
              >
                <span>{t("bambuImport.syncFromBambu")}</span>
                <span className="text-xs text-gray-400 font-mono">.json</span>
              </button>
            </div>
          </details>
          <input
            ref={bambuSyncRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleBambuSync}
          />
          {/* Variants ▾ — actions that produce a NEW filament off this one.
              Duplicate is available on every filament (the clone path in
              src/app/filaments/new/page.tsx does `parentId || _id`, so
              cloning a variant produces a sibling). Create variant is gated
              on `!isVariant` — no variants-of-variants. */}
          <details ref={variantsMenuRef} className="relative inline-block">
            <summary
              className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 text-sm inline-flex items-center gap-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden"
              title={t("detail.variantsMenu.title")}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t("detail.variantsMenu")}
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-64 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg py-1">
              <Link
                href={`/filaments/new?cloneId=${filament._id}`}
                onClick={() => variantsMenuRef.current?.removeAttribute("open")}
                className="block px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                title={t("detail.clone.title")}
              >
                {t("detail.clone")}
              </Link>
              {!isVariant && (
                <Link
                  href={`/filaments/new?parentId=${filament._id}`}
                  onClick={() => variantsMenuRef.current?.removeAttribute("open")}
                  className="block px-3 py-1.5 text-sm text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                  title={t("detail.createVariant.title")}
                >
                  {t("detail.createVariant")}
                </Link>
              )}
            </div>
          </details>
          {/* GH #607: only shown when THIS filament carries its own
              OpenPrintTag link (`_hasOwnOptLink`, computed server-side from
              the raw row). A variant inherits the parent's slug through
              resolveFilament's settings merge, so gating on the resolved
              `settings.openprinttag_slug` would show a dead button on every
              variant. Opens the check-for-updates dialog. */}
          {filament._hasOwnOptLink && (
              <button
                type="button"
                onClick={() => setResyncOpen(true)}
                className="px-4 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 text-sm inline-flex items-center gap-1.5"
                title={t("resync.button.title")}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {t("resync.button")}
              </button>
            )}
          {/* Offer to LINK this filament to an OpenPrintTag material when it
              isn't already linked (the inverse of the re-sync button's gate).
              Linking writes only the slug + provenance, never a field value,
              so a variant's inherited values are never clobbered. */}
          {!filament._hasOwnOptLink && (
              <button
                type="button"
                onClick={() => setLinkOpen(true)}
                className="px-4 py-2 bg-teal-600 text-white rounded hover:bg-teal-700 text-sm inline-flex items-center gap-1.5"
                title={t("optLink.button.title")}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 010 5.656l-3 3a4 4 0 01-5.656-5.656l1.5-1.5m6.656-2.828a4 4 0 010-5.656l3-3a4 4 0 015.656 5.656l-1.5 1.5" />
                </svg>
                {t("optLink.button")}
              </button>
            )}
          <Link
            href={`/filaments/${filament._id}/edit`}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
          >
            {t("detail.edit")}
          </Link>
          <button
            type="button"
            onClick={handleDeleteFilament}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm inline-flex items-center gap-1.5"
            title={t("detail.delete.title")}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
            </svg>
            {t("detail.delete")}
          </button>
        </div>
      </div>

      {/* Variant parent link */}
      {isVariant && (
        <div className="mb-4 px-3 py-2 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded text-sm flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-col gap-0.5">
            <span>
              {t("detail.inheritsFromParent")}
              {inherited.size > 0 && (
                <span className="text-gray-500 ml-1">
                  ({t("detail.inheritedFieldCount", { count: inherited.size })})
                </span>
              )}
            </span>
            {inherited.size > 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t("detail.inheritedLegend")}
              </span>
            )}
          </div>
          {filament._parent && (
            <Link
              href={`/filaments/${filament._parent._id}`}
              className="text-blue-700 dark:text-blue-300 hover:underline whitespace-nowrap"
            >
              {t("detail.upToParent", { name: filament._parent.name })}
            </Link>
          )}
        </div>
      )}

      {/* Color variants */}
      {isParent && filament._variants && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">{t("detail.section.colorVariants")}</h2>
          <div className="flex flex-wrap gap-2">
            {filament._variants.map((v) => {
              const vFinish = deriveFinish(v.optTags);
              return (
                <Link
                  key={v._id}
                  href={`/filaments/${v._id}`}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                  <FilamentSwatch
                    color={v.color}
                    secondaryColors={v.secondaryColors}
                    arrangement={deriveArrangement(v.optTags)}
                    finish={vFinish}
                    size={20}
                    ariaLabel={t("swatch.colorSwatch", { color: v.color ?? "#808080" })}
                  />
                  <span className="text-sm">{v.name}</span>
                  {vFinish && <FinishChip finish={vFinish} />}
                  {v.cost != null && (
                    <span className="text-xs text-gray-500">{formatCurrency(v.cost)}</span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <InfoCard label={t("detail.field.nozzleTemp")} value={filament.temperatures.nozzle ? `${filament.temperatures.nozzle}°C` : "—"} inherited={inherited.has("temperatures.nozzle")} />
        <InfoCard label={t("detail.field.nozzleFirstLayer")} value={filament.temperatures.nozzleFirstLayer ? `${filament.temperatures.nozzleFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.nozzleFirstLayer")} />
        <InfoCard label={t("detail.field.bedTemp")} value={filament.temperatures.bed ? `${filament.temperatures.bed}°C` : "—"} inherited={inherited.has("temperatures.bed")} />
        <InfoCard label={t("detail.field.bedFirstLayer")} value={filament.temperatures.bedFirstLayer ? `${filament.temperatures.bedFirstLayer}°C` : "—"} inherited={inherited.has("temperatures.bedFirstLayer")} />
        <InfoCard label={t("detail.field.cost")} value={filament.cost != null ? `${formatCurrency(filament.cost)}/kg` : "—"} inherited={inherited.has("cost")} />
        <InfoCard label={t("detail.field.density")} value={filament.density ? `${formatNumber(filament.density, { minDecimals: 2, maxDecimals: 2, trimTrailingZeros: false })} g/cm³` : "—"} inherited={inherited.has("density")} />
        <InfoCard label={t("detail.field.diameter")} value={filament.diameter != null ? `${formatNumber(filament.diameter, { minDecimals: 2, maxDecimals: 2, trimTrailingZeros: false })} mm` : "—"} inherited={inherited.has("diameter")} />
        {/* Max Vol. Speed is nozzle-specific and shown per-nozzle in the
            Calibrations table below, not here (see fallback tile at the end).
            Fan values ride the settings bag. */}
        <InfoCard label={t("detail.field.minPrintSpeed")} value={filament.minPrintSpeed != null ? `${filament.minPrintSpeed} mm/s` : "—"} inherited={inherited.has("minPrintSpeed")} />
        <InfoCard label={t("detail.field.maxPrintSpeed")} value={filament.maxPrintSpeed != null ? `${filament.maxPrintSpeed} mm/s` : "—"} inherited={inherited.has("maxPrintSpeed")} />
        {/* Per-KEY settings-inheritance provenance isn't plumbed to the detail
            page, so the fan tiles intentionally carry NO inherited badge — a
            coarse badge would mis-mark. */}
        {/* A JSON sync path can store a valid fan speed as the NUMBER 0, which
            is falsy — check null/empty so a real 0% renders as "0%", not "—". */}
        <InfoCard label={t("detail.field.minFanSpeed")} value={filament.settings?.min_fan_speed != null && filament.settings.min_fan_speed !== "" ? `${filament.settings.min_fan_speed}%` : "—"} />
        <InfoCard label={t("detail.field.maxFanSpeed")} value={filament.settings?.max_fan_speed != null && filament.settings.max_fan_speed !== "" ? `${filament.settings.max_fan_speed}%` : "—"} />
        {/* Max Vol. Speed fallback tile — shown whenever the value isn't
            ACTUALLY visible in the Calibrations table. GH #1102: the gate is
            `calibrationSectionVisible`, not `compatibleNozzles` — the section
            renders whenever rows exist, so keying off the tick list would
            double-render the value in the tile AND the table. */}
        {filament.maxVolumetricSpeed != null &&
          !(
            calibrationSectionVisible &&
            filament.calibrations?.some(
              (c) => (c as FilamentCalibration).maxVolumetricSpeed != null,
            )
          ) && (
            <InfoCard
              label={t("detail.field.maxVolSpeed")}
              value={`${filament.maxVolumetricSpeed} mm³/s`}
              inherited={inherited.has("maxVolumetricSpeed")}
            />
          )}
      </div>

      {/* Spool Tracker — always rendered (for non-templates); the empty
          state surfaces an Add Spool CTA via the fallback at the bottom of
          this block. */}
      {(() => {
        // GH #605: templates (filaments with variants) hold no inventory —
        // spools live on the color variants, and the spools POST rejects a
        // template target (template_no_spools). Replace the whole tracker
        // (including the NFC/scale weight-update paths inside it) with a
        // short explanatory line. Legacy parent spools created before the
        // guard aren't manageable here — "Convert to template" moves them
        // onto a variant.
        if (isParent) {
          // A legacy parent that still carries its own variant state gets
          // the explicit "Convert to template" action. The predicate is the
          // SAME one the server's promotion gate + /promote route use
          // (parentPromotionState; the spoolWeight/netFilamentWeight SPEC
          // pair never gates), so the button shows exactly when /promote
          // would do something rather than 400 nothing_to_convert.
          const carriesLegacyState = parentPromotionState(filament).needed;
          return (
            <div className="mb-8 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <h2 className="text-sm font-medium text-gray-500 mb-2">{t("detail.section.spoolTracker")}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">{t("detail.spool.templateNote")}</p>
              {carriesLegacyState && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    {t("detail.template.convertHint")}
                  </p>
                  <button
                    type="button"
                    onClick={handleConvertToTemplate}
                    className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700"
                  >
                    {t("detail.template.convertAction")}
                  </button>
                </div>
              )}
            </div>
          );
        }
        const hasSpools = filament.spools?.length > 0;
        const legacyRemaining = !hasSpools ? computeRemaining(filament) : null;

        // GH #1103: a parent whose variants are ALL trashed is not a template
        // (`isParent` is live-only, correctly), so it keeps its normal spool
        // tracker below. But it IS the one shape the restore route refuses
        // on, and its refusal tells the user to come here and convert.
        // Without this the action doesn't exist, and every gated variant is
        // unrestorable through the app.
        const canConvertForTrashedVariants =
          !!filament._hasTrashedVariants && parentPromotionState(filament).needed;

        // GH #1099: the helpers in @/lib/inventoryStats (which exclude
        // retired spools) are the single source of truth every other
        // surface already uses.
        const aggregateSpoolCount = getSpoolCount(filament);
        const aggregateRemaining = getRemainingGrams(filament);
        const aggregatePct = getRemainingPct(filament);

        return (
          <div className="mb-8 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            {canConvertForTrashedVariants && (
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  {t("detail.template.trashedVariantsHint")}
                </p>
                <button
                  type="button"
                  onClick={handleConvertToTemplate}
                  className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded hover:bg-amber-700"
                >
                  {t("detail.template.convertAction")}
                </button>
              </div>
            )}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-500">{t("detail.section.spoolTracker")}</h2>
              {hasSpools && (
                <span className="text-xs text-gray-400">
                  {t(
                    aggregateSpoolCount === 1 ? "detail.spoolCount.one" : "detail.spoolCount.other",
                    { count: aggregateSpoolCount },
                  )}
                  {aggregateRemaining != null &&
                    ` · ${formatGrams(aggregateRemaining)}g ${t("detail.total")}${
                      aggregatePct != null ? ` (${aggregatePct}%)` : ""
                    }`}
                </span>
              )}
            </div>

            {/* Filament-level info cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {filament.netFilamentWeight != null && (
                <InfoCard label={t("detail.field.netFilament")} value={`${formatGrams(filament.netFilamentWeight)}g`} inherited={inherited.has("netFilamentWeight")} />
              )}
              {filament.spoolWeight != null && (
                <InfoCard label={t("detail.field.spoolWeight")} value={`${formatGrams(filament.spoolWeight)}g`} inherited={inherited.has("spoolWeight")} />
              )}
              {/* Legacy single-spool remaining */}
              {!hasSpools && legacyRemaining && (
                <InfoCard label={t("detail.field.remaining")} value={`${formatGrams(legacyRemaining.remainingWeight)}g${legacyRemaining.pct != null ? ` (${legacyRemaining.pct}%)` : ""}`} />
              )}
              {!hasSpools && legacyRemaining?.lengthMeters != null && (
                <InfoCard label={t("detail.field.lengthLeft")} value={`${formatNumber(legacyRemaining.lengthMeters, { minDecimals: 1, maxDecimals: 1, trimTrailingZeros: false })}m`} />
              )}
            </div>

            {/* Legacy single-spool progress bar & update */}
            {!hasSpools && legacyRemaining?.pct != null && (
              <div className="mb-4">
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all ${
                      legacyRemaining.pct > 25 ? "bg-green-500" : legacyRemaining.pct > 10 ? "bg-yellow-500" : "bg-red-500"
                    }`}
                    style={{ width: `${legacyRemaining.pct}%` }}
                  />
                </div>
              </div>
            )}

            {!hasSpools && filament.spoolWeight != null && (
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <label htmlFor="filament-scale-weight" className="text-sm text-gray-500 flex-shrink-0">{t("detail.weight.updateScaleWeight")}:</label>
                <input
                  id="filament-scale-weight"
                  type="number"
                  step="1"
                  min="0"
                  className="w-28 px-2 py-1 border border-gray-300 rounded text-sm bg-transparent"
                  value={weightInput}
                  onChange={(e) => setWeightInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleWeightUpdate(); }}
                  placeholder={filament.totalWeight != null ? `${filament.totalWeight}g` : t("detail.spool.weightPlaceholder")}
                />
                <button
                  onClick={handleWeightUpdate}
                  disabled={weightSaving || !weightInput}
                  className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:text-gray-200 disabled:cursor-not-allowed disabled:hover:bg-gray-400"
                >
                  {weightSaving ? "..." : t("common.save")}
                </button>
                {isElectron && nfcStatus.tagPresent && (
                  <button
                    onClick={() => {
                      const val = parseFloat(weightInput);
                      if (!isNaN(val) && val > 0) {
                        handleNfcWeightUpdate(val);
                      } else if (filament.totalWeight != null) {
                        handleNfcWeightUpdate(filament.totalWeight);
                      } else {
                        toast(t("detail.weight.enterFirst"), "error");
                      }
                    }}
                    disabled={nfcWriting}
                    className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
                    title={t("detail.nfc.updateWeightTitle")}
                  >
                    {nfcWriting ? "..." : t("detail.nfc.updateNfc")}
                  </button>
                )}
              </div>
            )}

            {/* Migrate legacy to spool tracking */}
            {!hasSpools && filament.totalWeight != null && (
              <button
                onClick={handleMigrateToSpools}
                className="text-xs text-blue-600 hover:underline"
              >
                {t("detail.spool.trackMultiple")} &rarr;
              </button>
            )}

            {/* Multi-spool cards */}
            {hasSpools && (
              <div className="space-y-3">
                {filament.spools.map((spool) => (
                  <SpoolCard
                    key={spool._id}
                    spool={spool}
                    filament={filament}
                    locations={locations}
                    printers={printers}
                    onAssignSlot={(target) => handleAssignSlot(spool._id, target)}
                    onUpdateWeight={(weight) => handleUpdateSpool(spool._id, { totalWeight: weight })}
                    onUpdateLabel={(label) => handleUpdateSpool(spool._id, { label })}
                    onUpdateLocation={(locationId) => handleUpdateSpool(spool._id, { locationId })}
                    onUpdatePhoto={(dataUrl) => handleUpdateSpool(spool._id, { photoDataUrl: dataUrl })}
                    onToggleRetire={(retired) => handleUpdateSpool(spool._id, { retired })}
                    onLogDryCycle={(entry) => handleLogDryCycle(spool._id, entry)}
                    onLogUsage={(entry) => handleLogUsage(spool._id, entry)}
                    onUpdateMeta={(patch) => handleUpdateSpool(spool._id, patch)}
                    onRemove={() => handleRemoveSpool(spool._id)}
                    onUpdateInstanceId={(instanceId) => handleUpdateSpool(spool._id, { instanceId })}
                    onRegenerateInstanceId={async () => {
                      // Regenerating is irreversible and orphans any
                      // already-printed label / written tag — confirm first.
                      if (
                        await confirm({
                          message: t("detail.spool.regenerateConfirm"),
                          confirmLabel: t("detail.spool.regenerateId"),
                          destructive: true,
                        })
                      ) {
                        handleUpdateSpool(spool._id, { regenerate: true });
                      }
                    }}
                    onNfcWeightUpdate={(scaleWeight) => handleNfcWeightUpdate(scaleWeight, String(spool._id))}
                    nfcAvailable={isElectron && nfcStatus.tagPresent}
                    nfcWriting={nfcWriting}
                    highlight={highlightSpoolId === String(spool._id)}
                  />
                ))}
                {addSpoolForm.open ? (
                  <div className="flex flex-wrap gap-2 items-stretch p-3 border border-blue-300 dark:border-blue-700 rounded-lg bg-blue-50/30 dark:bg-blue-950/20">
                    <input
                      type="text"
                      autoFocus
                      placeholder={t("detail.spool.addLabelPlaceholder")}
                      value={addSpoolForm.label}
                      onChange={(e) => setAddSpoolForm((s) => ({ ...s, label: e.target.value }))}
                      aria-label={t("detail.spool.addLabelPlaceholder")}
                      className="flex-1 min-w-[10rem] px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
                    />
                    <button
                      type="button"
                      onClick={handleSuggestNextLabel}
                      disabled={nextLabelLoading}
                      title={t("detail.spool.nextLabelTitle")}
                      className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                    >
                      {nextLabelLoading ? "…" : t("detail.spool.nextLabel")}
                    </button>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      placeholder={t("detail.spool.addWeightPlaceholder")}
                      value={addSpoolForm.totalWeight}
                      onChange={(e) => setAddSpoolForm((s) => ({ ...s, totalWeight: e.target.value }))}
                      aria-label={t("detail.spool.addWeightPlaceholder")}
                      className="w-32 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
                    />
                    <button
                      disabled={addSpoolSubmitting}
                      onClick={handleAddSpoolSubmit}
                      className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t("detail.spool.addCreate")}
                    </button>
                    <button
                      disabled={addSpoolSubmitting}
                      onClick={() =>
                        setAddSpoolForm({ open: false, label: "", totalWeight: "" })
                      }
                      className="px-4 py-1.5 border border-gray-300 dark:border-gray-700 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => setAddSpoolForm({ open: true, label: "", totalWeight: "" })}
                      className="flex-1 py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                    >
                      + {t("detail.addSpool")}
                    </button>
                    <button
                      onClick={() => setShowPrusamentImport(true)}
                      className="py-2 px-3 border-2 border-dashed border-orange-300 dark:border-orange-700 rounded-lg text-sm text-orange-500 hover:border-orange-400 hover:text-orange-600 transition-colors"
                      title={t("detail.spool.prusamentImportTitle")}
                    >
                      + {t("detail.spool.prusamentQr")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Add-first-spool fallback — the CTA appears whenever there are
                no spools and no legacy totalWeight-based tracking. When NO
                weights are configured at all, also surface a short hint above
                the button — otherwise the empty section looks broken rather
                than awaiting input. */}
            {!hasSpools && filament.totalWeight == null && (
              <>
                {filament.spoolWeight == null && filament.netFilamentWeight == null && !addSpoolForm.open && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                    {t("detail.spool.emptyHint")}
                  </p>
                )}
                {addSpoolForm.open ? (
                <div className="flex flex-wrap gap-2 items-stretch p-3 border border-blue-300 dark:border-blue-700 rounded-lg bg-blue-50/30 dark:bg-blue-950/20">
                  <input
                    type="text"
                    autoFocus
                    placeholder={t("detail.spool.addLabelPlaceholder")}
                    value={addSpoolForm.label}
                    onChange={(e) => setAddSpoolForm((s) => ({ ...s, label: e.target.value }))}
                    aria-label={t("detail.spool.addLabelPlaceholder")}
                    className="flex-1 min-w-[10rem] px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
                  />
                  <button
                    type="button"
                    onClick={handleSuggestNextLabel}
                    disabled={nextLabelLoading}
                    title={t("detail.spool.nextLabelTitle")}
                    className="px-2.5 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                  >
                    {nextLabelLoading ? "…" : t("detail.spool.nextLabel")}
                  </button>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder={t("detail.spool.addWeightPlaceholder")}
                    value={addSpoolForm.totalWeight}
                    onChange={(e) => setAddSpoolForm((s) => ({ ...s, totalWeight: e.target.value }))}
                    aria-label={t("detail.spool.addWeightPlaceholder")}
                    className="w-32 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
                  />
                  <button
                    disabled={addSpoolSubmitting}
                    onClick={handleAddSpoolSubmit}
                    className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t("detail.spool.addCreate")}
                  </button>
                  <button
                    disabled={addSpoolSubmitting}
                    onClick={() => setAddSpoolForm({ open: false, label: "", totalWeight: "" })}
                    className="px-4 py-1.5 border border-gray-300 dark:border-gray-700 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setAddSpoolForm({ open: true, label: "", totalWeight: "" })}
                  className="w-full py-2 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
                >
                  + {t("detail.addSpool")}
                </button>
              )}
              </>
            )}
          </div>
        );
      })()}

      {/* GH #1102: also render when calibrations EXIST. Gating purely on
          compatibleNozzles hid the whole section in exactly the state a
          slicer sync-back produces (the #859 fallback resolves a nozzle from
          the global catalog and never writes the tick list). */}
      {calibrationSectionVisible && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {filament.calibrations?.length > 0
              ? t("detail.section.nozzleCalibrations")
              : t("detail.section.compatibleNozzles")}
            {inherited.has(
              filament.calibrations?.length > 0 ? "calibrations" : "compatibleNozzles",
            ) && (
              <span className="ml-1 text-xs text-blue-500">({t("detail.inherited")})</span>
            )}
          </h2>
          {filament.calibrations?.length > 0 ? (
            <div className="overflow-x-auto space-y-4">
              {(() => {
                const groups = new Map<string, typeof filament.calibrations>();
                for (const cal of filament.calibrations) {
                  const key = cal.printer?._id || "default";
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(cal);
                }
                const hasBedTypes = filament.calibrations.some((c) => (c as FilamentCalibration).bedType);
                const hasTemps = filament.calibrations.some((c) => { const e = c as FilamentCalibration; return e.nozzleTemp || e.bedTemp || e.chamberTemp; });
                const hasFans = filament.calibrations.some((c) => { const e = c as FilamentCalibration; return e.fanMinSpeed || e.fanMaxSpeed || e.fanBridgeSpeed; });
                return Array.from(groups.entries()).map(([groupKey, cals]) => (
                  <div key={groupKey}>
                    {groups.size > 1 && (
                      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
                        {cals[0].printer?.name || t("detail.calibration.defaultPrinter")}
                      </h3>
                    )}
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b border-gray-300">
                          <th scope="col" className="text-left py-2 px-2">{t("detail.calibration.nozzle")}</th>
                          {hasBedTypes && <th scope="col" className="text-left py-2 px-2">{t("detail.calibration.bedType")}</th>}
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.em")}</th>
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.maxVol")}</th>
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.pa")}</th>
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.retract")}</th>
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.speed")}</th>
                          <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.zLift")}</th>
                          {hasTemps && (
                            <>
                              <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.nozzleTemp")}</th>
                              <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.bedTempShort")}</th>
                            </>
                          )}
                          {hasFans && <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.fan")}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {cals.map((cal, i) => {
                          const ext = cal as FilamentCalibration;
                          return (
                          <tr
                            key={i}
                            className="border-b border-gray-200 dark:border-gray-800"
                          >
                            <td className="py-2 px-2">
                              {cal.nozzle?.name || "\u2014"}
                              {cal.nozzle?.highFlow && (
                                <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                                  HF
                                </span>
                              )}
                            </td>
                            {hasBedTypes && (
                              <td className="py-2 px-2">
                                {ext.bedType ? ext.bedType.name : "\u2014"}
                              </td>
                            )}
                            <td className="py-2 px-2 text-right">
                              {cal.extrusionMultiplier ?? "\u2014"}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {/* `?? "—"`, not a truthiness check: a stored 0
                                  is a real value, and the fallback tile above
                                  suppresses itself on `!= null` — an em-dash
                                  here would leave a 0 visible nowhere at all. */}
                              {cal.maxVolumetricSpeed ?? "\u2014"}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {cal.pressureAdvance ?? "\u2014"}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {cal.retractLength ? `${cal.retractLength}mm` : "\u2014"}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {cal.retractSpeed ? `${cal.retractSpeed}` : "\u2014"}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {cal.retractLift ? `${cal.retractLift}mm` : "\u2014"}
                            </td>
                            {hasTemps && (
                              <>
                                <td className="py-2 px-2 text-right">
                                  {ext.nozzleTemp ? `${ext.nozzleTemp}\u00b0` : "\u2014"}
                                </td>
                                <td className="py-2 px-2 text-right">
                                  {ext.bedTemp ? `${ext.bedTemp}\u00b0` : "\u2014"}
                                </td>
                              </>
                            )}
                            {hasFans && (
                              <td className="py-2 px-2 text-right">
                                {ext.fanMinSpeed || ext.fanMaxSpeed
                                  ? `${ext.fanMinSpeed ?? "\u2014"}/${ext.fanMaxSpeed ?? "\u2014"}%`
                                  : "\u2014"}
                              </td>
                            )}
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ));
              })()}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filament.compatibleNozzles.map((n) => (
                <span
                  key={n._id}
                  className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg text-sm"
                >
                  {n.name}
                  {n.highFlow && (
                    <span className="ml-1.5 px-1.5 py-0.5 bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 rounded text-xs">
                      HF
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {filament.presets && filament.presets.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {t("detail.section.presets")}
            {inherited.has("presets") && (
              <span className="ml-1 text-xs text-blue-500">({t("detail.inherited")})</span>
            )}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-300">
                  <th scope="col" className="text-left py-2 px-2">{t("detail.preset.label")}</th>
                  <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.em")}</th>
                  <th scope="col" className="text-right py-2 px-2">{t("detail.calibration.nozzle")}</th>
                  <th scope="col" className="text-right py-2 px-2">{t("detail.preset.nozzleFirst")}</th>
                  <th scope="col" className="text-right py-2 px-2">{t("detail.preset.bed")}</th>
                  <th scope="col" className="text-right py-2 px-2">{t("detail.preset.bedFirst")}</th>
                </tr>
              </thead>
              <tbody>
                {filament.presets.map((preset, i) => (
                  <tr
                    key={i}
                    className="border-b border-gray-200 dark:border-gray-800"
                  >
                    <td className="py-2 px-2 font-medium">{preset.label}</td>
                    <td className="py-2 px-2 text-right">
                      {preset.extrusionMultiplier ?? "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.nozzle ? `${preset.temperatures.nozzle}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.nozzleFirstLayer ? `${preset.temperatures.nozzleFirstLayer}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.bed ? `${preset.temperatures.bed}°C` : "—"}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {preset.temperatures?.bedFirstLayer ? `${preset.temperatures.bedFirstLayer}°C` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {filament.tdsUrl && (
        <div className="mb-6">
          <button
            onClick={handleToggleTdsPreview}
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            {showTdsPreview ? t("detail.tds.hide") : t("detail.tds.view")}
          </button>
          {isVariant && inherited.has("tdsUrl") && <InheritedMark />}
          {safeHttpUrl(filament.tdsUrl) && (
            <a
              href={safeHttpUrl(filament.tdsUrl)!}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-3 text-xs text-gray-500 hover:underline"
            >
              {t("detail.tds.openNewTab")}
            </a>
          )}
          {showTdsPreview && (
            <div className="mt-3">
              {tdsEmbedState === "checking" && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("detail.tds.checking")}
                </p>
              )}
              {tdsEmbedState === "allowed" && safeHttpUrl(filament.tdsUrl) && (
                <div className="border border-gray-300 dark:border-gray-700 rounded overflow-hidden">
                  <iframe
                    src={safeHttpUrl(filament.tdsUrl)!}
                    className="w-full bg-white"
                    style={{ height: "80vh" }}
                    title={t("detail.tds.title")}
                    sandbox="allow-same-origin allow-scripts"
                  />
                </div>
              )}
              {(tdsEmbedState === "blocked" || tdsEmbedState === "error") && (
                <div className="border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 rounded p-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                        {tdsEmbedState === "blocked"
                          ? t("detail.tds.blockedTitle")
                          : t("detail.tds.errorTitle")}
                      </p>
                      <p className="text-sm text-amber-800 dark:text-amber-200/80 mt-1">
                        {tdsEmbedState === "blocked"
                          ? t("detail.tds.blockedBody")
                          : t("detail.tds.errorBody")}
                      </p>
                      {safeHttpUrl(filament.tdsUrl) && (
                        <a
                          href={safeHttpUrl(filament.tdsUrl)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded"
                        >
                          {t("detail.tds.openExternal")}
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {filament.inherits && (
        <p className="text-sm text-gray-500 mb-4">
          {t("detail.inheritsFrom")}:{" "}
          {inheritsTargetId ? (
            <Link
              href={`/filaments/${inheritsTargetId}`}
              className="font-mono text-blue-600 hover:underline"
            >
              {filament.inherits}
            </Link>
          ) : (
            <span className="font-mono">{filament.inherits}</span>
          )}
        </p>
      )}

      {/* The FDM Polymers Technical Reference chapter for this filament's
          type. Self-hides when the type maps to no chapter. */}
      <TechnicalReferencePanel type={filament.type} />

      {showPrusamentImport && (
        <PrusamentImportDialog
          onClose={() => setShowPrusamentImport(false)}
          targetFilamentId={filament?._id}
          onImported={(message) => {
            toast(message, "success");
            // GH #640: refetchFilament gates on r.ok — writing a non-2xx
            // error body into `filament` state crashes the next render.
            refetchFilament();
            setShowPrusamentImport(false);
          }}
        />
      )}
      <PrintLabelDialog
        open={printLabelOpen}
        onClose={() => setPrintLabelOpen(false)}
        filament={{
          _id: filament._id,
          name: filament.name,
          instanceId: filament.instanceId ?? null,
          vendor: filament.vendor ?? null,
          type: filament.type ?? null,
          colorName: filament.colorName ?? null,
          // Spools so the URL-mode QR can deep-link to one (GH #595) and the
          // instance-ID QR can encode the selected spool's id (#732).
          spools: (filament.spools ?? []).map((s) => ({
            _id: String(s._id),
            label: s.label ?? null,
            instanceId: s.instanceId ?? null,
            retired: s.retired ?? false,
          })),
        }}
      />
      {resyncOpen && (
        <OptResyncDialog
          filamentId={String(filament._id)}
          onApplied={refetchFilament}
          onClose={() => setResyncOpen(false)}
          onChangeLink={() => setLinkOpen(true)}
        />
      )}
      {linkOpen && (
        <OptLinkDialog
          filamentId={String(filament._id)}
          onLinked={refetchFilament}
          onClose={() => setLinkOpen(false)}
          mode={filament._hasOwnOptLink ? "change" : "link"}
        />
      )}
      {ntagSizePromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            // Backdrop click cancels (matches ConfirmDialog). mouseDown on the
            // overlay itself only — not a drag that ends there from inside.
            if (e.target === e.currentTarget) resolveNtagSize(null);
          }}
        >
          <div
            ref={ntagDialogRef}
            className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ntag-size-title"
            aria-describedby="ntag-size-body"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                resolveNtagSize(null);
                return;
              }
              // Focus trap: cycle Tab/Shift+Tab within the dialog's buttons.
              if (e.key !== "Tab") return;
              const focusables = ntagDialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
              if (!focusables || focusables.length === 0) return;
              const first = focusables[0];
              const last = focusables[focusables.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
              }
            }}
          >
            <h2 id="ntag-size-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t("detail.nfc.ntagSize.title")}
            </h2>
            <p id="ntag-size-body" className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {t("detail.nfc.ntagSize.body")}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {(["NTAG213", "NTAG215", "NTAG216"] as NtagSizeName[]).map((size) => (
                <button
                  key={size}
                  type="button"
                  autoFocus={size === "NTAG215"}
                  onClick={() => resolveNtagSize(size)}
                  className="flex items-center justify-between rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <span className="font-medium text-gray-900 dark:text-gray-100">{size}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {NTAG_NAME_TO_NDEF_BYTES[size]} B
                    {size === "NTAG213" ? ` · ${t("detail.nfc.ntagSize.coreOnly")}` : ""}
                  </span>
                </button>
              ))}
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={ntagRemember}
                onChange={(e) => setNtagRememberChecked(e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-600"
              />
              {t("detail.nfc.ntagSize.remember")}
            </label>
            <button
              type="button"
              onClick={() => resolveNtagSize(null)}
              className="mt-3 w-full rounded-md px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t("detail.nfc.ntagSize.cancel")}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/** Minimal printer shape the spool cards need for the AMS-slot picker.
 * `amsSlots` is optional — printer documents created before the field
 * existed come back from a lean query without it. */
type PrinterLite = {
  _id: string;
  name: string;
  amsSlots?: { _id: string; slotName: string; spoolId: string | null }[];
};

interface SpoolCardProps {
  spool: Filament["spools"][number] & {
    locationId?: string | null;
    photoDataUrl?: string | null;
    retired?: boolean;
    // Provenance fields — ISO strings from the JSON serializer; may be
    // undefined if the spool subdoc predates the field.
    lotNumber?: string | null;
    purchaseDate?: string | null;
    openedDate?: string | null;
    dryCycles?: { date: string | Date; tempC: number | null; durationMin: number | null; notes: string }[];
    usageHistory?: { grams: number; jobLabel: string; date: string | Date; source: string }[];
  };
  filament: Filament;
  locations: { _id: string; name: string; kind: string }[];
  printers: PrinterLite[];
  onAssignSlot: (target: { printerId: string; slotId: string } | null) => void;
  onUpdateWeight: (weight: number) => void;
  onUpdateLabel: (label: string) => void;
  onUpdateLocation: (locationId: string | null) => void;
  onUpdatePhoto: (dataUrl: string | null) => void;
  onToggleRetire: (retired: boolean) => void;
  onLogDryCycle: (entry: { tempC?: number | null; durationMin?: number | null; notes?: string }) => void;
  onLogUsage: (entry: { grams: number; jobLabel?: string; date?: string }) => void;
  /**
   * One callback for the provenance group so the user can save a partial
   * patch (e.g. set the purchase date without touching the lot field).
   */
  onUpdateMeta: (patch: {
    lotNumber?: string | null;
    purchaseDate?: string | null;
    openedDate?: string | null;
  }) => void;
  onRemove: () => void;
  onNfcWeightUpdate?: (scaleWeight: number) => void;
  nfcAvailable?: boolean;
  nfcWriting?: boolean;
  /** Set a custom spool id (e.g. a Prusa roll id), or regenerate. */
  onUpdateInstanceId: (instanceId: string) => void;
  onRegenerateInstanceId: () => void;
  /** GH #595: briefly ring this card when reached via a `?spool=` deep link. */
  highlight?: boolean;
}

function SpoolCard({
  spool,
  filament,
  locations,
  printers,
  onAssignSlot,
  onUpdateWeight,
  onUpdateLabel,
  onUpdateLocation,
  onUpdatePhoto,
  onToggleRetire,
  onLogDryCycle,
  onLogUsage,
  onUpdateMeta,
  onRemove,
  onNfcWeightUpdate,
  nfcAvailable,
  nfcWriting,
  onUpdateInstanceId,
  onRegenerateInstanceId,
  highlight,
}: SpoolCardProps) {
  const { t } = useTranslation();
  const { formatDate } = useDateFormat();
  const { formatGrams, formatNumber } = useNumberFormat();
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(spool.label);
  // Inline spool-id editing (mirrors the label-edit pattern).
  const [editingId, setEditingId] = useState(false);
  const [idInput, setIdInput] = useState(spool.instanceId ?? "");
  const [showMore, setShowMore] = useState(false);
  const [dryTemp, setDryTemp] = useState("");
  const [dryDuration, setDryDuration] = useState("");
  const [usageGrams, setUsageGrams] = useState("");
  const [usageLabel, setUsageLabel] = useState("");
  // #941: when the usage happened, defaulting to today in the user's LOCAL
  // date. Seeded post-mount (not in the initializer) so the value derives
  // from the BROWSER's timezone, never the server's — a server-side render
  // around a UTC date boundary would otherwise bake in the server's "today"
  // and mismatch the client's local day. `todayInput` also drives the
  // picker's `max`. Mirrors the post-mount seeding in src/app/inventory/page.tsx.
  const [usageDate, setUsageDate] = useState("");
  const [todayInput, setTodayInput] = useState("");
  // Whether the user has actually edited the date field. An UNTOUCHED
  // default must always log as "now", never as a backdate — otherwise a
  // page left open across local midnight would silently backdate a plain
  // "log now" click to yesterday (#941). `refreshDefaultDate` re-seeds the
  // default + `max` from the CURRENT local day so an untouched field/picker
  // stays current across a rollover.
  const [usageDateDirty, setUsageDateDirty] = useState(false);
  const refreshDefaultDate = () => {
    if (usageDateDirty) return;
    const t = localTodayInput();
    setTodayInput(t);
    setUsageDate(t);
  };
  useEffect(() => {
    const t = localTodayInput();
    setTodayInput(t); // eslint-disable-line react-hooks/set-state-in-effect -- local-date seed (avoids SSR/first-paint TZ mismatch)
    setUsageDate(t);
  }, []);
  const [showUsageHistory, setShowUsageHistory] = useState(false);
  // Provenance edits. ISO-string fields are sliced to YYYY-MM-DD for the
  // native <input type="date">; null/undefined collapse to "". These keep
  // their local state across re-renders (initialized once, only updated by
  // their own onChange — there is NO reseed-from-props), so a sibling-spool
  // update doesn't reset half-typed text. That's the opposite of the label
  // field, which DOES reseed from the prop on edit-open; the disabled check
  // below compares the draft against fresh props so a saved value naturally
  // disables the button.
  const isoToDateInput = (v?: string | null) =>
    v ? new Date(v).toISOString().slice(0, 10) : "";
  const [lotInput, setLotInput] = useState(spool.lotNumber ?? "");
  const [purchaseInput, setPurchaseInput] = useState(isoToDateInput(spool.purchaseDate));
  const [openedInput, setOpenedInput] = useState(isoToDateInput(spool.openedDate));
  const [savingMeta, setSavingMeta] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const remaining = computeRemaining(filament, spool.totalWeight);

  // The spool's current AMS slot, derived from the printers list (the
  // reverse of Printer.amsSlots[].spoolId).
  const currentSlot = (() => {
    for (const p of printers) {
      for (const s of p.amsSlots ?? []) {
        if (s.spoolId && String(s.spoolId) === String(spool._id)) {
          return { printerName: p.name, slotName: s.slotName };
        }
      }
    }
    return null;
  })();
  const slotOptions = printers.flatMap((p) =>
    (p.amsSlots ?? []).map((s) => ({
      value: `${p._id}|${s._id}`,
      label: `${p.name} · ${s.slotName}`,
    })),
  );

  const handleSave = async () => {
    const val = parseFloat(weightInput);
    if (isNaN(val) || val < 0) return;
    setSaving(true);
    await onUpdateWeight(val);
    setWeightInput("");
    setSaving(false);
  };

  // The weight field is the GROSS on-scale weight (spool + filament), so a
  // value below the empty-spool weight clamps Remaining to 0. Surface a
  // warning so an obvious typo isn't silently swallowed.
  const enteredWeight = parseFloat(weightInput);
  const belowTare =
    !isNaN(enteredWeight) &&
    filament.spoolWeight != null &&
    enteredWeight < filament.spoolWeight;

  const handleLabelSave = () => {
    if (labelInput !== spool.label) {
      onUpdateLabel(labelInput);
    }
    setEditingLabel(false);
  };

  // Commit an edited spool id. Submit only on a real change; the server
  // validates charset/length (400) + uniqueness (409) and the parent
  // surfaces those as toasts. Blank reverts (use Regenerate to mint a new one).
  const handleIdSave = () => {
    const next = idInput.trim();
    setEditingId(false);
    if (next && next !== (spool.instanceId ?? "")) {
      onUpdateInstanceId(next);
    }
  };

  return (
    <div
      id={`spool-${String(spool._id)}`}
      className={`border rounded-lg p-3 transition-shadow scroll-mt-20 ${
        highlight
          ? "border-blue-500 ring-2 ring-blue-400 dark:ring-blue-500"
          : "border-gray-200 dark:border-gray-700"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {editingLabel ? (
            <input
              type="text"
              className="px-2 py-0.5 border border-gray-300 rounded text-sm bg-transparent w-40"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              onBlur={handleLabelSave}
              onKeyDown={(e) => { if (e.key === "Enter") handleLabelSave(); if (e.key === "Escape") { setLabelInput(spool.label); setEditingLabel(false); } }}
              autoFocus
              placeholder={t("detail.spool.labelPlaceholder")}
              aria-label={t("detail.spool.labelPlaceholder")}
            />
          ) : (
            <button
              // GH #263: re-seed labelInput from the current prop when the
              // editor opens. `labelInput` is useState-initialised only once;
              // after any sibling spool mutation the parent re-renders this
              // card with a fresh `spool` prop WITHOUT remounting — leaving
              // `labelInput` stale.
              onClick={() => { setLabelInput(spool.label); setEditingLabel(true); }}
              className="text-sm font-medium hover:text-blue-600 transition-colors"
              title={t("detail.spool.clickToRename")}
            >
              {spool.label || t("detail.spool.unnamed")}
            </button>
          )}
          {/* The durable per-spool id, always visible and editable. Changing
              it won't rewrite already-printed labels/tags. */}
          {editingId ? (
            <input
              type="text"
              className="px-2 py-0.5 border border-gray-300 rounded text-xs font-mono bg-transparent w-44"
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onBlur={handleIdSave}
              onKeyDown={(e) => { if (e.key === "Enter") handleIdSave(); if (e.key === "Escape") { setIdInput(spool.instanceId ?? ""); setEditingId(false); } }}
              autoFocus
              maxLength={128}
              placeholder={t("detail.spool.instanceIdPlaceholder")}
              aria-label={t("detail.spool.instanceId")}
              title={t("detail.spool.instanceIdOrphanHint")}
            />
          ) : (
            <span className="inline-flex items-center gap-1">
              <button
                onClick={() => { setIdInput(spool.instanceId ?? ""); setEditingId(true); }}
                className="inline-block max-w-[11rem] truncate align-bottom text-[11px] text-gray-400 dark:text-gray-500 font-mono hover:text-blue-600 transition-colors"
                title={t("detail.spool.editInstanceId")}
              >
                {spool.instanceId || t("detail.spool.setInstanceId")}
              </button>
              <button
                onClick={onRegenerateInstanceId}
                className="text-gray-300 dark:text-gray-600 hover:text-blue-600 transition-colors"
                title={t("detail.spool.regenerateId")}
                aria-label={t("detail.spool.regenerateId")}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </span>
          )}
        </div>
        <button
          onClick={onRemove}
          className="text-gray-400 hover:text-red-500 transition-colors"
          title={t("detail.spool.remove")}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      {remaining?.pct != null && (
        <div className="mb-2">
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                remaining.pct > 25 ? "bg-green-500" : remaining.pct > 10 ? "bg-yellow-500" : "bg-red-500"
              }`}
              style={{ width: `${remaining.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex items-center gap-4 text-sm text-gray-500 mb-2">
        {remaining && (
          <span>{formatGrams(remaining.remainingWeight)}g {t("detail.spool.remaining")}{remaining.pct != null ? ` (${remaining.pct}%)` : ""}</span>
        )}
        {remaining?.lengthMeters != null && (
          <span>{formatNumber(remaining.lengthMeters, { minDecimals: 1, maxDecimals: 1, trimTrailingZeros: false })}m {t("detail.spool.left")}</span>
        )}
        {!remaining && spool.totalWeight != null && (
          <span>{formatGrams(spool.totalWeight)}g {t("detail.spool.onScale")}</span>
        )}
      </div>

      {/* Inline weight update */}
      {filament.spoolWeight != null && (
        <>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="number"
            step="1"
            min="0"
            className="w-28 px-2 py-1 border border-gray-300 rounded text-sm bg-transparent"
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder={spool.totalWeight != null ? `${spool.totalWeight}g` : t("detail.spool.weightPlaceholder")}
            aria-label={t("detail.spool.scaleWeightAriaLabel", {
              label: spool.label || t("detail.spool.unnamed"),
            })}
          />
          <button
            onClick={handleSave}
            disabled={saving || !weightInput}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "..." : t("common.save")}
          </button>
          {nfcAvailable && onNfcWeightUpdate && (
            <button
              onClick={() => {
                const val = parseFloat(weightInput);
                if (!isNaN(val) && val > 0) {
                  onNfcWeightUpdate(val);
                } else if (spool.totalWeight != null) {
                  onNfcWeightUpdate(spool.totalWeight);
                }
              }}
              disabled={nfcWriting}
              className="px-3 py-1 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 disabled:opacity-50"
              title={t("detail.nfc.updateWeightTitle")}
            >
              {nfcWriting ? "..." : t("detail.nfc.updateNfc")}
            </button>
          )}
        </div>
        {belowTare && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {t("detail.spool.belowTareWarning", {
              weight: enteredWeight,
              tare: filament.spoolWeight,
            })}
          </p>
        )}
        </>
      )}

      {/* Location picker + retire + more toggle */}
      <div className="mt-3 flex items-center gap-2 text-xs">
        <label className="text-gray-500">{t("detail.spool.location")}:</label>
        <select
          className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          value={spool.locationId ?? ""}
          onChange={(e) => onUpdateLocation(e.target.value || null)}
        >
          <option value="">—</option>
          {locations.map((l) => (
            <option key={l._id} value={l._id}>
              {l.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onToggleRetire(!spool.retired)}
          className={`ml-auto px-2 py-0.5 rounded border transition-colors ${
            spool.retired
              ? "bg-amber-200 dark:bg-amber-900 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-700"
              : "border-gray-300 dark:border-gray-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
          title={spool.retired ? t("detail.spool.restoreTitle") : t("detail.spool.retireTitle")}
        >
          {spool.retired ? t("detail.spool.retired") : t("detail.spool.retire")}
        </button>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
        >
          {showMore ? t("detail.spool.less") : t("detail.spool.more")}
        </button>
      </div>

      {/* Printer slot — the spool's current loaded position, distinct
          from its Location (home). */}
      <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
        <label className="text-gray-500">{t("detail.spool.printerSlot")}:</label>
        {currentSlot ? (
          <>
            <span className="px-2 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200">
              {currentSlot.printerName} · {currentSlot.slotName}
            </span>
            <button
              type="button"
              onClick={() => onAssignSlot(null)}
              className="px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              {t("detail.spool.clearSlot")}
            </button>
          </>
        ) : slotOptions.length === 0 ? (
          <span className="text-gray-400">{t("detail.spool.noPrinterSlots")}</span>
        ) : (
          <select
            className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 disabled:opacity-50"
            value=""
            disabled={spool.retired}
            title={spool.retired ? t("detail.spool.retiredCannotAssign") : undefined}
            onChange={(e) => {
              const [printerId, slotId] = e.target.value.split("|");
              if (printerId && slotId) onAssignSlot({ printerId, slotId });
            }}
          >
            <option value="">{t("detail.spool.assignSlot")}</option>
            {slotOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-[11px] text-gray-400">{t("detail.spool.printerSlotHint")}</p>

      {showMore && (
        <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-3 text-sm">
          {/* Photo */}
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("detail.spool.photo")}</p>
            <div className="flex items-start gap-3">
              {spool.photoDataUrl ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={spool.photoDataUrl}
                    alt={t("detail.spool.photoAlt")}
                    className="w-24 h-24 object-cover rounded border border-gray-300 dark:border-gray-700"
                  />
                  <button
                    type="button"
                    onClick={() => onUpdatePhoto(null)}
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-600 text-white text-xs leading-none hover:bg-red-700"
                    aria-label={t("detail.spool.removePhoto")}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const { compressImageToDataUrl } = await import("@/lib/compressImage");
                  const dataUrl = await compressImageToDataUrl(file);
                  if (dataUrl) onUpdatePhoto(dataUrl);
                  if (photoInputRef.current) photoInputRef.current.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400"
              >
                {spool.photoDataUrl ? t("detail.spool.replacePhoto") : t("detail.spool.uploadPhoto")}
              </button>
            </div>
          </div>

          {/* Provenance — purchase + opened dates + lot/batch */}
          <div>
            <p className="text-xs text-gray-500 mb-1">{t("detail.spool.provenance")}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <label className="flex flex-col gap-0.5">
                <span className="text-xs text-gray-400">{t("detail.spool.lotNumber")}</span>
                <input
                  type="text"
                  value={lotInput}
                  onChange={(e) => setLotInput(e.target.value)}
                  placeholder={t("detail.spool.lotNumberPlaceholder")}
                  aria-label={t("detail.spool.lotNumber")}
                  className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-xs text-gray-400">{t("detail.spool.purchaseDate")}</span>
                <input
                  type="date"
                  value={purchaseInput}
                  onChange={(e) => setPurchaseInput(e.target.value)}
                  aria-label={t("detail.spool.purchaseDate")}
                  className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-xs text-gray-400">{t("detail.spool.openedDate")}</span>
                <input
                  type="date"
                  value={openedInput}
                  onChange={(e) => setOpenedInput(e.target.value)}
                  aria-label={t("detail.spool.openedDate")}
                  className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                />
              </label>
            </div>
            <div className="flex items-center justify-end mt-2">
              <button
                type="button"
                // Only send fields that actually differ from the current
                // server values — a partial patch is what the PUT handler
                // expects, so an untouched openedDate shouldn't be wiped
                // just because the user only edited the lot number.
                disabled={
                  savingMeta ||
                  (lotInput === (spool.lotNumber ?? "") &&
                   purchaseInput === isoToDateInput(spool.purchaseDate) &&
                   openedInput === isoToDateInput(spool.openedDate))
                }
                onClick={async () => {
                  const patch: { lotNumber?: string | null; purchaseDate?: string | null; openedDate?: string | null } = {};
                  const lotTrimmed = lotInput.trim();
                  const currentLot = spool.lotNumber ?? "";
                  if (lotTrimmed !== currentLot) {
                    patch.lotNumber = lotTrimmed === "" ? null : lotTrimmed;
                  }
                  const currentPurchase = isoToDateInput(spool.purchaseDate);
                  if (purchaseInput !== currentPurchase) {
                    patch.purchaseDate = purchaseInput === "" ? null : purchaseInput;
                  }
                  const currentOpened = isoToDateInput(spool.openedDate);
                  if (openedInput !== currentOpened) {
                    patch.openedDate = openedInput === "" ? null : openedInput;
                  }
                  if (Object.keys(patch).length === 0) return;
                  setSavingMeta(true);
                  try {
                    await onUpdateMeta(patch);
                  } finally {
                    setSavingMeta(false);
                  }
                }}
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:text-gray-200 disabled:cursor-not-allowed disabled:hover:bg-gray-400"
              >
                {t("detail.spool.saveProvenance")}
              </button>
            </div>
          </div>

          {/* Log dry cycle */}
          <div>
            <p className="text-xs text-gray-500 mb-1">
              {t("detail.spool.dryCycles", { count: spool.dryCycles?.length ?? 0 })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                placeholder={t("detail.spool.dryTemp")}
                aria-label={t("detail.spool.dryTemp")}
                value={dryTemp}
                onChange={(e) => setDryTemp(e.target.value)}
              />
              <input
                type="number"
                min="0"
                step="1"
                className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                placeholder={t("detail.spool.dryDuration")}
                aria-label={t("detail.spool.dryDuration")}
                value={dryDuration}
                onChange={(e) => setDryDuration(e.target.value)}
              />
              <button
                type="button"
                // Require at least one of (temp, duration) — empty cycles
                // are accidental clicks; the dashboard's "needs drying"
                // list keys off the timestamp, not the metric values, so
                // a blank cycle would still mark the spool as recently
                // dried and silently mask a real overdue.
                disabled={!dryTemp && !dryDuration}
                onClick={() => {
                  onLogDryCycle({
                    tempC: dryTemp ? Number(dryTemp) : null,
                    durationMin: dryDuration ? Number(dryDuration) : null,
                  });
                  setDryTemp("");
                  setDryDuration("");
                }}
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:text-gray-200 disabled:cursor-not-allowed disabled:hover:bg-gray-400"
              >
                {t("detail.spool.logDry")}
              </button>
            </div>
            {spool.dryCycles && spool.dryCycles.length > 0 && (() => {
              // GH #1119: pick the LATEST date, not the last array entry —
              // the mobile app, the API and a snapshot restore can all
              // introduce a back-dated cycle, and /inventory, the dashboard
              // and exportSpools all scan for the max.
              let latest: Date | null = null;
              for (const c of spool.dryCycles) {
                const d = new Date(c.date);
                if (Number.isNaN(d.getTime())) continue;
                if (!latest || d > latest) latest = d;
              }
              if (!latest) return null;
              return (
                <p className="text-xs text-gray-400 mt-1">
                  {t("detail.spool.lastDried", { date: formatDate(latest) })}
                </p>
              );
            })()}
          </div>

          {/* Log usage */}
          <div>
            {(spool.usageHistory?.length ?? 0) > 0 ? (
              <button
                type="button"
                onClick={() => setShowUsageHistory((s) => !s)}
                aria-expanded={showUsageHistory}
                // GH #1069: styled as a link so it reads as a disclosure —
                // the one place manual usage entries can be reviewed.
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline mb-1 flex items-center gap-1"
              >
                <span aria-hidden="true">{showUsageHistory ? "▾" : "▸"}</span>
                {t("detail.spool.usageHistory", { count: spool.usageHistory?.length ?? 0 })}
              </button>
            ) : (
              <p className="text-xs text-gray-500 mb-1">
                {t("detail.spool.usageHistory", { count: 0 })}
              </p>
            )}
            {showUsageHistory && (spool.usageHistory?.length ?? 0) > 0 && (
              <ul className="mb-2 space-y-1 max-h-48 overflow-y-auto pr-1">
                {[...(spool.usageHistory ?? [])]
                  .sort(
                    (a, b) =>
                      new Date(b.date).getTime() - new Date(a.date).getTime(),
                  )
                  .map((u, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-gray-800 pb-1 last:border-0"
                    >
                      <span className="text-gray-400 dark:text-gray-500 w-20 shrink-0">
                        {/* Date-only entries (stored UTC midnight) format in
                            UTC so the picked day shows for every time zone
                            and matches the UTC-bucketed Analytics chart. Real
                            timestamps format in LOCAL time so a print logged
                            at 8 PM doesn't read as tomorrow west of UTC (#941). */}
                        {formatDate(
                          u.date,
                          isUtcMidnight(u.date) ? { timeZone: "UTC" } : undefined,
                        )}
                      </span>
                      <span className="font-medium w-14 shrink-0 text-right">
                        {formatGrams(u.grams)}g
                      </span>
                      <span className="flex-1 min-w-0 truncate">
                        {u.jobLabel || t("detail.spool.usageNoLabel")}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 shrink-0">
                        {t(`detail.spool.usageSource.${u.source}`)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min="0"
                step="1"
                className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                placeholder={t("detail.spool.usageGrams")}
                aria-label={t("detail.spool.usageGrams")}
                value={usageGrams}
                onChange={(e) => setUsageGrams(e.target.value)}
              />
              {/* When the usage actually happened (defaults to today).
                  Capped at today — usage can't be logged in the future. */}
              <input
                type="date"
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                aria-label={t("detail.spool.usageDate")}
                title={t("detail.spool.usageDate")}
                max={todayInput}
                value={usageDate}
                // Refresh the default + max to the CURRENT day when the user
                // opens the picker, so a page left open across midnight
                // doesn't offer a stale "yesterday" default/max.
                onFocus={refreshDefaultDate}
                onChange={(e) => {
                  setUsageDate(e.target.value);
                  setUsageDateDirty(true);
                }}
              />
              <input
                type="text"
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                placeholder={t("detail.spool.usageJobLabel")}
                aria-label={t("detail.spool.usageJobLabel")}
                value={usageLabel}
                onChange={(e) => setUsageLabel(e.target.value)}
              />
              <button
                type="button"
                // Disable until grams is a positive number. Also disable on a
                // future date: the picker's `max` blocks selection but not
                // typed/pasted input, and a future-dated log would decrement
                // the spool yet be hidden from Analytics until that day
                // (#936). The onClick clamps too, as defense.
                disabled={
                  !(Number(usageGrams) > 0) ||
                  (!!usageDate && !!todayInput && usageDate > todayInput)
                }
                onClick={() => {
                  const g = Number(usageGrams);
                  if (!Number.isFinite(g) || g <= 0) return;
                  // Two storage shapes, one per case (#941):
                  // - BACKDATE: send the bare YYYY-MM-DD → stored as UTC
                  //   midnight of that day. The history list renders
                  //   date-only values in UTC and Analytics buckets in UTC,
                  //   so the picked day shows identically for every time
                  //   zone, and a past day's UTC midnight is never in the
                  //   future.
                  // - TODAY or FUTURE (the default / clamp): omit `date` so
                  //   the server stamps the actual instant. Sending today's
                  //   YYYY-MM-DD instead would store a UTC midnight that,
                  //   east of UTC, hasn't happened yet — Analytics excludes
                  //   future entries (#936), so a just-logged entry would
                  //   vanish from totals until UTC catches up. Only a
                  //   STRICTLY-PAST date is sent as a backdate; a typed/
                  //   pasted future date is clamped to "now". Only an EDITED
                  //   field (`usageDateDirty`) is ever a backdate — an
                  //   untouched default is always "now", even if it's gone
                  //   stale across a midnight rollover.
                  const today = localTodayInput();
                  onLogUsage({
                    grams: g,
                    jobLabel: usageLabel,
                    date:
                      usageDateDirty && usageDate && usageDate < today
                        ? usageDate
                        : undefined,
                  });
                  setUsageGrams("");
                  setUsageLabel("");
                  setUsageDate(today);
                  setTodayInput(today);
                  setUsageDateDirty(false);
                }}
                className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700 disabled:text-gray-200 disabled:cursor-not-allowed disabled:hover:bg-gray-400"
              >
                {t("detail.spool.logUsage")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact "inherited" marker for inline labels where a full InfoCard
 *  badge doesn't fit. Mirrors the blue treatment inherited InfoCards use. */
function InheritedMark() {
  const { t } = useTranslation();
  return (
    <sup
      className="ml-0.5 text-[0.65rem] font-medium text-blue-500 dark:text-blue-400"
      title={t("detail.inheritedTitle")}
    >
      {t("detail.inherited")}
    </sup>
  );
}

function InfoCard({ label, value, inherited = false }: { label: string; value: string; inherited?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`rounded p-3 ${inherited ? "bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800" : "bg-gray-50 dark:bg-gray-900"}`}>
      <p className="text-xs text-gray-500 mb-1">
        {label}
        {inherited && (
          <span className="ml-1 text-blue-500" title={t("detail.inheritedTitle")}>
            ({t("detail.inherited")})
          </span>
        )}
      </p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
