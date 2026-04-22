"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useToast } from "@/components/Toast";
import CopyButton from "@/components/CopyButton";
import { useTranslation } from "@/i18n/TranslationProvider";

interface SharedCatalog {
  slug: string;
  title: string;
  description: string;
  viewCount: number;
  expiresAt: string | null;
  createdAt: string;
}

interface FilamentOption {
  _id: string;
  name: string;
  vendor: string;
  color: string;
}

export default function ShareManagementPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [catalogs, setCatalogs] = useState<SharedCatalog[]>([]);
  const [filaments, setFilaments] = useState<FilamentOption[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const ac = new AbortController();
    Promise.all([
      fetch("/api/share", { signal: ac.signal }).then((r) => (r.ok ? r.json() : [])),
      fetch("/api/filaments", { signal: ac.signal }).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([cats, fils]) => {
        setCatalogs(cats);
        setFilaments(fils);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const refreshCatalogs = async () => {
    const res = await fetch("/api/share");
    if (res.ok) setCatalogs(await res.json());
  };

  const toggleFilament = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePublish = async () => {
    if (!title.trim() || selectedIds.size === 0) return;
    setPublishing(true);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          filamentIds: Array.from(selectedIds),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast(body?.error || t("share.publishError"), "error");
        return;
      }
      const body = await res.json();
      toast(t("share.published"));
      setTitle("");
      setDescription("");
      setSelectedIds(new Set());
      await refreshCatalogs();
      // Copy the link to clipboard for convenience
      const url = `${window.location.origin}/share/${body.slug}`;
      navigator.clipboard?.writeText(url).catch(() => {});
      toast(t("share.linkCopied"));
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async (slug: string) => {
    if (!confirm(t("share.unpublishConfirm"))) return;
    const res = await fetch(`/api/share/${slug}`, { method: "DELETE" });
    if (!res.ok) {
      toast(t("share.unpublishError"), "error");
      return;
    }
    toast(t("share.unpublished"));
    await refreshCatalogs();
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-4">
        <Link href="/" className="text-blue-600 hover:underline text-sm">
          &larr; {t("share.backToFilaments")}
        </Link>
      </div>
      <h1 className="text-3xl font-bold mb-2">{t("share.title")}</h1>
      <p className="text-sm text-gray-500 mb-6">{t("share.subtitle")}</p>

      {/* Publish form */}
      <section className="mb-10 border border-gray-200 dark:border-gray-700 rounded p-4">
        <h2 className="text-lg font-semibold mb-3">{t("share.publishSection")}</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">{t("share.titleLabel")}</label>
            <input
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("share.titlePlaceholder")}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("share.descriptionLabel")}</label>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded text-sm bg-transparent"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("share.descriptionPlaceholder")}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              {t("share.pickFilaments", { count: selectedIds.size })}
            </label>
            <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
              {filaments.map((f) => (
                <label
                  key={f._id}
                  className="flex items-center gap-3 px-2 py-1 border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(f._id)}
                    onChange={() => toggleFilament(f._id)}
                    className="w-4 h-4"
                  />
                  <span
                    className="inline-block w-4 h-4 rounded-full border border-gray-300"
                    style={{ backgroundColor: f.color }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 min-w-0 truncate">{f.name}</span>
                  <span className="text-xs text-gray-500">{f.vendor}</span>
                </label>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishing || !title.trim() || selectedIds.size === 0}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
          >
            {publishing ? t("share.publishing") : t("share.publish")}
          </button>
        </div>
      </section>

      {/* Existing shares */}
      <section>
        <h2 className="text-lg font-semibold mb-3">{t("share.existingShares")}</h2>
        {catalogs.length === 0 ? (
          <p className="text-sm text-gray-500">{t("share.noShares")}</p>
        ) : (
          <ul className="space-y-2">
            {catalogs.map((c) => {
              const url = `${origin}/share/${c.slug}`;
              return (
                <li
                  key={c.slug}
                  className="border border-gray-200 dark:border-gray-700 rounded p-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{c.title}</p>
                    {c.description && (
                      <p className="text-xs text-gray-500 mt-1">{c.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-400">
                      <code className="text-gray-600 dark:text-gray-300">{url}</code>
                      <CopyButton value={url} />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {t("share.viewCount", { count: c.viewCount })} ·{" "}
                      {new Date(c.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleUnpublish(c.slug)}
                    className="text-red-500 hover:text-red-700 text-sm"
                  >
                    {t("share.unpublish")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
