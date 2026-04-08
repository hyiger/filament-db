import { useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import { nfcService } from "../../services/nfc";
import type { DecodedOpenPrintTag } from "../../services/nfc";

export default function NfcReadScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [tagData, setTagData] = useState<DecodedOpenPrintTag | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setError(null);
    setTagData(null);
    setScanning(true);

    try {
      const supported = await nfcService.isSupported();
      if (!supported) {
        setError(t("nfc.notSupported"));
        return;
      }
      const data = await nfcService.readTag();
      setTagData(data);
    } catch (err) {
      if (err instanceof Error && err.message.includes("cancelled")) {
        // User cancelled — not an error
      } else {
        setError(err instanceof Error ? err.message : t("nfc.readFailed"));
      }
    } finally {
      setScanning(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Scan button */}
      <View style={styles.scanSection}>
        <TouchableOpacity
          style={[styles.scanButton, { backgroundColor: scanning ? colors.textSecondary : colors.primary }]}
          onPress={handleScan}
          disabled={scanning}
        >
          {scanning ? (
            <>
              <ActivityIndicator color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.scanText}>{t("nfc.scanning")}</Text>
            </>
          ) : (
            <Text style={styles.scanText}>{t("nfc.scanTag")}</Text>
          )}
        </TouchableOpacity>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {t("nfc.holdPhoneNearTag")}
        </Text>
      </View>

      {/* Error */}
      {error && (
        <View style={[styles.errorBox, { backgroundColor: colors.danger + "15" }]}>
          <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
        </View>
      )}

      {/* Tag Data */}
      {tagData && (
        <View style={[styles.dataSection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.dataTitle, { color: colors.text }]}>
            {tagData.brandName ?? "Unknown"} — {tagData.materialName ?? "Unknown"}
          </Text>

          {tagData.materialType && (
            <Field label={t("nfc.materialType")} value={tagData.materialType} colors={colors} />
          )}
          {tagData.color && (
            <View style={styles.colorRow}>
              <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{t("nfc.color")}</Text>
              <View style={[styles.colorPreview, { backgroundColor: tagData.color }]} />
              <Text style={[styles.fieldValue, { color: colors.text }]}>{tagData.color}</Text>
            </View>
          )}
          {tagData.density != null && (
            <Field label={t("nfc.density")} value={`${tagData.density} g/cm³`} colors={colors} />
          )}
          {tagData.diameter != null && (
            <Field label={t("nfc.diameter")} value={`${tagData.diameter} mm`} colors={colors} />
          )}
          {tagData.nozzleTemp != null && (
            <Field label={t("nfc.nozzleTemp")} value={`${tagData.nozzleTemp}°C`} colors={colors} />
          )}
          {tagData.bedTemp != null && (
            <Field label={t("nfc.bedTemp")} value={`${tagData.bedTemp}°C`} colors={colors} />
          )}
          {tagData.weightGrams != null && (
            <Field label={t("nfc.weight")} value={`${tagData.weightGrams}g`} colors={colors} />
          )}
          {tagData.actualWeightGrams != null && (
            <Field label={t("nfc.actualWeight")} value={`${tagData.actualWeightGrams}g`} colors={colors} />
          )}
          {tagData.dryingTemperature != null && (
            <Field label={t("nfc.dryingTemp")} value={`${tagData.dryingTemperature}°C`} colors={colors} />
          )}
          {tagData.dryingTime != null && (
            <Field label={t("nfc.dryingTime")} value={`${tagData.dryingTime} min`} colors={colors} />
          )}
          {tagData.tagNames && tagData.tagNames.length > 0 && (
            <Field label={t("nfc.tags")} value={tagData.tagNames.join(", ")} colors={colors} />
          )}

          {/* Match button */}
          <TouchableOpacity
            style={[styles.matchButton, { backgroundColor: colors.primary }]}
            onPress={() => {
              // Navigate to filaments list with search pre-filled
              router.push(`/(tabs)?search=${encodeURIComponent(tagData.materialName ?? "")}` as never);
            }}
          >
            <Text style={styles.matchText}>{t("nfc.findMatch")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function Field({ label, value, colors }: { label: string; value: string; colors: Record<string, string> }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  scanSection: { alignItems: "center", paddingVertical: 32 },
  scanButton: {
    flexDirection: "row",
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  scanText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  hint: { marginTop: 12, fontSize: 14 },
  errorBox: { padding: 16, borderRadius: 8, marginBottom: 16 },
  errorText: { fontSize: 14 },
  dataSection: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    padding: 16,
  },
  dataTitle: { fontSize: 18, fontWeight: "700", marginBottom: 12 },
  field: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  fieldLabel: { fontSize: 14 },
  fieldValue: { fontSize: 14, fontWeight: "500" },
  colorRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    gap: 8,
  },
  colorPreview: { width: 20, height: 20, borderRadius: 4 },
  matchButton: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  matchText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
