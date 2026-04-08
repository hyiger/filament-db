import { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import type { FilamentDetail } from "@filament-db/shared/types/filament";
import { atlasService } from "../../services/atlas";
import { nfcService } from "../../services/nfc";
import type { OpenPrintTagInput } from "../../services/nfc";

export default function NfcWriteScreen() {
  const { filamentId } = useLocalSearchParams<{ filamentId?: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [filament, setFilament] = useState<FilamentDetail | null>(null);
  const [writing, setWriting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (filamentId) {
      atlasService.filaments.get(filamentId).then(setFilament).catch(console.error);
    }
  }, [filamentId]);

  const handleWrite = async () => {
    if (!filament) return;

    setError(null);
    setSuccess(false);
    setWriting(true);
    setProgress(0);

    try {
      const supported = await nfcService.isSupported();
      if (!supported) {
        setError(t("nfc.notSupported"));
        return;
      }

      // Build OpenPrintTag input from filament data
      const input: OpenPrintTagInput = {
        materialName: filament.name,
        brandName: filament.vendor,
        materialType: filament.type,
        color: filament.color,
        density: filament.density,
        diameter: filament.diameter,
        nozzleTemp: filament.temperatures?.nozzle,
        nozzleTempFirstLayer: filament.temperatures?.nozzleFirstLayer,
        bedTemp: filament.temperatures?.bed,
        bedTempFirstLayer: filament.temperatures?.bedFirstLayer,
        weightGrams: filament.netFilamentWeight,
        emptySpoolWeight: filament.spoolWeight,
        dryingTemperature: filament.dryingTemperature,
        dryingTime: filament.dryingTime,
        transmissionDistance: filament.transmissionDistance,
        shoreHardnessA: filament.shoreHardnessA,
        shoreHardnessD: filament.shoreHardnessD,
        optTags: filament.optTags,
        spoolUid: filament.instanceId,
      };

      await nfcService.writeTag(input, undefined, setProgress);
      setSuccess(true);
    } catch (err) {
      if (err instanceof Error && err.message.includes("cancelled")) {
        // User cancelled
      } else {
        setError(err instanceof Error ? err.message : t("nfc.writeFailed"));
      }
    } finally {
      setWriting(false);
    }
  };

  if (!filament) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.textSecondary }}>
          {filamentId ? t("common.loading") : t("nfc.selectFilament")}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Filament preview */}
      <View style={[styles.preview, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={[styles.colorDot, { backgroundColor: filament.color || "#808080" }]} />
        <View style={styles.previewText}>
          <Text style={[styles.previewName, { color: colors.text }]}>{filament.name}</Text>
          <Text style={[styles.previewSub, { color: colors.textSecondary }]}>
            {filament.vendor} · {filament.type}
          </Text>
        </View>
      </View>

      {/* Write button */}
      <View style={styles.writeSection}>
        {success ? (
          <View style={[styles.successBox, { backgroundColor: colors.success + "20" }]}>
            <Text style={[styles.successText, { color: colors.success }]}>
              {t("nfc.writeSuccess")}
            </Text>
          </View>
        ) : error ? (
          <View style={[styles.errorBox, { backgroundColor: colors.danger + "15" }]}>
            <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : null}

        <TouchableOpacity
          style={[styles.writeButton, { backgroundColor: writing ? colors.textSecondary : colors.primary }]}
          onPress={handleWrite}
          disabled={writing}
        >
          {writing ? (
            <>
              <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.writeText}>{t("nfc.writing")} ({progress}%)</Text>
            </>
          ) : (
            <Text style={styles.writeText}>{t("nfc.writeTag")}</Text>
          )}
        </TouchableOpacity>

        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {t("nfc.holdPhoneNearTag")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  preview: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 24,
  },
  colorDot: { width: 40, height: 40, borderRadius: 20, marginRight: 14 },
  previewText: { flex: 1 },
  previewName: { fontSize: 18, fontWeight: "600" },
  previewSub: { fontSize: 14, marginTop: 2 },
  writeSection: { alignItems: "center", paddingTop: 24 },
  writeButton: {
    flexDirection: "row",
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  writeText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  hint: { marginTop: 12, fontSize: 14 },
  successBox: { padding: 16, borderRadius: 8, marginBottom: 16, width: "100%" },
  successText: { fontSize: 15, fontWeight: "600", textAlign: "center" },
  errorBox: { padding: 16, borderRadius: 8, marginBottom: 16, width: "100%" },
  errorText: { fontSize: 14, textAlign: "center" },
});
