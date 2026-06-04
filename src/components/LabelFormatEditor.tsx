"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/TranslationProvider";
import { useLabelFormat } from "@/hooks/useLabelFormat";
import { renderLabelPreviewDataUrl } from "@/lib/labelBitmap";
import {
  LABEL_PRESETS,
  SAMPLE_FILAMENT,
  normalizeLabelFormat,
  type LabelFieldId,
  type LabelFormat,
} from "@/lib/labelFormat";

/**
 * Editor for the global label layout (GH #592) — font, size, QR placement /
 * off, which text fields, text orientation, and invert — with a live preview
 * rendered against a built-in SAMPLE_FILAMENT (so it works with no real
 * filament in context). Persists through `useLabelFormat` (electron-store on
 * desktop, localStorage on web). Rendered from LabelPrinterSettings.
 */

// A short instance-id-shaped payload so the preview QR renders realistically.
const SAMPLE_QR_PAYLOAD = "2acc21072a";

// Simple per-line fields the checkboxes manage (canonical order). The
// "vendorType" combined line is only reachable via the preset dropdown.
const SIMPLE_FIELDS: LabelFieldId[] = ["name", "vendor", "type", "colorName"];

/** Expand a lines list to the set of simple fields it covers (vendorType → vendor+type). */
function simpleFieldSet(lines: LabelFieldId[]): Set<LabelFieldId> {
  const s = new Set<LabelFieldId>();
  for (const l of lines) {
    if (l === "vendorType") {
      s.add("vendor");
      s.add("type");
    } else {
      s.add(l);
    }
  }
  return s;
}

function activePresetKey(lines: LabelFieldId[]): string {
  for (const [key, { patch }] of Object.entries(LABEL_PRESETS)) {
    if (JSON.stringify(patch.lines) === JSON.stringify(lines)) return key;
  }
  return "custom";
}

export default function LabelFormatEditor() {
  const { t } = useTranslation();
  const { format, setFormat } = useLabelFormat();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Re-render the preview whenever the format changes.
  useEffect(() => {
    let cancelled = false;
    renderLabelPreviewDataUrl({ filament: SAMPLE_FILAMENT, qrPayload: SAMPLE_QR_PAYLOAD, format })
      .then(({ dataUrl }) => {
        if (!cancelled) {
          setPreviewUrl(dataUrl);
          setPreviewError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [format]);

  const update = (patch: Partial<LabelFormat>) => setFormat(normalizeLabelFormat({ ...format, ...patch }));

  const fieldSet = useMemo(() => simpleFieldSet(format.lines), [format.lines]);
  const preset = useMemo(() => activePresetKey(format.lines), [format.lines]);

  const toggleField = (field: LabelFieldId) => {
    const next = new Set(fieldSet);
    if (next.has(field)) next.delete(field);
    else next.add(field);
    const lines = SIMPLE_FIELDS.filter((f) => next.has(f));
    update({ lines: lines.length > 0 ? lines : ["name"] });
  };

  // QR control collapses enabled + placement into one select (Left/Right/Off).
  const qrValue = !format.qr.enabled ? "off" : format.qr.placement;
  const setQr = (v: string) =>
    update(
      v === "off"
        ? { qr: { ...format.qr, enabled: false } }
        : { qr: { enabled: true, placement: v as "left" | "right" } },
    );

  const selectCls =
    "px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelCls = "text-xs font-medium text-gray-600 dark:text-gray-400";

  return (
    <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t("settings.labelFormat")}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t("settings.labelFormat.desc")}</p>

      {/* Live preview against the sample filament. */}
      <div className="mb-4 p-3 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center min-h-[72px]">
        {previewError ? (
          <p className="text-xs text-red-600 dark:text-red-400">{previewError}</p>
        ) : previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={t("settings.labelFormat.previewAlt")}
            className="max-w-full h-auto"
            style={{ imageRendering: "pixelated", maxHeight: 128 }}
          />
        ) : (
          <p className="text-xs text-gray-400">{t("settings.labelFormat.previewLoading")}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Preset */}
        <div className="col-span-2">
          <label className={labelCls} htmlFor="lf-preset">{t("settings.labelFormat.preset")}</label>
          <select
            id="lf-preset"
            className={`${selectCls} w-full mt-1`}
            value={preset}
            onChange={(e) => {
              const p = LABEL_PRESETS[e.target.value];
              if (p) update(p.patch);
            }}
          >
            {Object.entries(LABEL_PRESETS).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
            {preset === "custom" && <option value="custom">{t("settings.labelFormat.preset.custom")}</option>}
          </select>
        </div>

        {/* Fields */}
        <fieldset className="col-span-2">
          <legend className={labelCls}>{t("settings.labelFormat.fields")}</legend>
          <div className="flex flex-wrap gap-3 mt-1">
            {SIMPLE_FIELDS.map((f) => (
              <label key={f} className="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={fieldSet.has(f)} onChange={() => toggleField(f)} />
                {t(`settings.labelFormat.field.${f}`)}
              </label>
            ))}
          </div>
        </fieldset>

        {/* QR */}
        <div>
          <label className={labelCls} htmlFor="lf-qr">{t("settings.labelFormat.qr")}</label>
          <select id="lf-qr" className={`${selectCls} w-full mt-1`} value={qrValue} onChange={(e) => setQr(e.target.value)}>
            <option value="left">{t("settings.labelFormat.qr.left")}</option>
            <option value="right">{t("settings.labelFormat.qr.right")}</option>
            <option value="off">{t("settings.labelFormat.qr.off")}</option>
          </select>
        </div>

        {/* Orientation */}
        <div>
          <label className={labelCls} htmlFor="lf-orient">{t("settings.labelFormat.orientation")}</label>
          <select
            id="lf-orient"
            className={`${selectCls} w-full mt-1`}
            value={format.orientation}
            onChange={(e) => update({ orientation: e.target.value as LabelFormat["orientation"] })}
          >
            <option value="horizontal">{t("settings.labelFormat.orientation.horizontal")}</option>
            <option value="vertical">{t("settings.labelFormat.orientation.vertical")}</option>
          </select>
        </div>

        {/* Font family */}
        <div>
          <label className={labelCls} htmlFor="lf-font">{t("settings.labelFormat.font")}</label>
          <select
            id="lf-font"
            className={`${selectCls} w-full mt-1`}
            value={format.font.family}
            onChange={(e) => update({ font: { ...format.font, family: e.target.value as LabelFormat["font"]["family"] } })}
          >
            <option value="sans">{t("settings.labelFormat.font.sans")}</option>
            <option value="serif">{t("settings.labelFormat.font.serif")}</option>
            <option value="mono">{t("settings.labelFormat.font.mono")}</option>
            <option value="condensed">{t("settings.labelFormat.font.condensed")}</option>
          </select>
        </div>

        {/* Font size */}
        <div>
          <label className={labelCls} htmlFor="lf-size">{t("settings.labelFormat.size")}</label>
          <select
            id="lf-size"
            className={`${selectCls} w-full mt-1`}
            value={format.font.size}
            onChange={(e) => update({ font: { ...format.font, size: e.target.value as LabelFormat["font"]["size"] } })}
          >
            <option value="s">{t("settings.labelFormat.size.s")}</option>
            <option value="m">{t("settings.labelFormat.size.m")}</option>
            <option value="l">{t("settings.labelFormat.size.l")}</option>
          </select>
        </div>

        {/* Invert */}
        <div className="col-span-2">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={format.invert} onChange={(e) => update({ invert: e.target.checked })} />
            {t("settings.labelFormat.invert")}
          </label>
        </div>
      </div>
    </div>
  );
}
