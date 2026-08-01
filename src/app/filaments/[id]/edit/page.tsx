"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import FilamentForm from "@/app/filaments/FilamentForm";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import UnsavedChangesDialog from "@/components/UnsavedChangesDialog";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function EditFilament() {
  const params = useParams();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [filament, setFilament] = useState<Record<string, unknown> | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const detailUrl = `/filaments/${params.id}`;
  const {
    onDirtyChange, showUnsavedDialog, handleBack,
    navigate, confirmNav, cancelNav,
  } = useUnsavedChanges(detailUrl);

  useEffect(() => {
    const controller = new AbortController();
    // ?raw=true skips variant inheritance resolution on the server so the
    // form sees only this filament's own overrides. Without it, the form
    // prefill would include parent-inherited values and a Save would
    // persist them as explicit overrides — severing the live parent link
    // (GH #106).
    fetch(`/api/filaments/${params.id}?raw=true`, { signal: controller.signal })
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        if (!r.ok) { setFetchError(true); return null; }
        return r.json();
      })
      .then((data) => { if (data) setFilament(data); })
      .catch((err) => { if (err.name !== "AbortError") setFetchError(true); });
    return () => controller.abort();
  }, [params.id]);

  const handleSubmit = async (data: Record<string, unknown>) => {
    const put = (payload: Record<string, unknown>) =>
      fetch(`/api/filaments/${params.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    let res = await put(data);

    // GH #605 (codex round 4, F2): setting a parent on this filament can make
    // it the FIRST variant of a parent that still carries its own color /
    // spools — the server promotes that parent to a template (moving the
    // state onto a new sibling variant) and 409s until the client opts in.
    // Same catch → confirm → retry-with-flag flow as the create page.
    if (res.status === 409) {
      const conflict = await res.json().catch(() => null);
      if (conflict?.error !== "parent_promotion_required") {
        toast(conflict?.error || t("edit.toast.updateFailed"), "error");
        return;
      }
      const ok = await confirm({
        title: t("edit.promote.title"),
        message: t("edit.promote.message", {
          parent: String(conflict.parentName ?? ""),
          variant: String(conflict.variantName ?? ""),
          count: conflict.spoolCount ?? 0,
        }),
        confirmLabel: t("edit.promote.confirm"),
      });
      if (!ok) return;
      res = await put({ ...data, promoteParent: true });
    }

    if (res.ok) {
      toast(t("edit.toast.updated"));
      navigate(detailUrl);
    } else {
      const body = await res.json().catch(() => null);
      toast(body?.error || t("edit.toast.updateFailed"), "error");
    }
  };

  if (notFound) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("detail.error.notFound")}</p>
      <Link href="/" className="text-blue-600 hover:underline text-sm">&larr; {t("detail.backToFilaments")}</Link>
    </div>
  );
  if (fetchError) return (
    <div className="p-8">
      <p className="text-red-500 mb-4">{t("detail.error.loadFailed")}</p>
      <Link href="/" className="text-blue-600 hover:underline text-sm">&larr; {t("detail.backToFilaments")}</Link>
    </div>
  );
  if (!filament) return <p className="p-8 text-gray-500">{t("common.loading")}</p>;

  return (
    <main id="main-content" className="max-w-2xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href={detailUrl} className="text-blue-600 hover:underline text-sm" onClick={handleBack}>
          &larr; {t("edit.backToDetail")}
        </Link>
      </div>
      <h1 className="text-2xl font-bold mb-6">{t("edit.title")}</h1>
      {/* GH #605: `_variants` rides the raw GET response — ≥1 live variant
          makes this filament a template, which hides the INVENTORY inputs
          (initial weight, low-stock threshold) in the form's Weight Tracking
          section. The spec pair (spool weight / net filament weight) stays
          editable there — variants inherit it (GH #1048). */}
      <FilamentForm
        initialData={filament}
        isParent={Array.isArray(filament._variants) && filament._variants.length > 0}
        onSubmit={handleSubmit}
        onDirtyChange={onDirtyChange}
      />

      {showUnsavedDialog && (
        <UnsavedChangesDialog onCancel={cancelNav} onDiscard={confirmNav} />
      )}
    </main>
  );
}
