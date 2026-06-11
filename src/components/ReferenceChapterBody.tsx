"use client";

import MarkdownView from "@/components/MarkdownView";
import { useTranslation } from "@/i18n/TranslationProvider";
import { REFERENCE_CONTENT, REFERENCE_WIKI_SHA, REFERENCE_SYNCED_AT } from "@/content/referenceContent";

const WIKI_URL = "https://github.com/hyiger/filament-db/wiki/FDM-Polymers-Technical-Reference";

/**
 * GH #614 — the rendered body of the Technical Reference panel. Imported via
 * `next/dynamic({ ssr:false })` by TechnicalReferencePanel, so the heavy
 * `REFERENCE_CONTENT` map (~300 KB) and react-markdown + its plugins live in
 * THIS chunk — loaded only when a reader opens the panel — and never weigh down
 * the detail page's main bundle.
 */
export default function ReferenceChapterBody({ chapterId }: { chapterId: string }) {
  const { t } = useTranslation();
  const markdown = REFERENCE_CONTENT[chapterId];
  if (!markdown) return null;

  return (
    <div className="max-w-none">
      <MarkdownView markdown={markdown} />
      <p className="text-xs text-gray-400 dark:text-gray-500 mt-4 pt-3 border-t border-gray-100 dark:border-gray-800">
        {t("detail.techRef.attribution")}
        {" · "}
        <a
          href={WIKI_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline"
        >
          {t("detail.techRef.viewWiki")}
        </a>
        {REFERENCE_WIKI_SHA
          ? ` · ${t("detail.techRef.synced", { sha: REFERENCE_WIKI_SHA, date: REFERENCE_SYNCED_AT })}`
          : ""}
      </p>
    </div>
  );
}
