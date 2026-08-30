"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { createSyncCycleWatcher } from "@/lib/syncCycleWatcher";

/**
 * GH #1149 — Data health: the trim-collision resolution surface.
 *
 * Rows the #1116 name-trim migration refused to repair (a stored `"X "`
 * blocked by an active `"X"`, or a whitespace-only name) were previously
 * reported only on a console the desktop user never sees. This page lists
 * them — rendering names through JSON.stringify so the whitespace is finally
 * VISIBLE — and offers the two safe resolutions:
 *
 *   - Delete, only when nothing depends on the row (it is a plain duplicate
 *     of the row that already won the name). The server-side delete guards
 *     back this gate up — the client check is a courtesy.
 *   - Rename (prefilled with `"X (2)"`), which frees the canonical spelling
 *     without touching a single reference.
 *
 * Both act through the existing id-addressed routes — the blocked row is
 * unreachable by NAME through Mongoose (the GH #1116 mechanism itself), but
 * perfectly reachable by id, and the still-unsettled migration then repairs
 * and settles on its next throttled pass.
 */

interface Dependents {
  total: number;
  breakdown: Record<string, number>;
}

interface Conflict {
  collection: "filaments" | "nozzles" | "printers" | "bedtypes" | "locations";
  name: string;
  id: string;
  trimsTo: string | null;
  reason: "collision" | "empty-name";
  collidesWith: { id: string; name: string } | null;
  dependents: Dependents;
}

/**
 * A filament whose abrasiveness and nozzle assignments disagree — either it
 * can reach a nozzle that fibre fill would destroy, or its exported
 * `filament_abrasive` flag tells the slicer and the printer firmware it is
 * safe when the material says otherwise.
 */
interface AbrasiveFinding {
  filamentId: string;
  filamentName: string;
  filamentType: string | null;
  reasons: Array<"flagged" | "tagged" | "fibre" | "filled">;
  softNozzles: { id: string; name: string }[];
  unassigned: boolean;
  flagMismatch: boolean;
  /** Template name when the nozzle set is inherited — where the fix belongs. */
  inheritedFrom: string | null;
}

/** The id-addressed routes the resolutions act through. */
const ROUTE_BY_COLLECTION: Record<Conflict["collection"], string> = {
  filaments: "/api/filaments",
  nozzles: "/api/nozzles",
  printers: "/api/printers",
  bedtypes: "/api/bed-types",
  locations: "/api/locations",
};

export default function DataHealthPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  // GH #1164: conflicts the desktop sync service saw, side-tagged. The scan
  // above only covers the database THIS server talks to (the local one in
  // hybrid mode), so a remote-only conflict has no other surface anywhere.
  const [syncConflicts, setSyncConflicts] = useState<
    Array<{
      collection: string;
      name: string;
      trimsTo: string | null;
      collidesWith: { id: string; name: string } | null;
      side: "local" | "remote";
    }>
  >([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Scanned independently of the trim conflicts: a slower or failing abrasive
  // scan must not withhold the conflict list, and vice versa.
  const [abrasive, setAbrasive] = useState<AbrasiveFinding[]>([]);
  const [abrasiveLoading, setAbrasiveLoading] = useState(true);
  // Tracked separately from `error`, whose message names the name-conflict
  // scan. A shared flag would tell the user the wrong check broke.
  const [abrasiveError, setAbrasiveError] = useState(false);

  // Every scan of /api/name-conflicts takes a ticket, and only the newest
  // ticket may write. The mount scan and a completion-triggered
  // refetch are independent requests with no ordering: mounting while a sync
  // finishes, the mount request can capture the PRE-copy database and resolve
  // LAST, overwriting the post-copy list — the newly copied conflict then
  // stays missing until another sync or a reload.
  const scanSeq = useRef(0);

  // Refetch helper for the ACTION handlers (event handlers, not effects —
  // the react-hooks/set-state-in-effect rule does not apply there).
  const load = useCallback(async () => {
    const seq = ++scanSeq.current;
    try {
      const res = await fetch("/api/name-conflicts");
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { conflicts: Conflict[] };
      if (seq !== scanSeq.current) return;
      setConflicts(body.conflicts);
      setError(false);
    } catch {
      if (seq === scanSeq.current) setError(true);
    } finally {
      if (seq === scanSeq.current) setLoading(false);
    }
  }, []);

  // The mount fetch is an inline IIFE with a cancelled flag — the repo's
  // set-state-in-effect rule traces INTO a named callback invoked from an
  // effect body and flags its setStates, but accepts this exact shape (the
  // pattern OptResyncDialog established; the CI lint proved the difference).
  useEffect(() => {
    let cancelled = false;
    const seq = ++scanSeq.current;
    const current = () => !cancelled && seq === scanSeq.current;
    (async () => {
      try {
        const res = await fetch("/api/name-conflicts");
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { conflicts: Conflict[] };
        if (!current()) return;
        setConflicts(body.conflicts);
        setError(false);
      } catch {
        if (current()) setError(true);
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The abrasive/nozzle audit. Same IIFE shape as the scan above for the
  // set-state-in-effect rule. Advisory and read-only, so a failure degrades to
  // "nothing to report" rather than an error banner over the conflict list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/abrasive-nozzles");
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { findings: AbrasiveFinding[] };
        if (!cancelled) setAbrasive(body.findings);
      } catch {
        // "Advisory" describes the FINDINGS, not the scan. Swallowing the
        // failure left the list empty and the loading flag cleared, which the
        // all-clear below reads as "checked, nothing found" — a green
        // "your data looks healthy" for a check that never ran. This page has
        // made that mistake once already (GH #1164, the remote conflicts).
        if (!cancelled) setAbrasiveError(true);
      } finally {
        if (!cancelled) setAbrasiveLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // GH #1164, desktop only: the sync service's view of BOTH databases.
  // Same IIFE shape as above for the set-state-in-effect rule.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getSyncStatus) return;
    let cancelled = false;
    // A COMPLETED cycle can copy a remote-only conflict INTO the local
    // database — after which the pair belongs in the actionable
    // list above, not the read-only remote section whose copy says "resolve
    // it above". The local scan is a mount-time snapshot, so refetch it
    // whenever a cycle finishes. `lastSyncAt` changing is exactly that
    // signal; progress ticks during a cycle carry the same value and are
    // ignored, so this cannot loop.
    // The "did a cycle end?" rule lives in a pure, unit-tested module
    //: this page has no test harness, and that rule has been
    // wrong three separate ways, each time leaving the actionable list
    // silently stale.
    const watcher = createSyncCycleWatcher();
    type StatusSample = {
      nameConflicts?: typeof syncConflicts;
      lastSyncAt?: string | null;
      state?: string;
    };
    // The rendered list needs the same yield-to-live rule as the watcher's
    // baseline: a live event can beat this promise, and installing
    // the older snapshot's conflicts afterwards would drop a remote-only
    // conflict from the page until some later status arrived.
    let sawLiveStatus = false;
    (async () => {
      try {
        const st = await api.getSyncStatus();
        if (cancelled || sawLiveStatus) return;
        setSyncConflicts((st as StatusSample).nameConflicts ?? []);
        watcher.seed(st);
      } catch {
        /* status unavailable — the local scan above still stands */
      }
    })();
    const unsub = api.onSyncStatusChange?.((st) => {
      if (cancelled) return;
      sawLiveStatus = true;
      setSyncConflicts((st as StatusSample).nameConflicts ?? []);
      if (watcher.observe(st)) void load();
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [load]);

  const handleDelete = useCallback(
    async (c: Conflict) => {
      const ok = await confirm({
        title: t("health.deleteConfirmTitle"),
        message: t(
          c.collection === "filaments"
            ? "health.deleteConfirm.trash"
            : "health.deleteConfirm.permanent",
          { name: JSON.stringify(c.name) },
        ),
        confirmLabel: t("health.action.delete"),
        destructive: true,
      });
      if (!ok) return;
      setBusy(true);
      try {
        const res = await fetch(`${ROUTE_BY_COLLECTION[c.collection]}/${c.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          toast(body?.error ?? t("health.actionFailed"), "error");
          return;
        }
        toast(t("health.deleted"), "success");
        await load();
      } catch {
        toast(t("health.actionFailed"), "error");
      } finally {
        setBusy(false);
      }
    },
    [confirm, t, toast, load],
  );

  const handleRename = useCallback(
    async (c: Conflict) => {
      const name = renameValue.trim();
      if (name === "") return;
      setBusy(true);
      try {
        const res = await fetch(`${ROUTE_BY_COLLECTION[c.collection]}/${c.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          toast(body?.error ?? t("health.actionFailed"), "error");
          return;
        }
        toast(t("health.renamed"), "success");
        setRenaming(null);
        await load();
      } catch {
        toast(t("health.actionFailed"), "error");
      } finally {
        setBusy(false);
      }
    },
    [renameValue, t, toast, load],
  );

  // GH #1164: derived ONCE — the all-clear banner and the remote section
  // must agree about what "remote conflicts exist" means.
  const remoteConflicts = syncConflicts.filter((c) => c.side === "remote");

  return (
    <main id="main-content" className="max-w-3xl mx-auto px-4 py-8">
      <Link href="/settings" className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
        ← {t("settings.title")}
      </Link>
      <h1 className="text-3xl font-bold mt-2 mb-2">{t("health.title")}</h1>
      <p className="text-gray-500 text-sm mb-2">{t("health.subtitle")}</p>
      {/* Phase 1 covers the database this server talks to; hybrid-remote
          conflicts are a follow-up (stated so the card never over-claims). */}
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-8">{t("health.hybridNote")}</p>

      {loading && <p className="text-sm text-gray-500">{t("health.loading")}</p>}
      {!loading && error && (
        <p className="text-sm text-red-500">{t("health.error")}</p>
      )}
      {!abrasiveLoading && abrasiveError && (
        <p className="text-sm text-red-500">{t("health.abrasive.error")}</p>
      )}
      {/* GH #1164: the all-clear must account for BOTH databases.
          With a clean local scan and a remote-only conflict — the primary
          case this PR adds — the page otherwise rendered "your data is
          healthy" directly above an amber conflict list. */}
      {!loading && !error && !abrasiveLoading && !abrasiveError && conflicts.length === 0 &&
        remoteConflicts.length === 0 && abrasive.length === 0 && (
        <div className="rounded-lg border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-5">
          <p className="text-sm text-green-700 dark:text-green-400">{t("health.empty")}</p>
        </div>
      )}

      {/* Headed only when it has content: the page carries two independent
          checks now, and an empty "Name conflicts" heading above the abrasive
          list reads as a section that failed to load. */}
      {conflicts.length > 0 && (
        <>
          <h2 className="text-lg font-semibold mb-1">{t("health.conflicts.title")}</h2>
          <p className="text-sm text-gray-500 mb-3">{t("health.conflicts.subtitle")}</p>
        </>
      )}

      <div className="space-y-4">
        {conflicts.map((c) => {
          const deletable = c.dependents.total === 0;
          const depEntries = Object.entries(c.dependents.breakdown).filter(([, n]) => n > 0);
          return (
            <div
              key={`${c.collection}-${c.id}`}
              className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-4"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  {t(`health.col.${c.collection}`)}
                </span>
                {/* JSON.stringify makes the invisible whitespace visible —
                    the entire reason the row reads as a duplicate. */}
                <code className="text-sm font-mono">{JSON.stringify(c.name)}</code>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {c.reason === "empty-name"
                  ? t("health.conflict.emptyName")
                  : t("health.conflict.takenBy", {
                      trimsTo: JSON.stringify(c.trimsTo ?? ""),
                      twin: c.collidesWith ? JSON.stringify(c.collidesWith.name) : "?",
                    })}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {depEntries.length === 0
                  ? t("health.dependents.none")
                  : `${t("health.dependents")}: ${depEntries
                      .map(([k, n]) => `${t(`health.dep.${k}`)}: ${n}`)
                      .join(" · ")}`}
              </p>
              {/* GH #557 caveat: bedTypeTemps references are keyed by NAME,
                  so a rename does NOT follow them — unlike every id-keyed
                  dependent. Say so instead of letting the generic "rename
                  it instead" hint promise reference preservation it can't
                  deliver for this one dependent kind. */}
              {c.collection === "bedtypes" &&
                (c.dependents.breakdown.filamentBedTemps ?? 0) > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    {t("health.bedTempsRenameNote", {
                      count: c.dependents.breakdown.filamentBedTemps,
                    })}
                  </p>
                )}

              <div className="flex items-center gap-2 mt-3">
                {renaming === c.id ? (
                  <>
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !busy && renameValue.trim() !== "") {
                          e.preventDefault();
                          void handleRename(c);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      autoFocus
                      className="px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 flex-1"
                      aria-label={t("health.action.rename")}
                    />
                    <button
                      type="button"
                      onClick={() => handleRename(c)}
                      disabled={busy || renameValue.trim() === ""}
                      className="px-3 py-1 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-700"
                    >
                      {t("health.action.saveRename")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      {t("resync.cancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setRenaming(c.id);
                        // `"X (2)"` frees the canonical spelling; the server's
                        // unique index arbitrates if it is itself taken.
                        setRenameValue(c.trimsTo ? `${c.trimsTo} (2)` : "");
                      }}
                      disabled={busy}
                      className="px-3 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      {t("health.action.rename")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(c)}
                      disabled={busy || !deletable}
                      title={deletable ? undefined : t("health.deleteBlockedHint")}
                      className="px-3 py-1 text-sm rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t("health.action.delete")}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* GH #1164: REMOTE-side conflicts, read-only. Local ones already
          appear above with dependent counts and actions; listing them twice
          would read as two different problems. Resolution differs by shape:
          a pair that also exists locally is fixed above and propagates on
          the next sync; a remote-ONLY row has no local twin to act on. */}
      {remoteConflicts.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold mb-1">{t("health.remote.title")}</h2>
          <p className="text-sm text-gray-500 mb-3">{t("health.remote.subtitle")}</p>
          <div className="space-y-2">
            {remoteConflicts.map((c) => (
                <div
                  key={`${c.collection}-${c.name}`}
                  className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                      {t(`health.col.${c.collection}`)}
                    </span>
                    <code className="text-sm font-mono">{JSON.stringify(c.name)}</code>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {c.collidesWith
                      ? t("health.conflict.takenBy", {
                          trimsTo: JSON.stringify(c.trimsTo ?? ""),
                          twin: JSON.stringify(c.collidesWith.name),
                        })
                      : t("health.conflict.emptyName")}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">{t("health.remote.hint")}</p>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Abrasive filament vs. nozzle assignment. Advisory: abrasiveness is
          inferred (a 4% cosmetic fibre loading and a 20% structural one are
          both "CF"), so this reports and never repairs. Placed last because
          the trim conflicts above are unambiguous defects. */}
      {abrasive.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold mb-1">{t("health.abrasive.title")}</h2>
          <p className="text-sm text-gray-500 mb-3">{t("health.abrasive.subtitle")}</p>
          <div className="space-y-3">
            {abrasive.map((f) => (
              <div
                key={f.filamentId}
                className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-4"
              >
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <Link
                    href={`/filaments/${f.filamentId}`}
                    className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {f.filamentName}
                  </Link>
                  {f.filamentType && (
                    <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                      {f.filamentType}
                    </span>
                  )}
                </div>
                {/* Why it reads as abrasive, so a false positive can be judged
                    rather than taken on faith. */}
                <p className="text-xs text-gray-500 mb-2">
                  {t("health.abrasive.because", {
                    reasons: f.reasons.map((r) => t(`health.abrasive.reason.${r}`)).join(", "),
                  })}
                </p>
                {f.softNozzles.length > 0 && (
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t("health.abrasive.softNozzles", {
                      nozzles: f.softNozzles.map((n) => n.name).join(", "),
                    })}
                  </p>
                )}
                {f.unassigned && (
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t("health.abrasive.unassigned")}
                  </p>
                )}
                {f.flagMismatch && (
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    {t("health.abrasive.flagMismatch")}
                  </p>
                )}
                {/* A variant inheriting its template's nozzles cannot be fixed
                    on its own page — the value comes straight back. */}
                {f.inheritedFrom && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    {t("health.abrasive.inheritedFrom", { template: f.inheritedFrom })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
