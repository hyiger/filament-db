import { useState, useEffect } from "react";
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTheme } from "../../providers/ThemeProvider";
import { useTranslation } from "../../providers/TranslationProvider";
import type { FilamentDetail } from "@filament-db/shared/types/filament";
import { atlasService } from "../../services/atlas";

function Section({ title, children, colors }: { title: string; children: React.ReactNode; colors: Record<string, string> }) {
  return (
    <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, value, colors }: { label: string; value: string | number | null | undefined; colors: Record<string, string> }) {
  if (value == null || value === "") return null;
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: colors.text }]}>{String(value)}</Text>
    </View>
  );
}

export default function FilamentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [filament, setFilament] = useState<FilamentDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    atlasService.filaments.get(id)
      .then(setFilament)
      .catch((err) => {
        console.error(err);
        Alert.alert("Error", err.message);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.textSecondary }}>{t("common.loading")}</Text>
      </View>
    );
  }

  if (!filament) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.danger }}>{t("filaments.notFound")}</Text>
      </View>
    );
  }

  const temps = filament.temperatures;

  return (
    <>
      <Stack.Screen options={{ title: filament.name }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: filament.color || "#808080" }]}>
          <Text style={styles.headerName}>{filament.name}</Text>
          <Text style={styles.headerSubtitle}>{filament.vendor} · {filament.type}</Text>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.primary }]}
            onPress={() => router.push(`/filaments/${id}/edit` as never)}
          >
            <Text style={styles.actionText}>{t("common.edit")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
            onPress={() => router.push({ pathname: "/nfc/write", params: { filamentId: id } })}
          >
            <Text style={[styles.actionText, { color: colors.text }]}>{t("nfc.writeTag")}</Text>
          </TouchableOpacity>
        </View>

        {/* Temperatures */}
        <Section title={t("filaments.temperatures")} colors={colors}>
          <Field label={t("filaments.nozzleTemp")} value={temps?.nozzle ? `${temps.nozzle}°C` : null} colors={colors} />
          <Field label={t("filaments.nozzleTempFirstLayer")} value={temps?.nozzleFirstLayer ? `${temps.nozzleFirstLayer}°C` : null} colors={colors} />
          <Field label={t("filaments.bedTemp")} value={temps?.bed ? `${temps.bed}°C` : null} colors={colors} />
          <Field label={t("filaments.bedTempFirstLayer")} value={temps?.bedFirstLayer ? `${temps.bedFirstLayer}°C` : null} colors={colors} />
        </Section>

        {/* Physical Properties */}
        <Section title={t("filaments.physicalProperties")} colors={colors}>
          <Field label={t("filaments.density")} value={filament.density ? `${filament.density} g/cm³` : null} colors={colors} />
          <Field label={t("filaments.diameter")} value={`${filament.diameter} mm`} colors={colors} />
          <Field label={t("filaments.cost")} value={filament.cost != null ? `$${filament.cost}` : null} colors={colors} />
          <Field label={t("filaments.maxVolumetricSpeed")} value={filament.maxVolumetricSpeed ? `${filament.maxVolumetricSpeed} mm³/s` : null} colors={colors} />
        </Section>

        {/* Spools */}
        {filament.spools?.length > 0 && (
          <Section title={`${t("filaments.spools")} (${filament.spools.length})`} colors={colors}>
            {filament.spools.map((spool) => (
              <View key={spool._id} style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>{spool.label}</Text>
                <Text style={[styles.fieldValue, { color: colors.text }]}>
                  {spool.totalWeight != null ? `${spool.totalWeight}g` : "—"}
                </Text>
              </View>
            ))}
          </Section>
        )}

        {/* Calibrations */}
        {filament.calibrations?.length > 0 && (
          <Section title={`${t("filaments.calibrations")} (${filament.calibrations.length})`} colors={colors}>
            {filament.calibrations.map((cal, i) => (
              <View key={i} style={[styles.calibration, i > 0 && { borderTopWidth: 1, borderTopColor: colors.border }]}>
                <Text style={[styles.calNozzle, { color: colors.text }]}>
                  {typeof cal.nozzle === "object" && cal.nozzle ? cal.nozzle.name : "—"}
                </Text>
                <Field label="EM" value={cal.extrusionMultiplier} colors={colors} />
                <Field label="PA" value={cal.pressureAdvance} colors={colors} />
                <Field label="MVS" value={cal.maxVolumetricSpeed ? `${cal.maxVolumetricSpeed} mm³/s` : null} colors={colors} />
              </View>
            ))}
          </Section>
        )}

        {/* Variants */}
        {filament._variants && filament._variants.length > 0 && (
          <Section title={`${t("filaments.variants")} (${filament._variants.length})`} colors={colors}>
            {filament._variants.map((v) => (
              <TouchableOpacity
                key={v._id}
                style={styles.field}
                onPress={() => router.push(`/filaments/${v._id}`)}
              >
                <View style={[styles.miniSwatch, { backgroundColor: v.color || "#808080" }]} />
                <Text style={[styles.fieldValue, { color: colors.primary, flex: 1 }]}>{v.name}</Text>
              </TouchableOpacity>
            ))}
          </Section>
        )}

        <View style={{ height: 48 }} />
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: {
    padding: 24,
    paddingTop: 16,
    paddingBottom: 20,
  },
  headerName: { fontSize: 24, fontWeight: "700", color: "#fff" },
  headerSubtitle: { fontSize: 15, color: "rgba(255,255,255,0.85)", marginTop: 4 },
  actions: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  actionText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  section: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  field: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  fieldLabel: { fontSize: 14 },
  fieldValue: { fontSize: 14, fontWeight: "500" },
  calibration: { paddingVertical: 8 },
  calNozzle: { fontSize: 15, fontWeight: "600", paddingHorizontal: 16, paddingBottom: 4 },
  miniSwatch: { width: 20, height: 20, borderRadius: 10, marginRight: 10 },
});
