"use client";

import dynamic from "next/dynamic";
import CollapsibleSection from "@/components/CollapsibleSection";
import { useTranslation } from "@/i18n/TranslationProvider";
import { resolveReferenceChapter } from "@/lib/referenceChapter";
import { REFERENCE_CHAPTER_IDS } from "@/content/referenceIndex";

/** Lazy loading line — a real component so it can use the i18n hook. */
function LoadingLine() {
  const { t } = useTranslation();
  return <p className="text-sm text-gray-500 dark:text-gray-400 py-2">{t("detail.techRef.loading")}</p>;
}

// ssr:false keeps react-markdown + the ~300 KB content map out of the detail
// page's main/SSR bundle; CollapsibleSection only renders this body when the
// panel is opened, so the chunk loads on first expand.
const ReferenceChapterBody = dynamic(() => import("@/components/ReferenceChapterBody"), {
  ssr: false,
  loading: LoadingLine,
});

/**
 * GH #614 — "Technical reference" disclosure on the filament detail page,
 * keyed off the filament's `type`. Renders the matching chapter of the FDM
 * Polymers Technical Reference (bundled from the wiki). Self-hides when the
 * type maps to no chapter, or when that chapter isn't in the bundled content
 * (the committed stub before a release fetch populates it).
 */
export default function TechnicalReferencePanel({
  type,
}: {
  type: string | null | undefined;
}) {
  const { t } = useTranslation();
  const chapter = resolveReferenceChapter(type);
  if (!chapter || !REFERENCE_CHAPTER_IDS.has(chapter.id)) return null;

  return (
    <CollapsibleSection
      id="tech-reference"
      title={t("detail.techRef.title")}
      subtitle={t("detail.techRef.subtitle", {
        number: chapter.number,
        title: chapter.title,
      })}
      defaultOpen={false}
    >
      <ReferenceChapterBody chapterId={chapter.id} />
    </CollapsibleSection>
  );
}
