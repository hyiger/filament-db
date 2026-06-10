"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useNfcContext } from "@/components/NfcProvider";
import { generateOpenPrintTagBinary } from "@/lib/openprinttag";
import { safeHttpUrl } from "@/lib/safeRenderUrl";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useCurrency } from "@/hooks/useCurrency";
import PrusamentImportDialog from "@/components/PrusamentImportDialog";
import PrintLabelDialog from "@/components/PrintLabelDialog";
import OptResyncDialog from "@/components/OptResyncDialog";
import CopyButton from "@/components/CopyButton";
import FilamentSwatch from "@/components/FilamentSwatch";
import FinishChip from "@/components/FinishChip";
import { deriveFinish } from "@/lib/filamentFinish";
import { deriveArrangement } from "@/lib/filamentColors";
import type { FilamentDetail, FilamentCalibration } from "@/types/filament";
import { useTranslation } from "@/i18n/TranslationProvider";
import { formatDate } from "@/lib/dateFormat";

type Filament = FilamentDetail;

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
 * triggers a params change without an unmount, so all the inner
 * component's state would otherwise leak into the next filament
 * (typed Add-Spool form, stale 404, NFC-write banner, etc.). Wrap
 * the inner component with `key={params.id}` so React unmounts and
 * remounts it on every id change — the whole state graph resets
 * naturally without any per-field reset boilerplate inside the
 * fetch effect.
 */
export default function FilamentDetailPage() {
  const params = useParams();
  const keyId = Array.isArray(params.id) ? params.id[0] : params.id ?? "";
  return <FilamentDetail key={String(keyId)} />;
}

function FilamentDetail() {
  const { t } = useTranslation();
  const { format: formatCurrency } = useCurrency();
  const params = useParams();
  const router = useRouter();
  const [filament, setFilament] = useState<Filament | null>(null);
  const [showAllSettings, setShowAllSettings] = useState(false);
  // GH #607: "Check for OpenPrintTag updates" dialog.
  const [resyncOpen, setResyncOpen] = useState(false);
  /**
   * Both `previewOpenFor` and `embedCheck` are keyed to the tdsUrl they
   * apply to. Navigating between filaments (same route, different params)
   * keeps the component mounted and therefore preserves state — keying on
   * tdsUrl means the *derived* `showTdsPreview` and `tdsEmbedState` below
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
   *  parent name. Stamped with the inheritsName the lookup was for so a
   *  filament-prop change can't expose a stale (wrong) target id while the
   *  next fetch is still in flight — same pattern as embedCheck above. */
  const [inheritsLookup, setInheritsLookup] = useState<
    { inheritsName: string; targetId: string | null } | null
  >(null);
  const inheritsTargetId =
    filament?.inherits && inheritsLookup?.inheritsName === filament.inherits
      ? inheritsLookup.targetId
      : null;
  /**
   * AbortController for the in-flight embed-check fetch. Lets a new toggle
   * (e.g. user navigates A→B and opens B's preview before A's probe has
   * resolved) cancel the previous request and ignore its eventual reply,
   * so a late-arriving response can't overwrite a newer in-flight or
   * already-resolved verdict.
   */
  const embedCheckAbortRef = useRef<AbortController | null>(null);
  /** Inline "+ Add Spool" form state — used for both the regular and the
   * first-spool entry points. Was previously a one-click create with no
   * confirmation; users would land on a blank spool with no idea what
   * had just happened. */
  const [addSpoolForm, setAddSpoolForm] = useState<
    { open: boolean; label: string; totalWeight: string }
  >({ open: false, label: "", totalWeight: "" });
  // GH #440: double-submit guard for the Add Spool Create button.
  // Pre-fix both inline Add Spool buttons `await`-ed handleAddSpool
  // without disabling, so a second click during the POST created a
  // duplicate spool. Lifts to component-level state because BOTH
  // create buttons (the regular flow and the empty-state fallback)
  // need to share the same in-flight flag.
  const [addSpoolSubmitting, setAddSpoolSubmitting] = useState(false);
  const { isElectron, status: nfcStatus, writing: nfcWriting, writeTag, notifyTagWritten } = useNfcContext();
  const [nfcWriteSuccess, setNfcWriteSuccess] = useState<boolean | null>(null);
  const nfcWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  const [notFound, setNotFound] = useState(false);

  // Legacy single-spool inline weight update
  const [weightInput, setWeightInput] = useState("");
  const [weightSaving, setWeightSaving] = useState(false);
  const weightRef = useRef<HTMLInputElement>(null);

  // GH #405 follow-up (Codex on PR #460): store the error TYPE rather
  // than the translated string. With `t` removed from the fetch
  // effect's dep array (intentional — see the comment there),
  // capturing the translated string at fetch time would freeze the
  // message in whichever locale was active when the request failed.
  // Render-time translation via the JSX path picks up the current
  // locale on every re-render.
  type FetchErrorKey = "loadFailed" | "connectionFailed" | null;
  const [fetchError, setFetchError] = useState<FetchErrorKey>(null);
  const [showPrusamentImport, setShowPrusamentImport] = useState(false);
  const [locations, setLocations] = useState<{ _id: string; name: string; kind: string }[]>([]);
  const [printers, setPrinters] = useState<PrinterLite[]>([]);

  // Three action-menu dropdowns (Export / Sync / Variants). Each one is
  // a native <details> with a custom <summary> trigger; refs let us close
  // them after a click and on an outside click — a bare <details>
  // doesn't collapse on outside click on its own.
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const syncMenuRef = useRef<HTMLDetailsElement>(null);
  const variantsMenuRef = useRef<HTMLDetailsElement>(null);

  // PrintLabelDialog open state. Controlled here so the dialog mounts
  // alongside the rest of the filament detail tree and can read the
  // resolved filament directly.
  const [printLabelOpen, setPrintLabelOpen] = useState(false);

  // GH #595: when arrived via a spool deep-link QR (`?spool=<id>`), scroll to
  // and briefly highlight that spool. Read from window.location (not
  // useSearchParams) to avoid forcing a Suspense boundary on this page; the
  // highlight is a progressive enhancement that only runs client-side.
  const [highlightSpoolId, setHighlightSpoolId] = useState<string | null>(null);
  const deepLinkHandledRef = useRef(false);

  // "Sync from Bambu Studio" file input + in-flight flag. Pinned to this
  // filament's id (POST /api/filaments/{id}/bambustudio) so the user is
  // updating exactly the record they're looking at, regardless of the
  // file's filament_settings_id.
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
        // Re-fetch so the page reflects the new values.
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

  // Clear NFC write timeout on unmount
  useEffect(() => {
    return () => { if (nfcWriteTimerRef.current) clearTimeout(nfcWriteTimerRef.current); };
  }, []);

  // Collapse any open action-menu dropdown when the user clicks elsewhere.
  // Single listener covers all three menus so they also auto-close each
  // other on outside-click (clicking on a different menu's summary closes
  // any other that's already open).
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
    // GH #405: fetch the filament without `t` in the dep array. The
    // payload is locale-independent and re-fetching on every
    // `setLocale` was wasted bandwidth plus a flicker. Errors are
    // stored as TYPE KEYS (`loadFailed` / `connectionFailed`) and
    // resolved through `t(...)` at render time, so a locale switch
    // mid-error retranslates without any new round-trip.
    //
    // Same-route navigation (`/filaments/A` → `/filaments/B`) state-
    // reset is handled by the `key={params.id}` on the wrapper below
    // (GH #402) — React unmounts/remounts the inner component on id
    // change, so the entire local state graph resets without any
    // per-field clearing here.
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

  // GH #607: re-pull the filament after an OpenPrintTag re-sync applied
  // changes, so the detail view reflects the adopted values. GH #640:
  // never throws — a failed refresh keeps the current data rather than
  // surfacing an unhandled rejection from fire-and-forget callers.
  const refetchFilament = useCallback(async () => {
    try {
      const r = await fetch(`/api/filaments/${params.id}`);
      if (r.ok) setFilament(await r.json());
    } catch {
      // keep the current (stale) filament
    }
  }, [params.id]);

  // GH #595: spool deep-link — once the filament (with its spools) has loaded,
  // if `?spool=<id>` is in the URL and matches a spool, scroll to it and
  // highlight it briefly. The ref makes this fire once (not on every later
  // spool edit that re-sets `filament`).
  useEffect(() => {
    if (deepLinkHandledRef.current || !filament || typeof window === "undefined") return;
    deepLinkHandledRef.current = true;
    const spoolId = new URLSearchParams(window.location.search).get("spool");
    if (!spoolId || !filament.spools?.some((s) => String(s._id) === spoolId)) return;
    // Wait a frame so the SpoolCard element is in the DOM, then scroll/flag.
    const raf = requestAnimationFrame(() => {
      document.getElementById(`spool-${spoolId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightSpoolId(spoolId);
    });
    const clear = setTimeout(() => setHighlightSpoolId(null), 2600);
    return () => { cancelAnimationFrame(raf); clearTimeout(clear); };
  }, [filament]);

  // Load locations once so the spool cards can show a picker without each
  // spool re-fetching. Small list — OK to keep in state.
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/locations", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Load printers once so each spool card can show its AMS-slot picker.
  // The response carries every amsSlots[].spoolId, so a spool's current
  // slot is derived client-side — no per-spool round trip (GH #242).
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/printers", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then(setPrinters)
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // If this filament has an `inherits` PrusaSlicer-style parent name, look up
  // whether any filament in the DB matches it exactly. The result is stored
  // stamped with the inheritsName it was for, and the derived
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
  // Plain function (no useCallback) so React Compiler can memoize it
  // — the manual deps would have to spell out `filament` to match the
  // compiler's inference, which leaks more than we read.
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
    // toggle (different filament, different tdsUrl) can't overwrite this
    // one's verdict and snap the open preview back to "idle".
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
  // Bambu (read-only) tag is refused consistently — Codex P2 on PR #584.
  //  • Bambu Lab tag → read-only, refuse with a friendly toast (writing would
  //    otherwise fail with a raw MIFARE error)
  //  • non-blank tag + confirmOverwrite → confirm before clobbering existing data
  //  • genuinely blank/unformatted tag (read throws a known blank signal) →
  //    allow, write straight through
  //  • unknown read error (transient PC/SC, decode failure on a non-blank tag)
  //    → fail CLOSED: don't silently overwrite a tag we couldn't read
  //    (Codex P2 on PR #584). Mirrors the blank-tag signals raised in
  //    electron/ndef.ts + the auto-read classifier in electron/main.ts.
  // Returns true if the caller should proceed with the write.
  const ensureTagWritable = useCallback(
    async ({ confirmOverwrite = false }: { confirmOverwrite?: boolean } = {}): Promise<boolean> => {
      type ProbedTag = { tagSource?: string; materialName?: string; brandName?: string; spoolUid?: string; readOnly?: boolean };
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
        // OpenPrintTag, so it must NOT fail open (Codex P2 round 4 on PR #584).
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

      // Bambu Lab tags are read-only — refuse on every write path.
      if (existing?.tagSource === "bambu") {
        toast(t("detail.nfc.bambuReadOnly"), "error");
        return false;
      }

      // GH #583: honor a soft read-only OpenPrintTag — refuse the write and
      // point the user at Erase / Make Writable. (Bambu is handled above with
      // its own message since it can't be made writable.)
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
        const tagInstance = norm(existing?.spoolUid);
        const sameInstance = tagInstance !== "" && tagInstance === norm(filament?.instanceId);
        const sameNameVendor =
          norm(existing?.materialName) !== "" &&
          norm(existing?.materialName) === norm(filament?.name) &&
          norm(existing?.brandName) === norm(filament?.vendor);
        const isOwnTag = !foreignNdef && !!existing && (sameInstance || sameNameVendor);

        // Weight-update path silently re-writes THIS filament's own tag (the
        // common case). Any OTHER tag must not be clobbered silently (Codex P2
        // round 5 on PR #584): a foreign NDEF tag fails closed; a different
        // filament's OpenPrintTag falls through to the confirm below.
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

  const handleNfcWrite = async () => {
    if (!filament) return;

    // Explicit Write button → confirm before overwriting a tag that holds data.
    if (!(await ensureTagWritable({ confirmOverwrite: true }))) return;

    setNfcWriteSuccess(null);
    try {
      // Compute actual remaining weight from the most recent scale reading
      let actualWeightGrams: number | null = null;
      if (filament.totalWeight != null && filament.spoolWeight != null) {
        actualWeightGrams = Math.max(0, filament.totalWeight - filament.spoolWeight);
      }
      const payload = generateOpenPrintTagBinary({
        materialName: filament.name,
        brandName: filament.vendor,
        materialType: filament.type,
        // GH #477: nullable color → omit key 19 from CBOR.
        color: filament.color ?? undefined,
        // GH #477 Phase 3: surface secondaryColors on the tag too.
        // The encoder caps at 5 to match the spec (keys 20–24).
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
        spoolUid: filament.instanceId ?? null,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        abrasive: filament.settings?.filament_abrasive === "1",
        soluble: filament.settings?.filament_soluble === "1",
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
      });
      // Include a URI record for Prusa app compatibility
      const productUrl = filament.tdsUrl
        || `https://filamentdb.app/filament/${encodeURIComponent(filament.vendor)}/${encodeURIComponent(filament.name)}`;
      await writeTag(payload, productUrl);
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

  const handleNfcWeightUpdate = useCallback(async (scaleWeight: number) => {
    if (!filament || filament.spoolWeight == null) return;
    // Bambu (read-only) tags can't be written — refuse with the friendly
    // message here too (no overwrite confirm: a weight update is a deliberate
    // re-write of this filament's own tag). Codex P2 on PR #584.
    if (!(await ensureTagWritable())) return;
    const actualRemaining = Math.max(0, scaleWeight - filament.spoolWeight);
    setNfcWriteSuccess(null);
    try {
      const payload = generateOpenPrintTagBinary({
        materialName: filament.name,
        brandName: filament.vendor,
        materialType: filament.type,
        // GH #477: nullable color → omit key 19 from CBOR.
        color: filament.color ?? undefined,
        // GH #477 Phase 3: surface secondaryColors on the tag too.
        // The encoder caps at 5 to match the spec (keys 20–24).
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
        actualWeightGrams: actualRemaining,
        emptySpoolWeight: filament.spoolWeight ?? null,
        spoolUid: filament.instanceId ?? null,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        abrasive: filament.settings?.filament_abrasive === "1",
        soluble: filament.settings?.filament_soluble === "1",
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
      });
      const productUrl = filament.tdsUrl
        || `https://filamentdb.app/filament/${encodeURIComponent(filament.vendor)}/${encodeURIComponent(filament.name)}`;
      await writeTag(payload, productUrl);
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
  }, [filament, writeTag, notifyTagWritten, toast, t, ensureTagWritable]);

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

  const handleAddSpool = async (label = "", totalWeight: number | null = null) => {
    if (!filament) return;
    try {
      const res = await fetch(`/api/filaments/${filament._id}/spools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, totalWeight }),
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
        toast(t("detail.spool.added"));
      } else {
        toast(t("detail.spool.addFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.addFailed"), "error");
    }
  };

  // Re-pull printers so every spool card's *derived* AMS-slot assignment
  // (read off amsSlots[].spoolId, not stored on the spool) reflects the
  // latest server state. Used after any write that the server may have
  // reconciled slots for — slot assign/clear and spool retire (#558).
  // GH #640: never throws — the write that triggered the refresh already
  // succeeded, so a failed refresh keeps the (possibly stale) printers
  // list rather than letting the callers' catch blocks mis-report the
  // whole operation as failed. Same silent posture as the mount fetch.
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
      // GH #601: provenance fields. The PUT handler (and the validator
      // in src/lib/validateSpoolBody.ts) already accepts these — the type
      // here just needs to surface them so the SpoolCard's
      // onUpdateMeta callback can route through this single helper.
      lotNumber?: string | null;
      purchaseDate?: string | null;
      openedDate?: string | null;
    },
  ) => {
    if (!filament) return;

    // When the user zeroes the remaining weight on a non-retired spool,
    // offer to retire it in the same write — that's the canonical "I
    // finished this spool" moment, and retiring preserves the spool's
    // history (purchase / opened dates, dry cycles, usage log) while
    // excluding it from inventory totals (see inventoryStats.ts gates on
    // `retired`). Skipped when:
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
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
        // #558: retiring a loaded spool clears it from its printer AMS slot
        // server-side (the PUT handler calls assignSpoolToSlot(..., null)).
        // The card's slot text is derived from `printers`, so refresh it or
        // the stale "Printer slot: <printer> · <slot>" lingers until reload.
        if (data.retired === true) {
          await refreshPrinters();
        }
        toast(t("detail.spool.updated"));
      } else {
        toast(t("detail.spool.updateFailed"), "error");
      }
    } catch {
      toast(t("detail.spool.updateFailed"), "error");
    }
  };

  // GH #242 — assign or clear a spool's printer AMS slot. Writes only
  // Printer documents (never the spool's locationId), then re-fetches
  // printers so every card's derived assignment stays consistent — moving
  // a spool into a slot must visibly clear it from its previous slot.
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
        `/api/filaments/${filament._id}/spools/${spoolId}/dry-cycles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
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
    entry: { grams: number; jobLabel?: string },
  ) => {
    if (!filament) return;
    try {
      const res = await fetch(
        `/api/filaments/${filament._id}/spools/${spoolId}/usage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
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
      const res = await fetch(`/api/filaments/${filament._id}/spools/${spoolId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const updated = await res.json();
        setFilament(prev => prev ? { ...prev, spools: updated.spools } : prev);
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
   * Soft-delete this filament — moves it to the trash, where the user
   * can either restore it or permanently purge it via `/trash`. Until
   * this PR there was no UI affordance to do this from the detail page;
   * variants in particular were hard to find since the inventory-list
   * bulk-delete required first expanding the parent to surface the
   * variant's checkbox. Now the action lives right next to Edit.
   *
   * Parents-with-live-variants are gated server-side (the API returns
   * 400 with a clear message). We don't pre-check that here — the
   * button is *enabled* even for parents so the user gets the API's
   * specific error if they try, which is more helpful than silently
   * disabling the button without saying why.
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
      // Create a spool from the legacy totalWeight
      const addRes = await fetch(`/api/filaments/${filament._id}/spools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "", totalWeight: filament.totalWeight }),
      });
      if (!addRes.ok) { toast(t("detail.spool.migrateFailed"), "error"); return; }
      // Clear the legacy totalWeight
      const clearRes = await fetch(`/api/filaments/${filament._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalWeight: null }),
      });
      if (clearRes.ok) {
        const added = await addRes.json();
        setFilament(prev => prev ? { ...prev, spools: added.spools, totalWeight: null } : prev);
        toast(t("detail.spool.migrated"));
      }
    } catch {
      toast(t("detail.spool.migrateFailed"), "error");
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
  // Parents are finish-agnostic — only variants/standalones carry a
  // texture treatment + chip. resolveFilament() doesn't inherit optTags,
  // so a variant only shows a finish when its own optTags include one
  // of the FINISH_TAG_IDS.
  const finish = !isParent ? deriveFinish(filament.optTags) : null;
  // GH #477: drive multi-color rendering from the filament's own optTags.
  // Parents render hatched regardless, so we compute this anyway for
  // consistency — `<FilamentSwatch isParent>` ignores `arrangement`.
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
          // get the same color info sighted users see (Codex P3 #600). It
          // still falls back to "Color group" when no colors are known.
          ariaLabel={isParent ? undefined : t("swatch.colorSwatch", { color: filament.color ?? "#808080" })}
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{filament.name}</h1>
          <p className="text-gray-500">
            {filament.vendor} &middot; {filament.type}
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
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {/* NFC status pill removed — the global one in AppHeader already
              shows reader/loaded state, no need to render a duplicate next
              to the Write NFC button. */}
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
              output, NFC tag binary, and slicer config files. The single
              dropdown replaces three separate buttons (Export OPT,
              Print Label, Export for slicer ▾) so the action row stays
              short as more output formats land. */}
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
              {/* Label printer — opens the PrintLabelDialog. On
                  Electron, the dialog sends the encoded byte stream
                  over IPC to the serial-port writer in
                  electron/label-printer.ts. On web (no Electron) it
                  falls back to downloading the .bin file so the
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
              {/* Slicer-format exports below the divider. Multi-color
                  warning still surfaces here (GH #477 Phase 4) — slicer
                  presets only carry one color, secondary colors are
                  dropped on export. */}
              <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
              <p className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {t("detail.exportMenu.slicerSection")}
              </p>
              {(filament.secondaryColors && filament.secondaryColors.length > 0) && (
                <p className="px-3 py-2 my-1 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-y border-amber-200 dark:border-amber-800">
                  {t("detail.slicerExport.multiColorNotice")}
                </p>
              )}
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
              external tools. Currently just Bambu Studio; PrusaSlicer
              and OrcaSlicer per-filament sync will live alongside when
              they land. Hidden file input stays out-of-flow next to the
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
          {/* Variants ▾ — actions that produce a NEW filament off this
              one. Duplicate is available on every filament (clone path
              at src/app/filaments/new/page.tsx:192 does `parentId || _id`,
              so cloning a variant produces a sibling). Create variant is
              gated on `!isVariant` because variants-of-variants aren't a
              thing in this design. */}
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
              variant (Codex P2 r4). Opens the check-for-updates dialog. */}
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
          <span>
            {t("detail.inheritsFromParent")}
            {inherited.size > 0 && (
              <span className="text-gray-500 ml-1">
                ({t("detail.inheritedFieldCount", { count: inherited.size })})
              </span>
            )}
          </span>
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
        <InfoCard label={t("detail.field.density")} value={filament.density ? `${filament.density.toFixed(2)} g/cm³` : "—"} inherited={inherited.has("density")} />
        <InfoCard label={t("detail.field.diameter")} value={filament.diameter != null ? `${filament.diameter.toFixed(2)} mm` : "—"} inherited={inherited.has("diameter")} />
        <InfoCard label={t("detail.field.maxVolSpeed")} value={filament.maxVolumetricSpeed ? `${filament.maxVolumetricSpeed} mm³/s` : "—"} inherited={inherited.has("maxVolumetricSpeed")} />
      </div>

      {/* Spool Tracker — always rendered. Pre-fix the outer gate hid the
          entire section (header + Add Spool button) when the filament had
          neither spools nor any spool-weight metadata, leaving users with
          no in-app affordance to add their first spool (e.g. a freshly-
          imported Siraya Tech PPS-CF row with the OpenPrintTag defaults).
          Empty state now surfaces an Add Spool CTA via the fallback at
          the bottom of this block, gated on hasSpools + totalWeight only.
          (Regression of #346 — that fix covered "no spools but weights
          set"; the "no spools AND no weights" case still fell through.) */}
      {(() => {
        const hasSpools = filament.spools?.length > 0;
        const legacyRemaining = !hasSpools ? computeRemaining(filament) : null;

        // Aggregate stats across all spools
        let aggregateRemaining = 0;
        let aggregateTotal = 0;
        let validSpoolCount = 0;
        if (hasSpools && filament.spoolWeight != null) {
          for (const spool of filament.spools) {
            if (spool.totalWeight != null) {
              aggregateRemaining += Math.max(0, spool.totalWeight - filament.spoolWeight);
              validSpoolCount++;
            }
          }
          aggregateTotal = (filament.netFilamentWeight ?? 0) * validSpoolCount;
        }
        const aggregatePct = aggregateTotal > 0 ? Math.min(100, Math.round((aggregateRemaining / aggregateTotal) * 100)) : null;

        return (
          <div className="mb-8 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-gray-500">{t("detail.section.spoolTracker")}</h2>
              {hasSpools && (
                <span className="text-xs text-gray-400">
                  {t("detail.spoolCount", { count: filament.spools.length })}
                  {aggregatePct != null && ` · ${Math.round(aggregateRemaining)}g ${t("detail.total")} (${aggregatePct}%)`}
                </span>
              )}
            </div>

            {/* Filament-level info cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {filament.netFilamentWeight != null && (
                <InfoCard label={t("detail.field.netFilament")} value={`${filament.netFilamentWeight}g`} inherited={inherited.has("netFilamentWeight")} />
              )}
              {filament.spoolWeight != null && (
                <InfoCard label={t("detail.field.spoolWeight")} value={`${filament.spoolWeight}g`} inherited={inherited.has("spoolWeight")} />
              )}
              {/* Legacy single-spool remaining */}
              {!hasSpools && legacyRemaining && (
                <InfoCard label={t("detail.field.remaining")} value={`${Math.round(legacyRemaining.remainingWeight)}g${legacyRemaining.pct != null ? ` (${legacyRemaining.pct}%)` : ""}`} />
              )}
              {!hasSpools && legacyRemaining?.lengthMeters != null && (
                <InfoCard label={t("detail.field.lengthLeft")} value={`${legacyRemaining.lengthMeters.toFixed(1)}m`} />
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
                  ref={weightRef}
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
                      // handleNfcWeightUpdate reads a timeout ref internally, but
                      // this arrow is an onClick handler so the ref is accessed
                      // post-render — outside the render path the rule checks.
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
                    onNfcWeightUpdate={(scaleWeight) => handleNfcWeightUpdate(scaleWeight)}
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
                      onClick={async () => {
                        if (addSpoolSubmitting) return;
                        const weight = addSpoolForm.totalWeight
                          ? Number(addSpoolForm.totalWeight)
                          : null;
                        setAddSpoolSubmitting(true);
                        try {
                          await handleAddSpool(addSpoolForm.label.trim(), weight);
                          setAddSpoolForm({ open: false, label: "", totalWeight: "" });
                        } finally {
                          setAddSpoolSubmitting(false);
                        }
                      }}
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

            {/* Add-first-spool fallback. Pre-fix this was gated on
                `filament.spoolWeight != null` so the button only appeared
                after the user had configured an empty-spool weight on the
                filament. For freshly-created filaments with no weight
                metadata, the section above this block also rendered
                nothing — leaving the user with no in-app way to add their
                first spool. Drop the spoolWeight gate so the CTA appears
                whenever there are no spools and no legacy
                totalWeight-based tracking in progress.
                When NO weights are configured at all, also surface a
                short hint above the button — otherwise the empty section
                looks broken rather than awaiting input. */}
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
                    onClick={async () => {
                      if (addSpoolSubmitting) return;
                      const weight = addSpoolForm.totalWeight
                        ? Number(addSpoolForm.totalWeight)
                        : null;
                      setAddSpoolSubmitting(true);
                      try {
                        await handleAddSpool(addSpoolForm.label.trim(), weight);
                        setAddSpoolForm({ open: false, label: "", totalWeight: "" });
                      } finally {
                        setAddSpoolSubmitting(false);
                      }
                    }}
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

      {filament.compatibleNozzles && filament.compatibleNozzles.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-gray-500 mb-2">
            {filament.calibrations?.length > 0
              ? t("detail.section.nozzleCalibrations")
              : t("detail.section.compatibleNozzles")}
            {inherited.has("compatibleNozzles") && (
              <span className="ml-1 text-xs text-blue-500">({t("detail.inherited")})</span>
            )}
          </h2>
          {filament.calibrations?.length > 0 ? (
            <div className="overflow-x-auto space-y-4">
              {(() => {
                // Group calibrations by printer
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
                          // Extended calibration fields added in bed-types feature
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
                              {cal.maxVolumetricSpeed ? `${cal.maxVolumetricSpeed}` : "\u2014"}
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

      {filament.settings && Object.keys(filament.settings).length > 0 && (<div>
        <button
          onClick={() => setShowAllSettings(!showAllSettings)}
          className="text-sm text-blue-600 hover:underline mb-3"
        >
          {showAllSettings ? t("detail.settings.hide") : t("detail.settings.show")} ({t("detail.settings.keyCount", { count: Object.keys(filament.settings).length })})
        </button>

        {showAllSettings && (
          <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <tbody>
                {Object.entries(filament.settings)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, value]) => (
                    <tr key={key} className="border-b border-gray-200 dark:border-gray-800">
                      <td className="py-1 pr-4 text-gray-500 whitespace-nowrap">{key}</td>
                      {/* `settings` is a Mixed bag — coerce any non-scalar
                          value to JSON so a structured entry can never crash
                          the render as a raw React child (Codex P2 #612). */}
                      <td className="py-1 break-all">
                        {value == null ? (
                          <span className="text-gray-400">nil</span>
                        ) : typeof value === "object" ? (
                          JSON.stringify(value)
                        ) : (
                          value
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>)}

      {showPrusamentImport && (
        <PrusamentImportDialog
          onClose={() => setShowPrusamentImport(false)}
          targetFilamentId={filament?._id}
          onImported={(message) => {
            toast(message, "success");
            // Refresh filament data. GH #640: the previous inline chain
            // had no `r.ok` gate, so a non-2xx response wrote the error
            // JSON into `filament` state and the next render crashed
            // dereferencing filament.temperatures.nozzle. refetchFilament
            // gates on ok and swallows network errors.
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
          // GH #595: pass spools so the URL-mode QR can deep-link to one.
          spools: (filament.spools ?? []).map((s) => ({
            _id: String(s._id),
            label: s.label ?? null,
          })),
        }}
      />
      {resyncOpen && (
        <OptResyncDialog
          filamentId={String(filament._id)}
          onApplied={refetchFilament}
          onClose={() => setResyncOpen(false)}
        />
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
    // GH #601: provenance fields. The list-summary projection drops these
    // (they're on the full filament fetch the detail page uses), so they
    // come in as ISO strings from the JSON serializer. May be undefined
    // if the spool subdoc predates the field.
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
  onLogUsage: (entry: { grams: number; jobLabel?: string }) => void;
  /**
   * GH #601: provenance fields (lotNumber, purchaseDate, openedDate). All
   * three already round-trip through the spool subdoc schema, the
   * validator, the REST PUT handler, and the CSV import/export, but the
   * UI never exposed them. One callback for the group so the user can
   * save a partial patch (e.g. set the purchase date without touching
   * the lot field).
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
  highlight,
}: SpoolCardProps) {
  const { t, locale } = useTranslation();
  const [weightInput, setWeightInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState(spool.label);
  const [showMore, setShowMore] = useState(false);
  const [dryTemp, setDryTemp] = useState("");
  const [dryDuration, setDryDuration] = useState("");
  const [usageGrams, setUsageGrams] = useState("");
  const [usageLabel, setUsageLabel] = useState("");
  // GH #601: provenance edits. ISO-string fields are sliced to YYYY-MM-DD
  // for the native <input type="date">; null/undefined collapse to "".
  // Reseeded from props in the patch handler below so a sibling-spool
  // update doesn't reset half-typed text the way it would for label
  // (GH #263 has the parallel pattern).
  const isoToDateInput = (v?: string | null) =>
    v ? new Date(v).toISOString().slice(0, 10) : "";
  const [lotInput, setLotInput] = useState(spool.lotNumber ?? "");
  const [purchaseInput, setPurchaseInput] = useState(isoToDateInput(spool.purchaseDate));
  const [openedInput, setOpenedInput] = useState(isoToDateInput(spool.openedDate));
  const [savingMeta, setSavingMeta] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const remaining = computeRemaining(filament, spool.totalWeight);

  // GH #242 — the spool's current AMS slot, derived from the printers
  // list (the reverse of Printer.amsSlots[].spoolId).
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

  // #575.3: the weight field is the GROSS on-scale weight (spool + filament),
  // so a value below the empty-spool weight clamps Remaining to 0. Surface a
  // warning so an obvious typo (e.g. entering 100 g when the empty spool is
  // 250 g) isn't silently swallowed.
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
              // GH #263: re-seed labelInput from the current prop when
              // the editor opens. `labelInput` is useState-initialised
              // from `spool.label` only once; SpoolCard is keyed by a
              // stable `spool._id`, so after any sibling spool mutation
              // the parent re-renders this card with a fresh `spool`
              // prop WITHOUT remounting — leaving `labelInput` stale.
              // Editing then would write or show the old value.
              onClick={() => { setLabelInput(spool.label); setEditingLabel(true); }}
              className="text-sm font-medium hover:text-blue-600 transition-colors"
              title={t("detail.spool.clickToRename")}
            >
              {spool.label || t("detail.spool.unnamed")}
            </button>
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
          <span>{Math.round(remaining.remainingWeight)}g {t("detail.spool.remaining")}{remaining.pct != null ? ` (${remaining.pct}%)` : ""}</span>
        )}
        {remaining?.lengthMeters != null && (
          <span>{remaining.lengthMeters.toFixed(1)}m {t("detail.spool.left")}</span>
        )}
        {!remaining && spool.totalWeight != null && (
          <span>{spool.totalWeight}g {t("detail.spool.onScale")}</span>
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
          className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-transparent"
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
          from its Location (home). GH #242. */}
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
            className="px-2 py-0.5 border border-gray-300 dark:border-gray-600 rounded bg-transparent disabled:opacity-50"
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

          {/* GH #601: provenance — purchase + opened dates + lot/batch */}
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
            {spool.dryCycles && spool.dryCycles.length > 0 && (
              <p className="text-xs text-gray-400 mt-1">
                {t("detail.spool.lastDried", {
                  date: formatDate(spool.dryCycles[spool.dryCycles.length - 1].date, locale),
                })}
              </p>
            )}
          </div>

          {/* Log usage */}
          <div>
            <p className="text-xs text-gray-500 mb-1">
              {t("detail.spool.usageHistory", { count: spool.usageHistory?.length ?? 0 })}
            </p>
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
                // Disable until grams is a positive number. The earlier
                // version validated inside onClick but kept the button
                // active blue, so a user who logged 25g once could come
                // back, see (apparently) cleared inputs, click again,
                // and not know whether their click did nothing or
                // re-posted the previous value.
                disabled={!(Number(usageGrams) > 0)}
                onClick={() => {
                  const g = Number(usageGrams);
                  if (!Number.isFinite(g) || g <= 0) return;
                  onLogUsage({ grams: g, jobLabel: usageLabel });
                  setUsageGrams("");
                  setUsageLabel("");
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

function InfoCard({ label, value, inherited = false }: { label: string; value: string; inherited?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`rounded p-3 ${inherited ? "bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800" : "bg-gray-50 dark:bg-gray-900"}`}>
      <p className="text-xs text-gray-500 mb-1">
        {label}
        {inherited && <span className="ml-1 text-blue-500">({t("detail.inherited")})</span>}
      </p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
